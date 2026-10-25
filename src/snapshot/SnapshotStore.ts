import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import PathspecEvaluator, { type SelectionContext, type SourceBinding } from '../config/PathspecEvaluator.ts'
import Scanner, { type RepositoryRecord, type ScanRecord } from '../filesystem/Scanner.ts'
import { errorCode, nativePath, scanningIO } from '../filesystem/scanning-utils.ts'
import GitProcess, { GitCommit, GitTreeEntry, type GitIdentity, type GitRequest, type ObjectFormat } from '../git/GitProcess.ts'
import type RemotePacks from '../remote/RemotePacks.ts'
import RepositoryCapture from '../repos/RepositoryCapture.ts'
import RepositorySelection, { RepositoryInfo } from '../repos/RepositorySelection.ts'
import ContentStaging from './ContentStaging.ts'
import SnapshotGraph, { SnapshotGraphData, type SnapshotTreeWriter } from './SnapshotGraph.ts'
import SnapshotReader from './SnapshotReader.ts'
import {
  ObjectReference, SnapshotManifest, SnapshotPacks,
  type CapturedRepository, type RepositoryIdentity, type SnapshotMount,
} from './snapshot-format.ts'

export interface SnapshotCommitOptions {
  readonly pathspec: string
  readonly message: string
  readonly identity: GitIdentity
  /** Remote receiving captured contents; only bak's own records stay local. */
  readonly content: RemotePacks
  readonly relocate?: readonly string[]
  readonly signal?: AbortSignal
  readonly report?: (record: Extract<ScanRecord, { type: 'problem' | 'skipped' }>) => void
}

export interface SnapshotCommitResult {
  readonly commit: string
  readonly changed: boolean
}

/**
 * New repository identities derive from their location, so a rerun after an interrupted
 * capture finds the content packs it already uploaded under the same store.
 */
function stableIdentity(location: string, catalog: ReadonlyMap<string, RepositoryIdentity>): string {
  for (let attempt = 0; ; attempt++) {
    const hex = createHash('sha256').update(`${location}\0${attempt}`).digest('hex')
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
    if (!catalog.has(id)) return id
  }
}

interface CapturedRepositoryState {
  readonly repository: CapturedRepository
  readonly selection: SelectionContext
}

export default class SnapshotStore {
  static readonly pathspecFileName = '.bakspec'
  /** Version 2 keeps captured contents remote-only. */
  static readonly formatVersion = '2'

  constructor(readonly root: string, readonly git = new GitProcess()) {}

  async init(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await mkdir(this.root, { recursive: true })
    await mkdir(join(this.root, '.bak'), { recursive: true })
    const storage = await lstat(join(this.root, '.bak'))
    if (!storage.isDirectory() || storage.isSymbolicLink()) throw new Error('backup storage must be a real directory')
    await mkdir(join(this.root, '.bak', 'repos'), { recursive: true })
    if ((await lstat(join(this.root, '.bak', 'repos'))).isSymbolicLink()) throw new Error('repository storage cannot be a link')
    const main = join(this.root, '.bak', 'main.git')
    let created = false
    try {
      await mkdir(main)
      created = true
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    if (created) {
      const request = { cwd: this.root, ...(signal ? { signal } : {}) }
      await this.git.run(['init', '--bare', '--template=', '--object-format=sha1', main], request)
      await this.git.run(['symbolic-ref', 'HEAD', 'refs/heads/snapshots'], { ...request, gitDirectory: main })
      await this.git.run(['config', 'bak.formatVersion', SnapshotStore.formatVersion], { ...request, gitDirectory: main })
    }
    await this.checkStorage(signal)
    try {
      await writeFile(join(this.root, SnapshotStore.pathspecFileName),
        '# Add source paths to back up, one per line.\n' +
        '# Example: "C:/Users/you/Documents" or "/home/you/Documents"\n' +
        '# Remote storage: @remote = b2://bucket/prefix\n',
        { flag: 'wx' })
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }

  async commit(options: SnapshotCommitOptions): Promise<SnapshotCommitResult> {
    options.signal?.throwIfAborted()
    await this.checkStorage(options.signal)
    if (!options.identity.name.trim() || !options.identity.email.trim() || /[\r\n<>]/.test(options.identity.name + options.identity.email)) {
      throw new Error('a valid Git author name and email are required')
    }
    const main = this.directory('main')
    const base: GitRequest = {
      cwd: this.root, gitDirectory: main, identity: options.identity,
      ...(options.signal ? { signal: options.signal } : {}),
    }
    const head = await this.git.run(['rev-parse', '--verify', '--quiet', 'refs/heads/snapshots'], {
      ...base, acceptExitCodes: [0, 1],
    })
    const previousCommit = head.code === 0 ? ObjectReference.oid(head.stdout.toString(), 'sha1') : null
    const previous = previousCommit ? await new SnapshotReader(this.root).manifest(previousCommit, options.signal) : null
    const previousPacks = previousCommit ? await new SnapshotReader(this.root).packs(previousCommit, options.signal) : null
    const discover = async (report?: SnapshotCommitOptions['report']) => {
      const records: ScanRecord[] = []
      for await (const record of new Scanner(new PathspecEvaluator(options.pathspec)).scan(
        options.signal ? { signal: options.signal } : {},
      )) {
        records.push(record)
        if (record.type === 'problem' || record.type === 'skipped') report?.(record)
      }
      return SnapshotGraph.collect(records)
    }
    const data = await discover(options.report)
    const repositoryBindings = data.mounts.flatMap(mount => {
      const repository = [...data.repositories.values()].find(repository =>
        nativePath(repository.commonDirectory) === nativePath(mount.commonDirectory))
      return (repository?.worktrees ?? []).filter(worktree => nativePath(worktree.source) !== nativePath(mount.source))
        .map(worktree => ({ name: `${mount.name}+${worktree.id}`, source: worktree.source }))
    })
    const expanded = new PathspecEvaluator(options.pathspec).bindRepositories(repositoryBindings)
    const bindings: SourceBinding[] = []
    for (const source of expanded.getSourcePaths()) {
      options.signal?.throwIfAborted()
      bindings.push({ source, resolved: await scanningIO.resolveRule(source) })
    }
    const evaluator = expanded.bindSources(bindings)
    const backup = await realpath(this.root)
    for (const entry of data.entries.values()) {
      const source = resolve(nativePath(entry.source))
      if (source === backup || source.startsWith(backup + sep)) {
        throw new Error('backup storage is selected; exclude the backup directory before capturing')
      }
    }
    const graph = new SnapshotGraph(data)
    const declarations = data.mounts.map(mount => {
      const repository = [...data.repositories.values()].find(repository =>
        nativePath(repository.source) === nativePath(mount.source) &&
        nativePath(repository.commonDirectory) === nativePath(mount.commonDirectory))
      if (!repository) throw new Error('declared repository has no selected root')
      return { name: mount.name, repository }
    })
    const { groups, mounts: names } = new RepositorySelection(declarations)
      .resolve([...data.repositories.values()], data.worktreeRoots)
    const identities = new Map<string, RepositoryIdentity>()
    const catalog = new Map((previous?.catalog ?? []).map(identity => [identity.id, identity]))
    const relocations = new Set((options.relocate ?? []).map(name => name.replace(/^repo:\//, '')))
    const usedRelocations = new Set<string>()
    for (const [common, { anchor, name }] of groups) {
      const old = previous?.catalog.find(identity =>
        identity.commonDirectory.root + identity.commonDirectory.path === common)
      const namedOld = previous?.catalog.find(identity => identity.name === name)
      let identity = old
      if (!identity && namedOld) {
        if (!relocations.has(name)) throw new Error(`repository ${name} moved or was replaced; explicitly acknowledge relocation`)
        if (groups.has(namedOld.commonDirectory.root + namedOld.commonDirectory.path)) {
          throw new Error('both old and new repository locations are selected')
        }
        if (namedOld.objectFormat !== anchor.objectFormat) throw new Error('relocation cannot change repository object format')
        identity = namedOld
        usedRelocations.add(name)
      } else if (namedOld && identity && namedOld.id !== identity.id) {
        throw new Error('repository name belongs to another stored identity')
      }
      const current: RepositoryIdentity = {
        id: identity?.id ?? stableIdentity(common, catalog), name, source: anchor.source,
        commonDirectory: anchor.commonDirectory, objectFormat: anchor.objectFormat,
      }
      identities.set(common, current)
      catalog.set(current.id, current)
    }
    if ([...relocations].some(name => !usedRelocations.has(name))) throw new Error('relocation acknowledgement does not match a changed source')
    const projection = graph.project(names)
    const transaction = randomUUID()
    await using staging = new ContentStaging(options.content, previousPacks, transaction)
    const captured = new Map<string, CapturedRepositoryState | 'capturing'>()
    const repositoryCapture = new RepositoryCapture()
    const captureRepository = async (source: RepositoryInfo, inherited?: SelectionContext): Promise<CapturedRepository> => {
      const key = RepositoryInfo.key(source)
      let identity = identities.get(key) ?? [...catalog.values()].find(item =>
        item.commonDirectory.root + item.commonDirectory.path === key)
      if (!identity) {
        const id = stableIdentity(key, catalog)
        identity = {
          id, name: `administrative-${id}`,
          commonDirectory: source.commonDirectory, source: source.source, objectFormat: source.objectFormat,
        }
        catalog.set(identity.id, identity)
      }
      identities.set(key, identity)
      const retained = captured.get(identity.id)
      if (retained === 'capturing') throw new Error('nested administrative repository cycle')
      if (retained) return retained.repository
      const context = evaluator.contents(
        groups.has(key) ? identity.source : source.source,
        groups.has(key) ? { selected: true, order: -1 } : inherited ?? { selected: true, order: -1 },
      )
      const selected = (path: Parameters<PathspecEvaluator['enter']>[0]) => evaluator.enter(path, context).selected
      captured.set(identity.id, 'capturing')
      try {
        const directory = await this.initRepositoryStore(identity.id, identity.objectFormat, options.signal)
        const result = await repositoryCapture.capture({
          source, identity, directory, staging, author: options.identity, transaction,
          ...(options.signal ? { signal: options.signal } : {}),
          nested: nested => captureRepository(nested, context),
          selected, rulePaths: bindings.map(binding => binding.resolved),
        })
        captured.set(identity.id, { repository: result, selection: context })
        return result
      } finally {
        if (captured.get(identity.id) === 'capturing') captured.delete(identity.id)
      }
    }
    for (const group of groups.values()) await captureRepository(group.anchor)
    const repositoryStates = [...captured.values()].map(state => {
      if (state === 'capturing') throw new Error('repository capture is incomplete')
      return state
    })
    const format = (store: string): ObjectFormat => store === 'main' ? 'sha1' : catalog.get(store)!.objectFormat
    const request = (store: string): GitRequest => ({ ...base, gitDirectory: this.directory(store) })
    const blob = async (contents: string, store: string) => ObjectReference.oid(
      (await this.git.run(['hash-object', '-w', '--stdin'], { ...request(store), input: contents })).stdout.toString(), format(store),
    )
    const content = new Map<string, Map<string, string>>()
    const mounts = new Map<string, SnapshotMount | 'building'>()
    const writer: SnapshotTreeWriter = {
      tree: async (entries, store) => ObjectReference.oid((await this.git.run(['mktree', '-z', '--missing'], {
        ...request(store), input: GitTreeEntry.encode(entries),
      })).stdout.toString(), format(store)),
      entry: async (id, store) => {
        options.signal?.throwIfAborted()
        const repository = data.repositories.get(id)
        if (repository) {
          const mount = await workingCommit(repository)
          if (format(store) === repository.objectFormat) return { mode: '160000', type: 'commit', oid: mount.commit }
          return {
            mode: '100644', type: 'blob',
            oid: await blob(JSON.stringify({
              type: 'bak-repository', repository: mount.repository,
              objectFormat: repository.objectFormat, commit: mount.commit,
            }), store),
          }
        }
        const entry = data.entries.get(id)
        if (!entry || entry.kind !== 'file') throw new Error('invalid captured file reference')
        const objects = content.get(id) ?? new Map<string, string>()
        let oid = objects.get(store)
        if (!oid) {
          oid = await staging.file(store, format(store), entry, options.signal)
          objects.set(store, oid)
          content.set(id, objects)
        }
        return { mode: entry.metadata.mode & 0o111 ? '100755' : '100644', type: 'blob', oid }
      },
    }
    const workingCommit = async (repository: RepositoryRecord): Promise<SnapshotMount> => {
      const existing = mounts.get(repository.id)
      if (existing === 'building') throw new Error('repository working-state cycle')
      if (existing) return existing
      mounts.set(repository.id, 'building')
      try {
        const identity = identities.get(RepositoryInfo.key(repository))!
        const tree = await graph.write(graph.source(repository.id, true), identity.id, writer)
        const sourceHead = await this.git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], {
          ...base, cwd: nativePath(repository.commonDirectory), gitDirectory: nativePath(repository.gitDirectory), acceptExitCodes: [0, 1],
        })
        const parent = sourceHead.code === 0 ? ObjectReference.oid(sourceHead.stdout.toString(), repository.objectFormat) : null
        // The parent lives in remote content packs, not this store.
        const commit = await GitCommit.write(this.git, request(identity.id), repository.objectFormat, {
          tree: tree.oid, parents: parent ? [parent] : [], identity: options.identity, message: options.message,
        })
        const name = names.get(repository.id)!
        const reference = Buffer.from(repository.id).toString('hex')
        await this.git.run(['update-ref', `refs/bak/captures/${transaction}/working/${reference}`, commit], request(identity.id))
        const mount = { name, entry: repository.id, repository: identity.id, commit }
        mounts.set(repository.id, mount)
        return mount
      } finally {
        if (mounts.get(repository.id) === 'building') mounts.delete(repository.id)
      }
    }
    const mainTree = await graph.write(projection, 'main', writer)
    const manifest: SnapshotManifest = {
      version: 1, pathspec: options.pathspec,
      entries: [...data.entries.values()].map(entry => ({
        id: entry.id, source: entry.source, kind: entry.kind, metadata: entry.metadata,
        objects: [...(content.get(entry.id) ?? [])].map(([repository, oid]) => ({ repository, oid })),
      })),
      roots: [
        ...data.roots,
        ...data.worktreeRoots.map(root => ({
          type: 'root' as const, id: root.id,
          destination: { kind: 'repository' as const, path: names.get(root.id)! },
        })),
      ],
      links: SnapshotGraphData.links(data), mounts: [...mounts.values()].map(mount => {
        if (mount === 'building') throw new Error('working snapshot capture is incomplete')
        return mount
      }),
      repositories: repositoryStates.map(state => state.repository),
      catalog: [...catalog.values()], skipped: data.skipped,
    }
    SnapshotManifest.parse(JSON.stringify(manifest))
    if (SnapshotGraphData.signature(data) !== SnapshotGraphData.signature(await discover())) {
      throw new Error('selected filesystem state changed during capture')
    }
    for (const state of repositoryStates) {
      await repositoryCapture.verify(state.repository, options.signal,
        path => evaluator.enter(path, state.selection).selected)
    }
    if (previous && previousCommit && SnapshotManifest.contentKey(previous) === SnapshotManifest.contentKey(manifest)) {
      return { commit: previousCommit, changed: false }
    }
    const packs = await staging.finish(options.signal)
    for (const reference of [
      ...manifest.entries.flatMap(entry => entry.objects),
      ...manifest.repositories.flatMap(repository => repository.administrative.flatMap(entry =>
        entry.oid ? [{ repository: repository.identity.id, oid: entry.oid }] : [])),
    ]) {
      if (!await staging.covers(reference.repository, reference.oid)) throw new Error('captured contents did not reach the remote')
    }
    const metadata = await writer.tree([
      { name: 'manifest.json', mode: '100644', type: 'blob', oid: await blob(JSON.stringify(manifest), 'main') },
      { name: 'packs.json', mode: '100644', type: 'blob', oid: await blob(SnapshotPacks.encode(packs), 'main') },
    ], 'main')
    const existingTree = await this.git.run(['ls-tree', '-z', mainTree.oid], base)
    const tree = ObjectReference.oid((await this.git.run(['mktree', '-z', '--missing'], {
      ...base,
      input: Buffer.concat([existingTree.stdout, Buffer.from(`040000 tree ${metadata}\t.bak-meta\0`)]),
    })).stdout.toString(), 'sha1')
    const commit = await GitCommit.write(this.git, base, 'sha1', {
      tree, parents: previousCommit ? [previousCommit] : [], identity: options.identity, message: options.message,
    })
    options.signal?.throwIfAborted()
    try {
      await this.git.run(['update-ref', 'refs/heads/snapshots', commit, previousCommit ?? '0'.repeat(40)], base)
    } catch (error) {
      // Cancellation or an I/O failure can arrive after Git has committed the
      // transaction. Read its outcome once, without retrying the mutation.
      const { signal: _signal, ...verification } = base
      let published
      try {
        published = await this.git.run(['rev-parse', '--verify', '--quiet', 'refs/heads/snapshots'], {
          ...verification, acceptExitCodes: [0, 1],
        })
      } catch (verificationError) {
        throw new AggregateError([error, verificationError], 'publication outcome is unknown; inspect the snapshot ref')
      }
      if (published.code !== 0 || ObjectReference.oid(published.stdout.toString(), 'sha1') !== commit) throw error
    }
    return { commit, changed: true }
  }

  /** Git directory of `main` or a repository store id. */
  directory(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('invalid repository identity')
    return id === 'main' ? join(this.root, '.bak', 'main.git') : join(this.root, '.bak', 'repos', `${id}.git`)
  }

  /** Creates or validates a repository store; returns its Git directory. */
  async initRepositoryStore(id: string, objectFormat: 'sha1' | 'sha256', signal?: AbortSignal): Promise<string> {
    if (id === 'main') throw new Error('invalid repository identity')
    const directory = this.directory(id)
    const request = { cwd: this.root, ...(signal ? { signal } : {}) }
    try {
      await mkdir(directory)
      await this.git.run(['init', '--bare', '--template=', `--object-format=${objectFormat}`, directory], request)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('repository object storage cannot be a link')
    }
    const storage = await this.git.run(['rev-parse', '--is-bare-repository', '--show-object-format'], {
      ...request, gitDirectory: directory,
    })
    if (storage.stdout.toString().trim().split(/\r?\n/).join('\n') !== `true\n${objectFormat}`) {
      throw new Error('repository backup storage has an incompatible format')
    }
    return directory
  }

  /** Rejects storage that bak did not initialise. */
  async checkStorage(signal?: AbortSignal): Promise<void> {
    for (const path of ['.bak', '.bak/repos', '.bak/main.git', '.bak/main.git/objects', '.bak/main.git/refs']) {
      signal?.throwIfAborted()
      const entry = await lstat(join(this.root, path))
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('backup storage must use real owned directories')
    }
    const request = {
      cwd: this.root, gitDirectory: this.directory('main'), ...(signal ? { signal } : {}),
    }
    const version = await this.git.run(['config', '--get', 'bak.formatVersion'], { ...request, acceptExitCodes: [0, 1] })
    if (version.stdout.toString().trim() === '1') {
      throw new Error('this backup folder was created by an earlier bak that kept file contents locally; initialise a new folder')
    }
    const format = await this.git.run(['rev-parse', '--is-bare-repository', '--show-object-format'], request)
    const head = await this.git.run(['symbolic-ref', '--quiet', 'HEAD'], { ...request, acceptExitCodes: [0, 1] })
    if (version.stdout.toString().trim() !== SnapshotStore.formatVersion ||
      format.stdout.toString().trim().split(/\r?\n/).join('\n') !== 'true\nsha1' ||
      head.stdout.toString().trim() !== 'refs/heads/snapshots') {
      throw new Error('unrecognised or incompatible backup storage; initialise a dedicated backup directory')
    }
  }
}
