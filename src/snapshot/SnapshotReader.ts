import { join } from 'node:path'
import { Writable } from 'node:stream'
import GitProcess from '../git/GitProcess.ts'
import { ObjectReference, SnapshotManifest } from './snapshot-format.ts'
import SnapshotGraph from './SnapshotGraph.ts'

export interface SnapshotReadTarget {
  readonly manifest: SnapshotManifest
  readonly entry: SnapshotManifest['entries'][number] | null
  readonly children: readonly string[]
}

export default class SnapshotReader {
  constructor(readonly root: string) {}

  async manifest(snapshot: string, signal?: AbortSignal): Promise<SnapshotManifest> {
    const git = new GitProcess()
    const request = {
      cwd: this.root, gitDirectory: join(this.root, '.bak', 'main.git'),
      ...(signal ? { signal } : {}),
    }
    const commit = ObjectReference.oid((await git.run([
      'rev-parse', '--verify', '--end-of-options', `${snapshot}^{commit}`,
    ], request)).stdout.toString(), 'sha1')
    const chunks: Buffer[] = []
    await git.run(['cat-file', 'blob', `${commit}:.bak-meta/manifest.json`], {
      ...request,
      output: new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(Buffer.from(chunk)); done() } }),
    })
    return SnapshotManifest.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  }

  async resolve(snapshot: string, requested: string, signal?: AbortSignal): Promise<SnapshotReadTarget> {
    const manifest = await this.manifest(snapshot, signal)
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
      manifest, entry,
      children: [...new Set([
        ...manifest.links.filter(link => link.parent === id).map(link => link.name), ...exposedChildren,
      ])].sort(),
    }
  }

  async stream(snapshot: string, path: string, output: Writable, signal?: AbortSignal): Promise<void> {
    await this.streamTarget(await this.resolve(snapshot, path, signal), output, signal)
  }

  async streamTarget(target: SnapshotReadTarget, output: Writable, signal?: AbortSignal): Promise<void> {
    if (target.entry?.kind !== 'file') throw new Error('snapshot path is a directory')
    const reference = target.entry.objects[0]
    if (!ObjectReference.is(reference)) throw new Error('snapshot file has no valid captured object')
    const directory = reference.repository === 'main'
      ? join(this.root, '.bak', 'main.git')
      : join(this.root, '.bak', 'repos', `${reference.repository}.git`)
    await new GitProcess().run(['cat-file', 'blob', reference.oid], {
      cwd: this.root, gitDirectory: directory, output, ...(signal ? { signal } : {}),
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
