import { join } from 'node:path'
import { Writable } from 'node:stream'
import GitProcess, { type GitRequest, type ObjectFormat } from '../git/GitProcess.ts'
import type RemotePacks from '../remote/RemotePacks.ts'
import { ObjectReference, SnapshotManifest, SnapshotPacks } from './snapshot-format.ts'
import SnapshotGraph from './SnapshotGraph.ts'

export interface SnapshotReadTarget {
  /** Resolved snapshot commit. */
  readonly commit: string
  readonly manifest: SnapshotManifest
  readonly entry: SnapshotManifest['entries'][number] | null
  readonly children: readonly string[]
}

/**
 * Reads stored snapshots. Metadata is local; file contents are read lazily from the
 * remote content packs listed by the snapshot, which needs `packs`.
 */
export default class SnapshotReader {
  readonly #git = new GitProcess()

  constructor(readonly root: string, private readonly remote?: RemotePacks) {}

  #request(signal?: AbortSignal): GitRequest {
    return { cwd: this.root, gitDirectory: join(this.root, '.bak', 'main.git'), ...(signal ? { signal } : {}) }
  }

  async #commit(snapshot: string, signal?: AbortSignal): Promise<string> {
    return ObjectReference.oid((await this.#git.run([
      'rev-parse', '--verify', '--end-of-options', `${snapshot}^{commit}`,
    ], this.#request(signal))).stdout.toString(), 'sha1')
  }

  async #text(commit: string, path: string, signal?: AbortSignal): Promise<string> {
    const chunks: Buffer[] = []
    await this.#git.run(['cat-file', 'blob', `${commit}:${path}`], {
      ...this.#request(signal),
      output: new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(Buffer.from(chunk)); done() } }),
    })
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  }

  async manifest(snapshot: string, signal?: AbortSignal): Promise<SnapshotManifest> {
    return SnapshotManifest.parse(await this.#text(await this.#commit(snapshot, signal), '.bak-meta/manifest.json', signal))
  }

  async packs(snapshot: string, signal?: AbortSignal): Promise<SnapshotPacks> {
    return SnapshotPacks.parse(await this.#text(await this.#commit(snapshot, signal), SnapshotPacks.path, signal))
  }

  async resolve(snapshot: string, requested: string, signal?: AbortSignal): Promise<SnapshotReadTarget> {
    const commit = await this.#commit(snapshot, signal)
    const manifest = await this.manifest(commit, signal)
    const path = requested.startsWith('repo:/') ? `repos/${requested.slice('repo:/'.length)}` : requested
    const parts = path.split('/').filter(Boolean)
    if (parts.some(part => part === '.' || part === '..' || part.includes('\0'))) throw new Error('invalid snapshot path')
    const normal = parts.join('/')
    const roots = [
      ...manifest.roots.map(root => ({ path: SnapshotGraph.path(root.destination), id: root.id })),
      ...manifest.mounts.map(mount => ({ path: `repos/${mount.name}`, id: mount.entry })),
    ]
    const rootAt = (path: string) => {
      const matches = roots.filter(root => root.path === path)
      if (matches.some(match => match.id !== matches[0]!.id)) throw new Error('ambiguous snapshot root')
      return matches[0]?.id
    }
    let id = rootAt('')
    let prefix = ''
    for (const name of parts) {
      prefix = prefix ? `${prefix}/${name}` : name
      const links = manifest.links.filter(link => link.parent === id && link.name === name)
      if (links.some(link => link.id !== links[0]!.id)) throw new Error('ambiguous snapshot directory entry')
      const declared = rootAt(prefix)
      const child = links[0]?.id
      if (declared && child && declared !== child) throw new Error('conflicting snapshot exposure')
      id = declared ?? child
      if (!id && !roots.some(root => root.path.startsWith(prefix + '/'))) throw new Error('snapshot path does not exist')
    }
    const entry = id ? manifest.entries.find(entry => entry.id === id) ?? null : null
    if (id && !entry) throw new Error('snapshot entry is missing')
    const exposedChildren = roots.filter(root => root.path !== normal && (!normal || root.path.startsWith(normal + '/')))
      .map(root => root.path.slice(normal ? normal.length + 1 : 0).split('/')[0]!)
    return {
      commit, manifest, entry,
      children: [...new Set([
        ...manifest.links.filter(link => link.parent === id).map(link => link.name), ...exposedChildren,
      ])].sort(),
    }
  }

  async stream(snapshot: string, path: string, output: Writable, signal?: AbortSignal): Promise<void> {
    await this.streamTarget(await this.resolve(snapshot, path, signal), output, signal)
  }

  /** Local objects stream; remote objects are read whole, then written. */
  async streamTarget(target: SnapshotReadTarget, output: Writable, signal?: AbortSignal): Promise<void> {
    if (target.entry?.kind !== 'file') throw new Error('snapshot path is a directory')
    const reference = target.entry.objects[0]
    if (!ObjectReference.is(reference)) throw new Error('snapshot file has no valid captured object')
    const store = reference.repository
    const request: GitRequest = {
      ...this.#request(signal),
      gitDirectory: store === 'main' ? join(this.root, '.bak', 'main.git') : join(this.root, '.bak', 'repos', `${store}.git`),
    }
    const local = await this.#git.run(['cat-file', '-e', `${reference.oid}^{blob}`], { ...request, acceptExitCodes: [0, 1, 128] })
    if (local.code === 0) {
      await this.#git.run(['cat-file', 'blob', reference.oid], { ...request, output })
      return
    }
    if (!this.remote) throw new Error('snapshot file contents are stored remotely; open the remote to read them')
    const packs = await this.packs(target.commit, signal)
    if (packs.remote !== this.remote.url) throw new Error(`snapshot contents live on ${packs.remote}, not ${this.remote.url}`)
    const format: ObjectFormat | undefined = store === 'main' ? 'sha1'
      : target.manifest.repositories.find(repository => repository.identity.id === store)?.identity.objectFormat
    if (!format) throw new Error(`snapshot file references unknown store ${store}`)
    const object = await this.remote.read(store, packs.stores[store] ?? [], reference.oid, format, signal)
    if (object.type !== 'blob') throw new Error(`snapshot file object ${reference.oid} is a ${object.type}`)
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error)
      output.once('error', fail)
      output.end(object.data, () => {
        output.removeListener('error', fail)
        resolve()
      })
    })
  }

  async read(snapshot: string, path: string, signal?: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = []
    await this.stream(snapshot, path, new Writable({
      write(chunk: Buffer, _encoding, done) { chunks.push(Buffer.from(chunk)); done() },
    }), signal)
    return Buffer.concat(chunks)
  }
}
