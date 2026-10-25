import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errorCode } from '../filesystem/scanning-utils.ts'
import type { GitRequest, ObjectFormat } from '../git/GitProcess.ts'
import SnapshotReader from '../snapshot/SnapshotReader.ts'
import SnapshotStore from '../snapshot/SnapshotStore.ts'
import type { SnapshotPacks } from '../snapshot/snapshot-format.ts'
import RemotePacks, { lines } from './RemotePacks.ts'
import RemoteState, { type RemoteReference, type RemoteStoreState } from './RemoteState.ts'

export interface PushResult {
  readonly snapshot: string
  readonly changed: boolean
  readonly packs: number
  readonly bytes: number
}

export interface VerifyResult {
  readonly snapshot: string
  readonly packs: number
  readonly bytes: number
}

interface LocalStore {
  readonly id: string
  readonly objectFormat: ObjectFormat
}

interface Published {
  readonly key: string
  readonly state: RemoteState
}

/**
 * Publishes and recovers a backup folder. Commit already uploaded captured contents as
 * content packs; push uploads the folder's local metadata objects as metadata packs,
 * writes an immutable state and replaces the mutable `HEAD` last. One writer per remote.
 */
export default class SnapshotRemote {
  readonly #local: SnapshotStore

  constructor(private readonly packs: RemotePacks) {
    this.#local = new SnapshotStore(packs.root, packs.git)
  }

  get root(): string {
    return this.packs.root
  }

  async push(signal?: AbortSignal): Promise<PushResult> {
    await this.#local.checkStorage(signal)
    const snapshot = await this.#snapshotRef(signal)
    if (!snapshot) throw new Error('nothing to push; run bak commit first')
    const previous = await SnapshotRemote.#published(this.packs, signal)
    if (previous) await this.#requireAncestor(previous.state.snapshot, snapshot, signal)
    const reader = new SnapshotReader(this.root)
    const content = await reader.packs(snapshot, signal)
    if (content.remote !== this.packs.url) throw new Error(`snapshot contents live on ${content.remote}, not ${this.packs.url}`)
    const before = previous ? await reader.packs(previous.state.snapshot, signal) : null
    for (const [store, packs] of Object.entries(content.stores)) {
      const known = new Set(before?.stores[store] ?? [])
      for (const pack of packs.filter(pack => !known.has(pack))) {
        for (const extension of ['pack', 'idx'] as const) {
          if (!await this.packs.objects.head(RemoteState.packKey(store, 'content', pack, extension), signal)) {
            throw new Error(`content pack ${store}/${pack}.${extension} is missing from ${this.packs.url}; nothing was published`)
          }
        }
      }
    }
    let packs = 0
    let bytes = 0
    const stores: RemoteStoreState[] = []
    for (const store of await this.#stores(signal)) {
      const published = previous?.state.stores.find(item => item.id === store.id)
      if (published && published.objectFormat !== store.objectFormat) throw new Error(`remote store ${store.id} has another object format`)
      const known = new Set(published?.metadata ?? [])
      for (const orphan of await this.packs.orphans(store.id, 'metadata', known, signal)) known.add(orphan)
      const covered = await this.packs.covered(store.id, 'metadata', known, store.objectFormat, signal)
      const directory = this.#local.directory(store.id)
      const missing = (await this.packs.inventory(directory, signal)).filter(object => !covered.has(object.oid))
      const uploaded = await this.packs.upload(store.id, 'metadata', store.objectFormat, directory, missing, signal)
      packs += uploaded.packs.length
      bytes += uploaded.bytes
      for (const pack of uploaded.packs) known.add(pack)
      stores.push({ ...store, metadata: [...known].sort(), refs: await this.#refs(store.id, signal) })
    }
    const state: RemoteState = { version: 2, snapshot, previous: previous?.key ?? null, stores }
    if (previous && previous.state.snapshot === snapshot && packs === 0 &&
      JSON.stringify(previous.state.stores) === JSON.stringify(stores)) {
      return { snapshot, changed: false, packs, bytes }
    }
    const encoded = RemoteState.encode(state)
    const key = RemoteState.key(encoded)
    await this.packs.objects.putImmutable(key, encoded, signal)
    const current = await SnapshotRemote.#headKey(this.packs, signal)
    if (current !== (previous?.key ?? undefined)) {
      throw new Error('another writer published to this remote during push; nothing was published')
    }
    await this.packs.objects.replace(RemoteState.headKey, new TextEncoder().encode(key), signal)
    return { snapshot, changed: true, packs, bytes }
  }

  /**
   * Recreates `.bak` metadata from the remote into `packs.root`, which must lack `.bak`,
   * then checks every object the latest snapshot needs is local or in its content packs.
   */
  static async clone(packs: RemotePacks, signal?: AbortSignal): Promise<string> {
    const root = packs.root
    try {
      await stat(join(root, '.bak'))
      throw new Error('clone needs a folder without .bak storage')
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    const published = await SnapshotRemote.#published(packs, signal)
    if (!published) throw new Error(`${packs.url} has no published snapshots`)
    let hadPathspec = true
    try {
      await stat(join(root, SnapshotStore.pathspecFileName))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      hadPathspec = false
    }
    await SnapshotRemote.#restore(packs, published.state, signal)
    await new SnapshotRemote(packs).#checkRecoverable(published.state, signal)
    if (!hadPathspec) {
      const manifest = await new SnapshotReader(root).manifest(published.state.snapshot, signal)
      await writeFile(join(root, SnapshotStore.pathspecFileName), manifest.pathspec)
    }
    return published.state.snapshot
  }

  /**
   * Proves the published snapshot is recoverable from the remote alone: restores metadata into a
   * scratch folder, then downloads every content pack one at a time and verifies every object.
   */
  async verify(signal?: AbortSignal): Promise<VerifyResult> {
    await this.#local.checkStorage(signal)
    const published = await SnapshotRemote.#published(this.packs, signal)
    if (!published) throw new Error(`${this.packs.url} has no published snapshots`)
    const scratch = join(this.root, '.bak', 'cache', `fsck-${randomUUID()}`)
    try {
      const packs = new RemotePacks(scratch, this.packs.objects, this.packs.url, { git: this.packs.git })
      let bytes = await SnapshotRemote.#restore(packs, published.state, signal)
      let count = published.state.stores.reduce((total, store) => total + store.metadata.length, 0)
      const content = await new SnapshotRemote(packs).#checkRecoverable(published.state, signal)
      for (const [store, list] of Object.entries(content.stores)) {
        const format = published.state.stores.find(item => item.id === store)!.objectFormat
        const directory = join(scratch, 'content', `${store}.git`)
        await mkdir(directory, { recursive: true })
        await packs.git.run(['init', '--bare', '-q', '--template=', `--object-format=${format}`, directory], { cwd: scratch, ...(signal ? { signal } : {}) })
        for (const pack of list) {
          bytes += await packs.fetch(store, 'content', pack, directory, format, signal)
          count++
          const packDirectory = join(directory, 'objects', 'pack')
          for (const name of await readdir(packDirectory)) if (name.startsWith(`${pack}.`)) await unlink(join(packDirectory, name))
        }
      }
      return { snapshot: published.state.snapshot, packs: count, bytes }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** Initialises storage in `packs.root` and restores every store's metadata packs and refs. */
  static async #restore(packs: RemotePacks, state: RemoteState, signal?: AbortSignal): Promise<number> {
    const local = new SnapshotStore(packs.root, packs.git)
    await local.init(signal)
    let bytes = 0
    for (const store of state.stores) {
      if (store.id !== 'main') await local.initRepositoryStore(store.id, store.objectFormat, signal)
      const directory = local.directory(store.id)
      for (const pack of store.metadata) bytes += await packs.fetch(store.id, 'metadata', pack, directory, store.objectFormat, signal)
      for (const reference of store.refs) {
        await packs.git.run(['update-ref', reference.name, reference.oid], { cwd: packs.root, gitDirectory: directory, ...(signal ? { signal } : {}) })
      }
    }
    return bytes
  }

  static async #headKey(packs: RemotePacks, signal?: AbortSignal): Promise<string | undefined> {
    const bytes = await packs.objects.get(RemoteState.headKey, signal)
    if (!bytes) return undefined
    const key = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!RemoteState.isKey(key)) throw new Error('remote HEAD is invalid')
    return key
  }

  static async #published(packs: RemotePacks, signal?: AbortSignal): Promise<Published | undefined> {
    const key = await SnapshotRemote.#headKey(packs, signal)
    if (!key) return undefined
    const bytes = await packs.objects.get(key, signal)
    if (!bytes) throw new Error(`remote HEAD names missing state ${key}`)
    if (RemoteState.key(bytes) !== key) throw new Error(`remote state ${key} does not match its name`)
    return { key, state: RemoteState.parse(bytes) }
  }

  #run(store: string, args: readonly string[], request: Partial<GitRequest>) {
    return this.packs.git.run(args, { cwd: this.root, gitDirectory: this.#local.directory(store), ...request })
  }

  async #snapshotRef(signal?: AbortSignal): Promise<string | undefined> {
    const head = await this.#run('main', ['rev-parse', '--verify', '--quiet', RemoteState.snapshotsRef], {
      acceptExitCodes: [0, 1], ...(signal ? { signal } : {}),
    })
    return head.code === 0 ? head.stdout.toString().trim() : undefined
  }

  async #requireAncestor(published: string, local: string, signal?: AbortSignal): Promise<void> {
    const present = await this.#run('main', ['cat-file', '-e', `${published}^{commit}`], {
      acceptExitCodes: [0, 1, 128], ...(signal ? { signal } : {}),
    })
    const ancestor = present.code === 0 && (await this.#run('main', ['merge-base', '--is-ancestor', published, local], {
      acceptExitCodes: [0, 1], ...(signal ? { signal } : {}),
    })).code === 0
    if (!ancestor) throw new Error(`the remote has snapshot ${published.slice(0, 12)} which this folder lacks; refusing to hide it`)
  }

  async #stores(signal?: AbortSignal): Promise<LocalStore[]> {
    const ids = ['main', ...(await readdir(join(this.root, '.bak', 'repos')))
      .filter(name => name.endsWith('.git')).map(name => name.slice(0, -'.git'.length)).sort()]
    const stores: LocalStore[] = []
    for (const id of ids) {
      const format = (await this.#run(id, ['rev-parse', '--show-object-format'], signal ? { signal } : {})).stdout.toString().trim()
      if (format !== 'sha1' && format !== 'sha256') throw new Error(`store ${id} has unsupported object format ${format}`)
      stores.push({ id, objectFormat: format })
    }
    return stores
  }

  async #refs(store: string, signal?: AbortSignal): Promise<RemoteReference[]> {
    const refs: RemoteReference[] = []
    await this.#run(store, ['for-each-ref', '--format=%(objectname) %(refname)'], {
      output: lines(line => {
        const [oid, name] = line.split(' ')
        refs.push({ name: name!, oid: oid! })
      }), ...(signal ? { signal } : {}),
    })
    return refs.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  }

  /** Every object the snapshot's manifest references must be local or in its content packs. */
  async #checkRecoverable(state: RemoteState, signal?: AbortSignal): Promise<SnapshotPacks> {
    const reader = new SnapshotReader(this.root)
    const manifest = await reader.manifest(state.snapshot, signal)
    const content = await reader.packs(state.snapshot, signal)
    if (content.remote !== this.packs.url) throw new Error(`snapshot contents live on ${content.remote}, not ${this.packs.url}`)
    const required = new Map<string, Set<string>>()
    const add = (store: string, id: string) => required.set(store, (required.get(store) ?? new Set()).add(id))
    for (const entry of manifest.entries) for (const reference of entry.objects) add(reference.repository, reference.oid)
    for (const mount of manifest.mounts) add(mount.repository, mount.commit)
    for (const repository of manifest.repositories) {
      add(repository.identity.id, repository.adminCommit)
      for (const id of repository.objects) add(repository.identity.id, id)
      for (const entry of repository.administrative) if (entry.oid) add(repository.identity.id, entry.oid)
    }
    for (const store of Object.keys(content.stores)) {
      if (!state.stores.some(item => item.id === store)) throw new Error(`remote lacks store ${store} listed by the snapshot`)
    }
    for (const [store, ids] of required) {
      const published = state.stores.find(item => item.id === store)
      if (!published) throw new Error(`remote lacks store ${store} needed by the snapshot`)
      const missing: string[] = []
      await this.#run(store, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
        input: `${[...ids].join('\n')}\n`,
        output: lines(line => { if (line.endsWith(' missing')) missing.push(line.split(' ')[0]!) }),
        ...(signal ? { signal } : {}),
      })
      if (!missing.length) continue
      const covered = await this.packs.covered(store, 'content', content.stores[store] ?? [], published.objectFormat, signal)
      const absent = missing.filter(oid => !covered.has(oid))
      if (absent.length) throw new Error(`snapshot needs ${absent.length} objects of store ${store} that no remote pack holds`)
    }
    return content
  }
}
