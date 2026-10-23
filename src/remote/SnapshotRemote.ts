import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { errorCode } from '../filesystem/scanning-utils.ts'
import GitProcess, { type GitRequest } from '../git/GitProcess.ts'
import SnapshotReader from '../snapshot/SnapshotReader.ts'
import SnapshotStore from '../snapshot/SnapshotStore.ts'
import type ObjectStore from '../storage/ObjectStore.ts'
import RemoteState, { type ObjectFormat, type RemoteReference, type RemoteStoreState } from './RemoteState.ts'

export interface PushResult {
  readonly snapshot: string
  readonly changed: boolean
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

/** Splits streamed Git output into lines without the buffered-output limit. */
function lines(onLine: (line: string) => void): Writable {
  let pending = ''
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const parts = (pending + chunk.toString('utf8')).split('\n')
      pending = parts.pop()!
      for (const part of parts) if (part) onLine(part)
      callback()
    },
    final(callback) {
      if (pending) onLine(pending)
      callback()
    },
  })
}

/**
 * Publishes every object of every local store as encrypted Git packs and recovers them.
 * Remote: immutable packs/idx per store, immutable content-addressed states, and a
 * mutable `HEAD` naming the current state, replaced last. One writer per remote.
 */
export default class SnapshotRemote {
  static readonly maxPackSize = '128m'

  readonly #local: SnapshotStore
  readonly #cache: string

  constructor(
    readonly root: string,
    private readonly objects: ObjectStore,
    readonly url: string,
    private readonly git = new GitProcess(),
  ) {
    this.#local = new SnapshotStore(root, git)
    this.#cache = join(root, '.bak', 'cache', 'remote', createHash('sha256').update(url).digest('hex').slice(0, 16))
  }

  async push(signal?: AbortSignal): Promise<PushResult> {
    await this.#local.checkStorage(signal)
    const snapshot = await this.#snapshotRef(signal)
    if (!snapshot) throw new Error('nothing to push; run bak commit first')
    const previous = await SnapshotRemote.#published(this.objects, signal)
    if (previous) await this.#requireAncestor(previous.state.snapshot, snapshot, signal)
    const temporary = join(this.root, '.bak', 'cache', `push-${randomUUID()}`)
    let packs = 0
    let bytes = 0
    try {
      const stores: RemoteStoreState[] = []
      for (const store of await this.#stores(signal)) {
        const published = previous?.state.stores.find(item => item.id === store.id)
        if (published && published.objectFormat !== store.objectFormat) throw new Error(`remote store ${store.id} has another object format`)
        const available = new Set(published?.packs ?? [])
        for (const pack of await this.#cachedPacks(store.id)) {
          if (!available.has(pack) && await this.objects.head(RemoteState.packKey(store.id, pack, 'pack'), signal)) available.add(pack)
        }
        const covered = new Set<string>()
        for (const pack of available) await this.#indexedObjects(store.id, pack, id => covered.add(id), signal)
        const missing: string[] = []
        await this.#run(store.id, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], {
          output: lines(id => { if (!covered.has(id)) missing.push(id) }), ...(signal ? { signal } : {}),
        })
        if (missing.length) {
          const uploaded = await this.#upload(store.id, missing, join(temporary, store.id), signal)
          packs += uploaded.packs.length
          bytes += uploaded.bytes
          for (const pack of uploaded.packs) available.add(pack)
        }
        stores.push({ ...store, packs: [...available].sort(), refs: await this.#refs(store.id, signal) })
      }
      const state: RemoteState = { version: 1, snapshot, previous: previous?.key ?? null, stores }
      const unchanged = previous && previous.state.snapshot === snapshot && packs === 0 &&
        JSON.stringify(previous.state.stores) === JSON.stringify(stores)
      if (unchanged) return { snapshot, changed: false, packs, bytes }
      const encoded = RemoteState.encode(state)
      const key = RemoteState.key(encoded)
      await this.objects.putImmutable(key, encoded, signal)
      const current = await SnapshotRemote.#headKey(this.objects, signal)
      if (current !== (previous?.key ?? undefined)) {
        throw new Error('another writer published to this remote during push; nothing was published')
      }
      await this.objects.replace(RemoteState.headKey, new TextEncoder().encode(key), signal)
      return { snapshot, changed: true, packs, bytes }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  /** Recreates `.bak` from the remote into a folder without one, then verifies recoverability. */
  static async clone(root: string, objects: ObjectStore, url: string, signal?: AbortSignal, git = new GitProcess()): Promise<string> {
    try {
      await stat(join(root, '.bak'))
      throw new Error('clone needs a folder without .bak storage')
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    const published = await SnapshotRemote.#published(objects, signal)
    if (!published) throw new Error(`${url} has no published snapshots`)
    let hadPathspec = true
    try {
      await stat(join(root, SnapshotStore.pathspecFileName))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      hadPathspec = false
    }
    const local = new SnapshotStore(root, git)
    await local.init(signal)
    const remote = new SnapshotRemote(root, objects, url, git)
    for (const store of published.state.stores) {
      if (store.id !== 'main') await local.initRepositoryStore(store.id, store.objectFormat, signal)
      for (const pack of store.packs) await remote.#fetchPack(store.id, pack, signal)
      for (const reference of store.refs) await remote.#run(store.id, ['update-ref', reference.name, reference.oid], signal ? { signal } : {})
      await remote.#run(store.id, ['fsck', '--connectivity-only', '--no-dangling', '--no-progress'], signal ? { signal } : {})
    }
    await remote.#verifyManifest(published.state, signal)
    if (!hadPathspec) {
      const manifest = await new SnapshotReader(root).manifest(published.state.snapshot, signal)
      await writeFile(join(root, SnapshotStore.pathspecFileName), manifest.pathspec)
    }
    return published.state.snapshot
  }

  static async #headKey(objects: ObjectStore, signal?: AbortSignal): Promise<string | undefined> {
    const bytes = await objects.get(RemoteState.headKey, signal)
    if (!bytes) return undefined
    const key = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!RemoteState.isKey(key)) throw new Error('remote HEAD is invalid')
    return key
  }

  static async #published(objects: ObjectStore, signal?: AbortSignal): Promise<Published | undefined> {
    const key = await SnapshotRemote.#headKey(objects, signal)
    if (!key) return undefined
    const bytes = await objects.get(key, signal)
    if (!bytes) throw new Error(`remote HEAD names missing state ${key}`)
    if (RemoteState.key(bytes) !== key) throw new Error(`remote state ${key} does not match its name`)
    return { key, state: RemoteState.parse(bytes) }
  }

  #run(store: string, args: readonly string[], request: Partial<GitRequest>) {
    return this.git.run(args, { cwd: this.root, gitDirectory: this.#local.directory(store), ...request })
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

  async #cachedPacks(store: string): Promise<string[]> {
    try {
      return (await readdir(join(this.#cache, store))).filter(name => name.endsWith('.idx')).map(name => name.slice(0, -'.idx'.length))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
  }

  /** Reads object ids from the pack's idx, downloading it into the disposable cache when absent. */
  async #indexedObjects(store: string, pack: string, onObject: (id: string) => void, signal?: AbortSignal): Promise<void> {
    const path = join(this.#cache, store, `${pack}.idx`)
    let index: Buffer
    try {
      index = await readFile(path)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const bytes = await this.objects.get(RemoteState.packKey(store, pack, 'idx'), signal)
      if (!bytes) throw new Error(`remote pack index ${store}/${pack} is missing`)
      index = Buffer.from(bytes)
      await mkdir(join(this.#cache, store), { recursive: true })
      await writeFile(path, index)
    }
    await this.#run(store, ['show-index'], {
      input: index, output: lines(line => onObject(line.split(' ')[1]!)), ...(signal ? { signal } : {}),
    })
  }

  async #upload(store: string, objects: readonly string[], directory: string, signal?: AbortSignal) {
    await mkdir(directory, { recursive: true })
    const packs: string[] = []
    let bytes = 0
    await this.#run(store, ['pack-objects', `--max-pack-size=${SnapshotRemote.maxPackSize}`, '-q', join(directory, 'pack')], {
      input: `${objects.join('\n')}\n`, output: lines(hash => packs.push(`pack-${hash}`)), ...(signal ? { signal } : {}),
    })
    for (const pack of packs) {
      for (const extension of ['pack', 'idx'] as const) {
        const contents = await readFile(join(directory, `${pack}.${extension}`))
        const key = RemoteState.packKey(store, pack, extension)
        await this.objects.putImmutable(key, contents, signal)
        if ((await this.objects.head(key, signal))?.size !== contents.byteLength) throw new Error(`remote ${key} did not verify after upload`)
        bytes += contents.byteLength
      }
      await mkdir(join(this.#cache, store), { recursive: true })
      await copyFile(join(directory, `${pack}.idx`), join(this.#cache, store, `${pack}.idx`))
    }
    return { packs, bytes }
  }

  /** index-pack rebuilds the idx and verifies every object rather than trusting the remote idx. */
  async #fetchPack(store: string, pack: string, signal?: AbortSignal): Promise<void> {
    const bytes = await this.objects.get(RemoteState.packKey(store, pack, 'pack'), signal)
    if (!bytes) throw new Error(`remote pack ${store}/${pack} is missing`)
    const result = await this.#run(store, ['index-pack', '--stdin'], { input: bytes, ...(signal ? { signal } : {}) })
    const [kind, hash] = result.stdout.toString().trim().split('\t')
    if ((kind !== 'pack' && kind !== 'keep') || `pack-${hash}` !== pack) throw new Error(`remote pack ${store}/${pack} did not verify`)
    if (kind === 'keep') await unlink(join(this.#local.directory(store), 'objects', 'pack', `${pack}.keep`))
  }

  async #verifyManifest(state: RemoteState, signal?: AbortSignal): Promise<void> {
    const manifest = await new SnapshotReader(this.root).manifest(state.snapshot, signal)
    const required = new Map<string, Set<string>>()
    const add = (store: string, id: string) => required.set(store, (required.get(store) ?? new Set()).add(id))
    for (const entry of manifest.entries) for (const reference of entry.objects) add(reference.repository, reference.oid)
    for (const mount of manifest.mounts) add(mount.repository, mount.commit)
    for (const repository of manifest.repositories) {
      add(repository.identity.id, repository.adminCommit)
      for (const id of repository.objects) add(repository.identity.id, id)
    }
    for (const [store, ids] of required) {
      if (!state.stores.some(item => item.id === store)) throw new Error(`remote lacks store ${store} needed by the snapshot`)
      const missing: string[] = []
      await this.#run(store, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
        input: `${[...ids].join('\n')}\n`, output: lines(line => { if (line.endsWith(' missing')) missing.push(line) }),
        ...(signal ? { signal } : {}),
      })
      if (missing.length) throw new Error(`recovered store ${store} lacks ${missing.length} snapshot objects`)
    }
  }
}
