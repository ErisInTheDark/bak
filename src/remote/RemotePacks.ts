import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { errorCode } from '../filesystem/scanning-utils.ts'
import GitProcess, { type GitRequest, type ObjectFormat } from '../git/GitProcess.ts'
import PackIndex from '../git/PackIndex.ts'
import PackObjectReader, { type GitObject } from '../git/PackObjectReader.ts'
import type ObjectStore from '../storage/ObjectStore.ts'
import RemoteState, { type PackKind } from './RemoteState.ts'

export interface InventoryObject {
  readonly oid: string
  /** On-disk size in the source store; batches use it to bound pack size. */
  readonly size: number
}

export interface RemotePacksOptions {
  readonly packSize?: number
  readonly git?: GitProcess
}

/** Splits streamed Git output into lines without the buffered-output limit. */
export function lines(onLine: (line: string) => void): Writable {
  let pending = ''
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const parts = (pending + chunk.toString('utf8')).split('\n')
      pending = parts.pop()!
      try {
        for (const part of parts) if (part) onLine(part)
        callback()
      } catch (error) {
        callback(error as Error)
      }
    },
    final(callback) {
      try {
        if (pending) onLine(pending)
        callback()
      } catch (error) {
        callback(error as Error)
      }
    },
  })
}

/**
 * Encrypted Git packs of one backup folder's remote. Owns pack keys, the disposable
 * index cache in `.bak/cache/remote/<url hash>/`, batched uploads and lazy object reads.
 */
export default class RemotePacks {
  static readonly defaultPackSize = 128 * 1024 * 1024

  readonly packSize: number
  readonly git: GitProcess
  readonly #cache: string
  readonly #indexes = new Map<string, Promise<PackIndex>>()
  readonly #sizes = new Map<string, Promise<number>>()

  constructor(readonly root: string, readonly objects: ObjectStore, readonly url: string, options: RemotePacksOptions = {}) {
    this.packSize = options.packSize ?? RemotePacks.defaultPackSize
    this.git = options.git ?? new GitProcess()
    this.#cache = join(root, '.bak', 'cache', 'remote', createHash('sha256').update(url).digest('hex').slice(0, 16))
  }

  /** Every object in a Git directory with its on-disk size, in pack order for delta locality. */
  async inventory(gitDirectory: string, signal?: AbortSignal): Promise<InventoryObject[]> {
    const objects: InventoryObject[] = []
    await this.git.run(['cat-file', '--batch-all-objects', '--unordered', '--batch-check=%(objectname) %(objectsize:disk)'], {
      cwd: this.root, gitDirectory,
      output: lines(line => {
        const [oid, size] = line.split(' ')
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid!) || !/^\d+$/u.test(size!)) throw new Error('invalid Git object inventory')
        objects.push({ oid: oid!, size: Number(size) })
      }),
      ...(signal ? { signal } : {}),
    })
    return objects
  }

  /** Index of a remote pack, from the cache or downloaded into it. */
  index(store: string, kind: PackKind, pack: string, format: ObjectFormat, signal?: AbortSignal): Promise<PackIndex> {
    const id = `${store}/${kind}/${pack}`
    let pending = this.#indexes.get(id)
    if (!pending) {
      pending = this.#loadIndex(store, kind, pack, format, signal)
      pending.catch(() => { if (this.#indexes.get(id) === pending) this.#indexes.delete(id) })
      this.#indexes.set(id, pending)
    }
    return pending
  }

  async #loadIndex(store: string, kind: PackKind, pack: string, format: ObjectFormat, signal?: AbortSignal): Promise<PackIndex> {
    const path = join(this.#cache, store, kind, `${pack}.idx`)
    try {
      return PackIndex.parse(await readFile(path), format)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    const bytes = await this.objects.get(RemoteState.packKey(store, kind, pack, 'idx'), signal)
    if (!bytes) throw new Error(`remote pack index ${store}/${kind}/${pack} is missing`)
    const index = PackIndex.parse(bytes, format)
    await mkdir(join(this.#cache, store, kind), { recursive: true })
    await writeFile(path, bytes)
    return index
  }

  /** Object ids covered by the given packs. */
  async covered(store: string, kind: PackKind, packs: Iterable<string>, format: ObjectFormat, signal?: AbortSignal): Promise<Set<string>> {
    const covered = new Set<string>()
    for (const pack of packs) for (const oid of (await this.index(store, kind, pack, format, signal)).oids) covered.add(oid)
    return covered
  }

  /** Packs this folder uploaded (cached indexes) that are not in `known` but still exist remotely. */
  async orphans(store: string, kind: PackKind, known: ReadonlySet<string>, signal?: AbortSignal): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(join(this.#cache, store, kind))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
    const orphans: string[] = []
    for (const name of names.filter(name => name.endsWith('.idx')).map(name => name.slice(0, -'.idx'.length)).sort()) {
      if (!known.has(name) && await this.objects.head(RemoteState.packKey(store, kind, name, 'pack'), signal)) orphans.push(name)
    }
    return orphans
  }

  /**
   * Packs `objects` from `gitDirectory` in batches of about `packSize`, so temporary disk stays
   * bounded, and uploads each pack then its index. Returns the new pack names.
   */
  async upload(
    store: string, kind: PackKind, format: ObjectFormat, gitDirectory: string, objects: readonly InventoryObject[], signal?: AbortSignal,
  ): Promise<{ packs: string[], bytes: number }> {
    const result = { packs: [] as string[], bytes: 0 }
    let batch: InventoryObject[] = []
    let size = 0
    const flush = async () => {
      if (batch.length) {
        const uploaded = await this.#uploadBatch(store, kind, format, gitDirectory, batch, signal)
        result.packs.push(...uploaded.packs)
        result.bytes += uploaded.bytes
      }
      batch = []
      size = 0
    }
    for (const object of objects) {
      if (batch.length && size + object.size > this.packSize) await flush()
      batch.push(object)
      size += object.size
    }
    await flush()
    return result
  }

  async #uploadBatch(
    store: string, kind: PackKind, format: ObjectFormat, gitDirectory: string, objects: readonly InventoryObject[], signal?: AbortSignal,
  ): Promise<{ packs: string[], bytes: number }> {
    const directory = join(this.root, '.bak', 'cache', `upload-${randomUUID()}`)
    await mkdir(directory, { recursive: true })
    try {
      const request: GitRequest = { cwd: this.root, gitDirectory, ...(signal ? { signal } : {}) }
      const packs: string[] = []
      await this.git.run(['pack-objects', '--delta-base-offset', '-q', join(directory, 'pack')], {
        ...request, input: `${objects.map(object => object.oid).join('\n')}\n`, output: lines(hash => packs.push(`pack-${hash}`)),
      })
      const indexed = new Set<string>()
      const contents = new Map<string, { pack: Buffer, index: Buffer }>()
      for (const pack of packs) {
        const index = await readFile(join(directory, `${pack}.idx`))
        for (const oid of PackIndex.parse(index, format).oids) indexed.add(oid)
        contents.set(pack, { pack: await readFile(join(directory, `${pack}.pack`)), index })
      }
      const absent = objects.filter(object => !indexed.has(object.oid))
      if (absent.length) throw new Error(`git pack-objects omitted ${absent.length} requested objects from ${store}`)
      let total = 0
      for (const [pack, { pack: bytes, index }] of contents) {
        await this.objects.putImmutable(RemoteState.packKey(store, kind, pack, 'pack'), bytes, signal)
        await this.objects.putImmutable(RemoteState.packKey(store, kind, pack, 'idx'), index, signal)
        await mkdir(join(this.#cache, store, kind), { recursive: true })
        await writeFile(join(this.#cache, store, kind, `${pack}.idx`), index)
        total += bytes.byteLength + index.byteLength
      }
      return { packs, bytes: total }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** Reads one object from the first listed content pack holding it; its hash is verified. */
  async read(store: string, packs: readonly string[], oid: string, format: ObjectFormat, signal?: AbortSignal): Promise<GitObject> {
    signal?.throwIfAborted()
    for (const pack of packs) {
      const index = await this.index(store, 'content', pack, format, signal)
      if (!index.has(oid)) continue
      const key = RemoteState.packKey(store, 'content', pack, 'pack')
      let size = this.#sizes.get(key)
      if (!size) {
        size = this.objects.head(key, signal).then(head => {
          if (!head) throw new Error(`remote pack ${store}/${pack} is missing`)
          return head.size
        })
        size.catch(() => { if (this.#sizes.get(key) === size) this.#sizes.delete(key) })
        this.#sizes.set(key, size)
      }
      return new PackObjectReader(index, await size, range => this.objects.getRange(key, range, signal)).object(oid)
    }
    throw new Error(`object ${oid} of store ${store} is in no remote pack of this snapshot`)
  }

  /**
   * Downloads a pack into `gitDirectory`. `index-pack` verifies every object, and the rebuilt
   * index must list the same objects at the same offsets as the remote one lazy reads rely on.
   */
  async fetch(store: string, kind: PackKind, pack: string, gitDirectory: string, format: ObjectFormat, signal?: AbortSignal): Promise<number> {
    const bytes = await this.objects.get(RemoteState.packKey(store, kind, pack, 'pack'), signal)
    if (!bytes) throw new Error(`remote pack ${store}/${kind}/${pack} is missing`)
    const result = await this.git.run(['index-pack', '--stdin'], {
      cwd: this.root, gitDirectory, input: bytes, ...(signal ? { signal } : {}),
    })
    const [state, hash] = result.stdout.toString().trim().split('\t')
    if ((state !== 'pack' && state !== 'keep') || `pack-${hash}` !== pack) throw new Error(`remote pack ${store}/${kind}/${pack} did not verify`)
    const directory = join(gitDirectory, 'objects', 'pack')
    if (state === 'keep') await unlink(join(directory, `${pack}.keep`))
    const rebuilt = PackIndex.parse(await readFile(join(directory, `${pack}.idx`)), format)
    const remote = await this.index(store, kind, pack, format, signal)
    if (rebuilt.packChecksum !== remote.packChecksum || rebuilt.oids.length !== remote.oids.length ||
      rebuilt.oids.some(oid => rebuilt.offset(oid) !== remote.offset(oid))) {
      throw new Error(`remote index of ${store}/${kind}/${pack} does not match its pack`)
    }
    return bytes.byteLength
  }
}
