import PathspecEvaluator, {
  type Destination, type PhysicalPath, type SelectionContext, type SourceBinding,
} from '../config/PathspecEvaluator.ts'
import {
  childPath, errorCode, nativePath, scanningIO, sourcePath,
  type Inspection, type Metadata, type ScanningIO,
} from './scanning-utils.ts'

export type ScanRecord =
  | { type: 'entry'; id: string; source: PhysicalPath; kind: 'file' | 'directory'; metadata: Metadata }
  | { type: 'root'; id: string; destination: Destination; symbolic?: { target: string; materialised: boolean } }
  | { type: 'link'; parent: string; name: string; id: string; relationship: 'entry' | 'symbolic' | 'hardlink';
      target?: string; materialised?: boolean }
  | { type: 'repository'; id: string; workingTree: PhysicalPath | null; gitDirectory: PhysicalPath;
      commonDirectory: PhysicalPath; bare: boolean; objectFormat: string }
  | { type: 'problem'; source: PhysicalPath | null; operation: string; message: string; code?: string }
  | { type: 'completion'; complete: boolean; cancelled: boolean; problems: number; entries: number; repositories: number }

interface SharedEntry {
  readonly inspection: Inspection
  readonly context: SelectionContext
  phase: 'visiting' | 'done'
}

type Repository = Extract<ScanRecord, { type: 'repository' }>

function problem(source: PhysicalPath | null, operation: string, error: unknown): ScanRecord {
  const code = errorCode(error)
  return {
    type: 'problem', source, operation,
    message: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
  }
}

function pathKey(path: PhysicalPath): string {
  return path.root + path.path
}

export default class Scanner {
  constructor(readonly evaluator: PathspecEvaluator, readonly io: ScanningIO = scanningIO) {}

  scan(options: { signal?: AbortSignal } = {}): AsyncGenerator<ScanRecord, void, unknown> {
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const iterator = this.#run(signal)
    // Returning an iterator must also cancel a query currently awaited by next().
    return {
      next: value => iterator.next(value),
      return: value => {
        controller.abort()
        return iterator.return(value)
      },
      throw: error => {
        controller.abort()
        return iterator.throw(error)
      },
      [Symbol.asyncIterator]() { return this },
    }
  }

  async *#run(signal: AbortSignal): AsyncGenerator<ScanRecord, void, unknown> {
    let problems = 0
    let entries = 0
    let repositories = 0
    const bindings: SourceBinding[] = []
    const shared = new Map<string, SharedEntry>()
    try {
      for (const source of this.evaluator.getSourcePaths()) {
        signal.throwIfAborted()
        try {
          bindings.push({ source, resolved: await this.io.resolveRule(source) })
        } catch (error) {
          signal.throwIfAborted()
          problems++
          yield problem(source, 'resolve selection', error)
          // Retain the unresolved rule for best-effort diagnostics. This run is
          // already incomplete and cannot authorise capture or commit.
          bindings.push({ source, resolved: source })
        }
      }
      const evaluator = this.evaluator.bindSources(bindings)
      const rootPaths = new Set(evaluator.getScanRoots().map(pathKey))
      for (const exposure of evaluator.getExposures()) {
        const source = exposure.origin
        signal.throwIfAborted()
        let inspection: Inspection
        try {
          inspection = await this.io.inspect(source)
          if (pathKey(inspection.source) !== pathKey(exposure.source)) {
            throw new Error('source identity changed after selection was resolved')
          }
          if (await this.#administrativeAncestor(inspection.source, signal)) {
            throw new Error('select the repository root, not an administrative subtree')
          }
          if (inspection.kind === 'file' &&
            [source, inspection.source].some(path => path.path.split('/').at(-1) === '.git')) {
            throw new Error('select the working-tree root, not only its gitfile')
          }
        } catch (error) {
          signal.throwIfAborted()
          problems++
          yield problem(source, 'inspect root', error)
          continue
        }
        yield {
          type: 'root', id: inspection.id, destination: exposure.destination,
          ...(inspection.symbolic ? { symbolic: {
            ...inspection.symbolic,
            materialised: this.evaluator.evaluate(inspection.source).length === 0,
          } } : {}),
        }
        for await (const record of this.#walk(source, evaluator, shared, rootPaths, signal, undefined, inspection)) {
          if (record.type === 'problem') problems++
          if (record.type === 'entry') entries++
          if (record.type === 'repository') repositories++
          yield record
        }
      }
      for (const binding of bindings) {
        signal.throwIfAborted()
        try {
          if (pathKey(await this.io.resolveRule(binding.source)) !== pathKey(binding.resolved)) {
            throw new Error('selection path changed identity during scanning')
          }
        } catch (error) {
          signal.throwIfAborted()
          problems++
          yield problem(binding.source, 'verify selection', error)
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        problems++
        yield problem(null, 'scan', error)
      }
    }
    yield {
      type: 'completion', complete: !signal.aborted && problems === 0,
      cancelled: signal.aborted, problems, entries, repositories,
    }
  }

  async *#walk(
    path: PhysicalPath,
    evaluator: PathspecEvaluator,
    shared: Map<string, SharedEntry>,
    rootPaths: ReadonlySet<string>,
    signal: AbortSignal,
    parent?: { id: string; name: string; context: SelectionContext },
    prepared?: Inspection,
  ): AsyncGenerator<ScanRecord> {
    signal.throwIfAborted()
    let inspected: Inspection
    try {
      inspected = prepared ?? await this.io.inspect(path)
    } catch (error) {
      signal.throwIfAborted()
      yield problem(path, 'inspect', error)
      return
    }
    signal.throwIfAborted()
    const destinations = evaluator.evaluate(inspected.source)
    const independent = destinations.length > 0
    if (!parent && !independent) return
    const context = independent
      ? evaluator.contents(inspected.source)
      : evaluator.contents(inspected.source, parent?.context)
    if (parent && !independent && !evaluator.enter(inspected.source, parent.context).selected) return
    if (inspected.kind === 'file' && inspected.source.path.split('/').at(-1) === '.git') {
      yield problem(path, 'repository selection', new Error('select the working-tree root, not only its gitfile'))
      return
    }
    if (inspected.symbolic) {
      try {
        if (await this.#administrativeAncestor(inspected.source, signal)) {
          throw new Error('link targets a repository administrative subtree')
        }
      } catch (error) {
        signal.throwIfAborted()
        yield problem(path, 'follow link', error)
        return
      }
    }

    if (parent && inspected.kind === 'file' && inspected.symbolic && independent &&
      !rootPaths.has(pathKey(inspected.source))) {
      yield {
        type: 'link', parent: parent.id, name: parent.name, id: inspected.id,
        relationship: 'symbolic', target: inspected.symbolic.target, materialised: false,
      }
      return
    }

    const previous = shared.get(inspected.id)
    if (previous?.phase === 'visiting') {
      yield problem(path, 'follow link', new Error('directory link cycle'))
      return
    }
    if (previous && inspected.kind === 'directory' && !evaluator.equivalentContexts(previous.context, context)) {
      yield problem(path, 'share contents', new Error('linked directory has incompatible selection contexts; exclude one route'))
      return
    }
    if (previous && (previous.inspection.metadata.ctimeNs !== inspected.metadata.ctimeNs ||
      previous.inspection.metadata.size !== inspected.metadata.size)) {
      yield problem(path, 'share contents', new Error('shared source changed during scanning'))
      return
    }

    const entry: SharedEntry = previous ?? { inspection: inspected, context, phase: 'visiting' }
    // Only directories, configured file roots and multiply-linked files need
    // retained identity state. Ordinary file records stream without an index.
    if (inspected.kind === 'directory' || inspected.symbolic || inspected.metadata.links !== '1' ||
      rootPaths.has(pathKey(inspected.source))) {
      shared.set(inspected.id, entry)
    }
    if (!previous) {
      yield { type: 'entry', id: inspected.id, source: inspected.source, kind: inspected.kind, metadata: inspected.metadata }
    }
    if (parent) {
      yield {
        type: 'link', parent: parent.id, name: parent.name, id: inspected.id,
        relationship: inspected.symbolic ? 'symbolic' :
          inspected.kind === 'file' && inspected.metadata.links !== '1' && previous ? 'hardlink' : 'entry',
        ...(inspected.symbolic ? { target: inspected.symbolic.target, materialised: !independent } : {}),
      }
    }
    if (previous || inspected.kind === 'file') {
      entry.phase = 'done'
      return
    }
    try {
      let administrative = false
      try {
        const repository = await this.#repository(inspected, evaluator, context, signal)
        administrative = repository.administrative
        if (repository.record) yield repository.record
        if ('error' in repository) yield problem(path, 'detect repository', repository.error)
      } catch (error) {
        signal.throwIfAborted()
        yield problem(path, 'detect repository', error)
      }
      if (administrative) return
      try {
        for await (const name of this.io.children(inspected.source)) {
          signal.throwIfAborted()
          if (name === '.git') continue
          const child = childPath(inspected.source, name)
          if (!evaluator.enter(child, context).selected) continue
          yield* this.#walk(child, evaluator, shared, rootPaths, signal, { id: inspected.id, name, context })
        }
      } catch (error) {
        signal.throwIfAborted()
        yield problem(inspected.source, 'read directory', error)
      }
    } finally {
      entry.phase = 'done'
    }
  }

  async #repository(
    entry: Inspection, evaluator: PathspecEvaluator, context: SelectionContext, signal: AbortSignal,
  ): Promise<{ administrative: boolean; record?: Repository; error?: unknown }> {
    const marker = childPath(entry.source, '.git')
    let gitPath: PhysicalPath
    let administrative = false
    signal.throwIfAborted()
    if (evaluator.enter(marker, context).selected && await this.io.exists(marker) &&
      evaluator.enter(await this.io.resolveRule(marker), context).selected) {
      gitPath = marker
    } else if (await this.#isStorage(entry.source, signal)) {
      gitPath = entry.source
      administrative = true
    } else {
      return { administrative: false }
    }
    const query = async (args: string[]) => {
      signal.throwIfAborted()
      return this.io.git(args, entry.source, signal)
    }
    try {
      const gitDirectory = sourcePath(await query(['rev-parse', '--path-format=absolute', '--resolve-git-dir', nativePath(gitPath)]))
      const args = [`--git-dir=${nativePath(gitDirectory)}`, 'rev-parse']
      const commonDirectory = sourcePath(await query([...args, '--path-format=absolute', '--git-common-dir']))
      const bare = await query([...args, '--is-bare-repository'])
      const objectFormat = await query([...args, '--show-object-format'])
      if (!['true', 'false'].includes(bare) || !['sha1', 'sha256'].includes(objectFormat)) {
        throw new Error('unsupported repository metadata response')
      }
      return {
        administrative,
        record: {
          type: 'repository', id: entry.id, workingTree: administrative ? null : entry.source,
          gitDirectory, commonDirectory, bare: bare === 'true', objectFormat,
        },
      }
    } catch (error) {
      signal.throwIfAborted()
      return { administrative, error }
    }
  }

  async #isStorage(path: PhysicalPath, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    return await this.io.exists(childPath(path, 'HEAD')) &&
      (await this.io.exists(childPath(path, 'objects')) || await this.io.exists(childPath(path, 'commondir')))
  }

  async #administrativeAncestor(path: PhysicalPath, signal: AbortSignal): Promise<boolean> {
    const segments = path.path.split('/').filter(Boolean)
    while (segments.length) {
      segments.pop()
      const ancestor = { root: path.root, path: segments.join('/') }
      if (segments.at(-1) === '.git') return true
      if (await this.#isStorage(ancestor, signal)) {
        await this.io.git(['rev-parse', '--resolve-git-dir', nativePath(ancestor)], ancestor, signal)
        return true
      }
    }
    return false
  }
}
