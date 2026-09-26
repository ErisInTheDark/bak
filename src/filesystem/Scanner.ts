import PathspecEvaluator, {
  PhysicalPath, type Destination, type Exposure, type SelectionContext, type SourceBinding,
} from '../config/PathspecEvaluator.ts'
import { dirname, resolve } from 'node:path'
import type { RepositoryMount } from '../config/pathspec-syntax.ts'
import RepositorySelection, { type NamedRepository, type RepositoryInfo } from '../repos/RepositorySelection.ts'
import {
  childPath, errorCode, nativePath, scanningIO, sourcePath,
  type Inspection, type Metadata, type ScanningIO,
} from './scanning-utils.ts'

export type ScanRecord =
  | { type: 'entry'; id: string; source: PhysicalPath; kind: 'file' | 'directory'; metadata: Metadata }
  | { type: 'root'; id: string; destination: Destination; symbolic?: { target: string; materialised: boolean } }
  | { type: 'link'; parent: string; name: string; id: string; relationship: 'entry' | 'symbolic' | 'hardlink';
      target?: string; materialised?: boolean }
  | ({ type: 'repository'; id: string; workingTree: PhysicalPath | null } & RepositoryInfo)
  | { type: 'mount'; name: string; source: PhysicalPath; commonDirectory: PhysicalPath }
  | { type: 'worktree-root'; id: string; commonDirectory: PhysicalPath; worktree: string }
  | { type: 'skipped'; source: PhysicalPath; namedCopies: readonly string[] }
  | { type: 'problem'; source: PhysicalPath | null; operation: string; message: string; code?: string }
  | { type: 'completion'; complete: boolean; cancelled: boolean; problems: number; entries: number; repositories: number }

interface SharedEntry {
  readonly inspection: Inspection
  readonly context: SelectionContext
  phase: 'visiting' | 'done'
  repository?: RepositoryRecord
  administrative: boolean
}

export type RepositoryRecord = Extract<ScanRecord, { type: 'repository' }>

interface RepositoryDetection {
  administrative: boolean
  record?: RepositoryRecord
  error?: unknown
}

interface ScanExposure extends Exposure {
  automatic?: { commonDirectory: PhysicalPath; worktree: string }
}

interface ScanRun {
  readonly evaluator: PathspecEvaluator
  readonly shared: Map<string, SharedEntry>
  readonly rootPaths: ReadonlySet<string>
  readonly signal: AbortSignal
  readonly selection: RepositorySelection
  readonly exposures: readonly ScanExposure[]
}

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
      let evaluator = this.evaluator.bindSources(bindings)
      const named: NamedRepository[] = []
      const dynamic: RepositoryMount[] = []
      for (const mount of evaluator.getRepositoryMounts()) {
        if (!evaluator.getExposures().some(exposure =>
          exposure.destination.kind === 'repository' && exposure.destination.path === mount.name)) continue
        signal.throwIfAborted()
        try {
          const inspected = await this.io.inspect(mount.source)
          const found = await this.#repository(inspected, evaluator, evaluator.contents(inspected.source), signal)
          if (found.error) throw found.error
          if (!found.record) throw new Error('repository mount source does not have selected repository treatment')
          if (named.some(item => pathKey(item.repository.commonDirectory) === pathKey(found.record!.commonDirectory))) {
            throw new Error('a shared repository can have only one explicit base mount')
          }
          named.push({ name: mount.name, repository: found.record })
          for (const worktree of found.record.worktrees) {
            if (pathKey(worktree.source) !== pathKey(inspected.source)) {
              dynamic.push({ name: `${mount.name}+${worktree.id}`, source: worktree.source })
            }
          }
          yield { type: 'mount', name: mount.name, source: inspected.source, commonDirectory: found.record.commonDirectory }
        } catch (error) {
          signal.throwIfAborted()
          problems++
          yield problem(mount.source, 'resolve repository mount', error)
        }
      }
      const expanded = this.evaluator.bindRepositories(dynamic)
      bindings.length = 0
      for (const source of expanded.getSourcePaths()) {
        try {
          bindings.push({ source, resolved: await this.io.resolveRule(source) })
        } catch (error) {
          signal.throwIfAborted()
          problems++
          yield problem(source, 'resolve selection', error)
          bindings.push({ source, resolved: source })
        }
      }
      evaluator = expanded.bindSources(bindings)
      const selection = new RepositorySelection(named)
      const rootPaths = new Set(evaluator.getScanRoots().map(pathKey))
      const exposures: ScanExposure[] = evaluator.getExposures()
      const run: ScanRun = { evaluator, shared, rootPaths, signal, selection, exposures }
      for (const exposure of exposures) {
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
          if (named.length && !named.some(mount => pathKey(mount.repository.source) === pathKey(inspection.source))) {
            const excluded = await this.#suppressedAncestor(inspection.source, evaluator, selection, signal)
            if (excluded) {
              yield { type: 'skipped', source: inspection.source, namedCopies: excluded }
              continue
            }
          }
        } catch (error) {
          signal.throwIfAborted()
          problems++
          yield problem(source, 'inspect root', error)
          continue
        }
        const root: Extract<ScanRecord, { type: 'root' | 'worktree-root' }> = exposure.automatic
          ? { type: 'worktree-root', id: inspection.id, ...exposure.automatic }
          : {
          type: 'root', id: inspection.id, destination: exposure.destination,
          ...(inspection.symbolic ? { symbolic: {
            ...inspection.symbolic,
            materialised: expanded.evaluate(inspection.source).length === 0,
          } } : {}),
        }
        for await (const record of this.#walk(source, run, undefined, inspection, root)) {
          if (record.type === 'problem') problems++
          if (record.type === 'entry') entries++
          if (record.type === 'repository') {
            repositories++
            if (!named.some(item => pathKey(item.repository.commonDirectory) === pathKey(record.commonDirectory))) {
              for (const worktree of record.worktrees) {
                if (!evaluator.enter(worktree.source, { selected: true, order: -1 }).selected) continue
                try {
                  const resolved = await this.io.resolveRule(worktree.source)
                  if (rootPaths.has(pathKey(resolved))) continue
                  rootPaths.add(pathKey(resolved))
                  bindings.push({ source: worktree.source, resolved })
                  exposures.push({
                    source: resolved, origin: worktree.source,
                    automatic: { commonDirectory: record.commonDirectory, worktree: worktree.id },
                    destination: { kind: 'repository', path: worktree.id },
                  })
                } catch (error) {
                  signal.throwIfAborted()
                  problems++
                  yield problem(worktree.source, 'resolve linked worktree', error)
                }
              }
            }
          }
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
    run: ScanRun,
    parent?: { id: string; name: string; context: SelectionContext },
    prepared?: Inspection,
    root?: Extract<ScanRecord, { type: 'root' | 'worktree-root' }>,
  ): AsyncGenerator<ScanRecord> {
    const { evaluator, shared, rootPaths, signal, selection, exposures } = run
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
    const automatic = exposures.some(exposure => {
      if (!exposure.automatic || !PhysicalPath.contains(exposure.source, inspected.source)) return false
      const prefix = exposure.source.path ? exposure.source.path + '/' : ''
      const suffix = inspected.source.path.slice(exposure.source.path.length).replace(/^\//, '')
      const parts = suffix.split('/').filter(Boolean)
      return [exposure.source.path, ...parts.map((_, index) =>
        prefix + parts.slice(0, index + 1).join('/'))].every(path =>
        evaluator.enter({ root: inspected.source.root, path }, { selected: true, order: -1 }).selected)
    })
    const independent = destinations.length > 0 || automatic
    if (!parent && !independent) return
    const context = independent
      ? evaluator.contents(inspected.source, automatic ? { selected: true, order: -1 } : undefined)
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
        if (selection.named.length) {
          const excluded = await this.#suppressedAncestor(inspected.source, evaluator, selection, signal)
          if (excluded) {
            yield { type: 'skipped', source: inspected.source, namedCopies: excluded }
            return
          }
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

    let detected: RepositoryDetection
    if (previous) {
      detected = {
        administrative: previous.administrative,
        ...(previous.repository ? { record: previous.repository } : {}),
      }
    } else {
      detected = { administrative: false }
      if (inspected.kind === 'directory') {
        try {
          detected = await this.#repository(inspected, evaluator, context, signal)
          if (detected.error) yield problem(path, 'detect repository', detected.error)
        } catch (error) {
          signal.throwIfAborted()
          yield problem(path, 'detect repository', error)
        }
      }
    }
    if (detected.record) {
      const decision = selection.decide(detected.record)
      if (!decision.selected) {
        yield { type: 'skipped', source: inspected.source, namedCopies: decision.namedCopies }
        return
      }
    }
    if (root) yield root
    const entry: SharedEntry = previous ?? {
      inspection: inspected, context, phase: 'visiting', administrative: detected.administrative,
      ...(detected.record ? { repository: detected.record } : {}),
    }
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
      if (detected.record) yield detected.record
      if (detected.administrative) return
      try {
        for await (const name of this.io.children(inspected.source)) {
          signal.throwIfAborted()
          if (name === '.git') continue
          const child = childPath(inspected.source, name)
          if (!evaluator.enter(child, context).selected) continue
          yield* this.#walk(child, run, { id: inspected.id, name, context })
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
  ): Promise<RepositoryDetection> {
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
    const query = async (args: string[], acceptExitCodes?: readonly number[]) => {
      signal.throwIfAborted()
      return this.io.git(args, entry.source, signal, acceptExitCodes)
    }
    try {
      const gitDirectory = await this.io.resolveRule(sourcePath(
        await query(['rev-parse', '--path-format=absolute', '--resolve-git-dir', nativePath(gitPath)]),
      ))
      const args = [`--git-dir=${nativePath(gitDirectory)}`, 'rev-parse']
      const commonDirectory = await this.io.resolveRule(sourcePath(await query([...args, '--path-format=absolute', '--git-common-dir'])))
      const bare = await query([...args, '--is-bare-repository'])
      const objectFormat = await query([...args, '--show-object-format'])
      if (!['true', 'false'].includes(bare) || (objectFormat !== 'sha1' && objectFormat !== 'sha256')) {
        throw new Error('unsupported repository metadata response')
      }
      const config = await query([`--git-dir=${nativePath(gitDirectory)}`, 'config', '--null', '--get-all', 'remote.origin.url'], [0, 1])
      if (config && !config.endsWith('\0')) throw new Error('invalid origin address response')
      const origins = config ? config.slice(0, -1).split('\0') : []
      if (origins.length > 1) throw new Error('multiple origin addresses require an unambiguous project identity')
      const worktrees: RepositoryInfo['worktrees'][number][] = []
      const registrations = childPath(commonDirectory, 'worktrees')
      if (await this.io.exists(registrations)) {
        const listed = await query([`--git-dir=${nativePath(gitDirectory)}`, 'worktree', 'list', '--porcelain', '-z'])
        const paths = listed.split('\0').filter(item => item.startsWith('worktree '))
          .map(item => pathKey(sourcePath(item.slice('worktree '.length))))
        for await (const id of this.io.children(registrations)) {
          const registration = childPath(registrations, id)
          const pointer = (await this.io.readText(childPath(registration, 'gitdir')))
            .replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '')
          const source = sourcePath(dirname(resolve(nativePath(registration), pointer)))
          if (!paths.includes(pathKey(source))) throw new Error('worktree registration changed during discovery')
          worktrees.push({ id, source })
        }
        worktrees.sort((a, b) => a.id.localeCompare(b.id))
      }
      return {
        administrative,
        record: {
          type: 'repository', id: entry.id, source: entry.source, workingTree: administrative ? null : entry.source,
          gitDirectory, commonDirectory, bare: bare === 'true', objectFormat, origin: origins[0] || null, worktrees,
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

  async #suppressedAncestor(
    path: PhysicalPath, evaluator: PathspecEvaluator, selection: RepositorySelection, signal: AbortSignal,
  ): Promise<readonly string[] | undefined> {
    if (selection.named.some(mount => pathKey(mount.repository.source) === pathKey(path))) return undefined
    const segments = path.path.split('/').filter(Boolean)
    while (segments.length) {
      signal.throwIfAborted()
      segments.pop()
      const parent = { root: path.root, path: segments.join('/') }
      if (selection.named.some(mount => pathKey(mount.repository.source) === pathKey(parent))) return undefined
      const context = evaluator.contents(parent)
      if (!context.selected) continue
      const repository = await this.#repository(await this.io.inspect(parent), evaluator, context, signal)
      if (repository.error) throw repository.error
      if (!repository.record) continue
      const decision = selection.decide(repository.record)
      if (!decision.selected) return decision.namedCopies
    }
    return undefined
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
