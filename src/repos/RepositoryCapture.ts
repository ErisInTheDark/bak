import { lstat, readlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import GitProcess, { GitTreeEntry, type GitIdentity, type GitRequest } from '../git/GitProcess.ts'
import { FileCapture } from '../filesystem/capture-file.ts'
import { Metadata, nativePath, scanningIO, sourcePath } from '../filesystem/scanning-utils.ts'
import { ObjectReference, type AdministrativeEntry, type CapturedRepository, type RepositoryIdentity } from '../snapshot/snapshot-format.ts'
import type { RepositoryInfo } from './RepositorySelection.ts'
import type { PhysicalPath } from '../config/PathspecEvaluator.ts'

export interface RepositoryCaptureRequest {
  readonly source: RepositoryInfo
  readonly identity: RepositoryIdentity
  readonly directory: string
  readonly author: GitIdentity
  readonly transaction: string
  readonly signal?: AbortSignal
  readonly nested: (source: RepositoryInfo) => Promise<CapturedRepository>
  readonly selected?: (path: PhysicalPath) => boolean
  readonly rulePaths?: readonly PhysicalPath[]
}

export default class RepositoryCapture {
  readonly #git = new GitProcess()

  async capture(request: RepositoryCaptureRequest): Promise<CapturedRepository> {
    const sourceDirectory = nativePath(request.source.commonDirectory)
    const objectDirectory = sourcePath(join(sourceDirectory, 'objects'))
    const selected = request.selected ?? (() => true)
    if (!selected(objectDirectory) || request.rulePaths?.some(path =>
      path.root === objectDirectory.root &&
      path.path.startsWith(objectDirectory.path + '/') && !selected(path))) {
      throw new Error('excluded Git object storage prevents complete repository capture; exclude .git for ordinary-file treatment')
    }
    const source: GitRequest = {
      cwd: sourceDirectory, gitDirectory: sourceDirectory,
      ...(request.signal ? { signal: request.signal } : {}),
    }
    const destination: GitRequest = {
      cwd: request.directory, gitDirectory: request.directory, identity: request.author,
      ...(request.signal ? { signal: request.signal } : {}),
    }
    const refsBefore = (await this.#git.run(['for-each-ref', '--format=%(refname) %(objectname) %(symref)'], source)).stdout
    const objects = await this.#objects(source)
    const retained = new Set(await this.#objects(destination))
    const missing = objects.filter(oid => !retained.has(oid))
    if (missing.length) {
      const stream = new PassThrough()
      const transfer = await Promise.allSettled([
        this.#git.run(['pack-objects', '--stdout'], {
          ...source, input: Readable.from(missing.map(oid => `${oid}\n`)), output: stream,
        }),
        this.#git.run(['index-pack', '--stdin', `--keep=bak ${request.transaction}`], {
          ...destination, input: stream,
        }),
      ])
      const failure = transfer.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }
    const available = new Set(await this.#objects(destination))
    if (objects.some(oid => !available.has(oid))) throw new Error('repository object transfer is incomplete')
    // Traverse refs and reflogs without fetching promised objects. Git observes
    // the source's shallow boundary; missing objects inside it are failures.
    let revisionTail = ''
    await this.#git.run(['rev-list', '--objects', '--all', '--reflog', '--missing=print'], {
      ...source,
      output: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          revisionTail += chunk.toString('utf8')
          const lines = revisionTail.split('\n')
          revisionTail = lines.pop()!
          callback(lines.some(line => line.startsWith('?')) ? new Error('required repository objects are unavailable locally') : undefined)
        },
      }),
    })
    if (revisionTail.startsWith('?')) throw new Error('required repository objects are unavailable locally')

    const administrative: AdministrativeEntry[] = [{
      path: '', kind: 'directory', metadata: Metadata.fromStats(await lstat(sourceDirectory, { bigint: true })),
    }]
    const nested: { path: string; repository: string }[] = []
    const walk = async (directory: string, relative: string, ancestors: readonly string[]): Promise<void> => {
      request.signal?.throwIfAborted()
      const canonical = await realpath(directory)
      if (ancestors.includes(canonical)) throw new Error('repository administrative link cycle')
      const before = Metadata.fromStats(await lstat(directory, { bigint: true }))
      const names = await this.#directoryContents(directory)
      for (const name of names) {
        request.signal?.throwIfAborted()
        const path = join(directory, name)
        if (!selected(sourcePath(path))) continue
        const entryPath = relative ? `${relative}/${name}` : name
        if (!relative && name === 'objects') continue
        const stats = await lstat(path, { bigint: true })
        const metadata = Metadata.fromStats(stats)
        const symbolic = stats.isSymbolicLink() ? { target: await readlink(path) } : {}
        const inspected = await scanningIO.inspect(sourcePath(path))
        if (!selected(inspected.source)) continue
        if (inspected.kind === 'directory') {
          if (await scanningIO.exists(sourcePath(join(path, 'HEAD'))) &&
            await scanningIO.exists(sourcePath(join(path, 'objects')))) {
            const query: GitRequest = { ...source, cwd: path, gitDirectory: path }
            const [bare, format] = (await this.#git.run(['rev-parse', '--is-bare-repository', '--show-object-format'], query))
              .stdout.toString().trim().split(/\r?\n/)
            if ((format !== 'sha1' && format !== 'sha256') || (bare !== 'true' && bare !== 'false')) {
              throw new Error('unsupported nested repository metadata')
            }
            const child = await request.nested({
              source: inspected.source, gitDirectory: inspected.source, commonDirectory: inspected.source,
              bare: bare === 'true', objectFormat: format, origin: null, worktrees: [],
            })
            nested.push({ path: entryPath, repository: child.identity.id })
            continue
          }
          administrative.push({
            path: entryPath, kind: 'directory', metadata, ...symbolic,
            ...(stats.isSymbolicLink() ? { resolvedMetadata: inspected.metadata } : {}),
          })
          await walk(path, entryPath, [...ancestors, canonical])
        } else {
          const oid = await FileCapture.read(inspected, async input =>
            ObjectReference.oid((await this.#git.run(['hash-object', '-w', '--stdin'], {
              ...destination, input,
            })).stdout.toString(), request.source.objectFormat), request.signal)
          administrative.push({
            path: entryPath, kind: 'file', metadata, oid, ...symbolic,
            ...(stats.isSymbolicLink() ? { resolvedMetadata: inspected.metadata } : {}),
          })
        }
      }
      if (!Metadata.unchanged(before, Metadata.fromStats(await lstat(directory, { bigint: true }))) ||
        JSON.stringify(names) !== JSON.stringify(await this.#directoryContents(directory))) {
        throw new Error('repository administrative directory changed during capture')
      }
    }
    await walk(sourceDirectory, '', [])
    for (const name of ['alternates', 'http-alternates']) {
      const path = sourcePath(join(sourceDirectory, 'objects', 'info', name))
      if (!await scanningIO.exists(path)) continue
      const inspected = await scanningIO.inspect(path)
      const oid = await FileCapture.read(inspected, async input =>
        ObjectReference.oid((await this.#git.run(['hash-object', '-w', '--stdin'], {
          ...destination, input,
        })).stdout.toString(), request.source.objectFormat), request.signal)
      administrative.push({ path: `objects/info/${name}`, kind: 'file', metadata: inspected.metadata, oid })
    }
    const refsAfter = (await this.#git.run(['for-each-ref', '--format=%(refname) %(objectname) %(symref)'], source)).stdout
    if (!refsBefore.equals(refsAfter)) throw new Error('repository refs changed during capture')
    const state = ObjectReference.oid((await this.#git.run(['hash-object', '-w', '--stdin'], {
      ...destination, input: JSON.stringify({ administrative, nested }),
    })).stdout.toString(), request.source.objectFormat)
    const treeEntries: GitTreeEntry[] = [
      { name: 'state.json', mode: '100644', type: 'blob', oid: state },
      ...administrative.flatMap<GitTreeEntry>((entry, index) => entry.oid
        ? [{ name: String(index).padStart(10, '0'), mode: '100644', type: 'blob', oid: entry.oid }] : []),
    ]
    const tree = ObjectReference.oid((await this.#git.run(['mktree', '-z'], {
      ...destination, input: GitTreeEntry.encode(treeEntries),
    })).stdout.toString(), request.source.objectFormat)
    const adminCommit = ObjectReference.oid((await this.#git.run(['commit-tree', tree, '-m', 'repository administrative snapshot'], {
      ...destination,
    })).stdout.toString(), request.source.objectFormat)
    await this.#git.run(['update-ref', `refs/bak/captures/${request.transaction}/admin`, adminCommit], destination)
    return {
      identity: request.identity,
      source: {
        source: request.source.source, gitDirectory: request.source.gitDirectory,
        commonDirectory: request.source.commonDirectory, bare: request.source.bare,
        objectFormat: request.source.objectFormat, worktrees: request.source.worktrees,
      },
      objects, administrative, nested, adminCommit,
    }
  }

  async verify(
    repository: CapturedRepository, signal?: AbortSignal, selected: (path: PhysicalPath) => boolean = () => true,
  ): Promise<void> {
    const root = nativePath(repository.source.commonDirectory)
    const inventory = repository.administrative.map(entry => entry.path).concat(repository.nested.map(entry => entry.path))
    for (const entry of repository.administrative) {
      signal?.throwIfAborted()
      const path = join(root, ...entry.path.split('/'))
      if (!Metadata.unchanged(entry.metadata, Metadata.fromStats(await lstat(path, { bigint: true })))) {
        throw new Error('repository administrative state changed after capture')
      }
      if (entry.resolvedMetadata &&
        !Metadata.unchanged(entry.resolvedMetadata, (await scanningIO.inspect(sourcePath(path))).metadata)) {
        throw new Error('repository administrative link target changed after capture')
      }
      if (entry.kind === 'directory') {
        const prefix = entry.path ? entry.path + '/' : ''
        const expected = [...new Set(inventory.filter(path => path.startsWith(prefix) && path !== entry.path)
          .map(path => path.slice(prefix.length).split('/')[0]!))]
          .filter(name => entry.path !== '' || name !== 'objects').sort()
        const actual: string[] = []
        for (const name of await this.#directoryContents(path)) {
          if (entry.path === '' && name === 'objects') continue
          const child = sourcePath(join(path, name))
          if (selected(child) && selected(await scanningIO.resolveRule(child))) actual.push(name)
        }
        actual.sort()
        if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('repository directory changed after capture')
      }
    }
    const objects = await this.#objects({
      cwd: root, gitDirectory: root, ...(signal ? { signal } : {}),
    })
    if (JSON.stringify(objects) !== JSON.stringify(repository.objects)) throw new Error('repository objects changed after capture')
  }

  async #objects(request: GitRequest): Promise<string[]> {
    const objects: string[] = []
    let tail = ''
    await this.#git.run(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], {
      ...request,
      output: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          tail += chunk.toString('ascii')
          const lines = tail.split('\n')
          tail = lines.pop()!
          for (const line of lines) {
            if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(line)) {
              callback(new Error('invalid Git object inventory'))
              return
            }
            objects.push(line)
          }
          callback()
        },
      }),
    })
    if (tail) throw new Error('incomplete Git object inventory')
    return objects.sort()
  }

  async #directoryContents(path: string): Promise<string[]> {
    const names: string[] = []
    for await (const name of scanningIO.children(sourcePath(path))) names.push(name)
    return names.sort()
  }
}
