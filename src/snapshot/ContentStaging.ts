import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { FileCapture } from '../filesystem/capture-file.ts'
import type { ObjectFormat } from '../git/GitProcess.ts'
import type RemotePacks from '../remote/RemotePacks.ts'
import type { InventoryObject } from '../remote/RemotePacks.ts'
import { ObjectReference, SnapshotPacks } from './snapshot-format.ts'

interface StoreState {
  readonly format: ObjectFormat
  readonly covered: Set<string>
  readonly packs: Set<string>
  staged: number
  staging: string | undefined
}

/**
 * Moves one capture's content into remote content packs. Files stage as loose objects in a
 * throwaway repository that is packed, uploaded and wiped every `packSize` bytes, and
 * repository objects are packed straight from their source, so local disk stays bounded.
 */
export default class ContentStaging {
  readonly #stores = new Map<string, Promise<StoreState>>()
  readonly #directory: string

  constructor(
    private readonly packs: RemotePacks,
    private readonly previous: SnapshotPacks | null,
    transaction: string,
  ) {
    if (previous && previous.remote !== packs.url) {
      throw new Error(`snapshot history lives on ${previous.remote}, not ${packs.url}; changing remotes is not supported`)
    }
    this.#directory = join(packs.root, '.bak', 'staging', transaction)
  }

  /** Streams a file into staging and returns its object id. */
  async file(store: string, format: ObjectFormat, file: FileCapture, signal?: AbortSignal): Promise<string> {
    const state = await this.#store(store, format, signal)
    const staging = state.staging ??= await this.#initStaging(store, format, signal)
    const oid = await FileCapture.read(file, async input => ObjectReference.oid((await this.packs.git.run(['hash-object', '-w', '--stdin'], {
      cwd: this.packs.root, gitDirectory: staging, input, ...(signal ? { signal } : {}),
    })).stdout.toString(), format), signal)
    if (!state.covered.has(oid)) {
      state.staged += Number(file.metadata.size)
      if (state.staged >= this.packs.packSize) await this.#flush(store, state, signal)
    }
    return oid
  }

  /** Uploads every object of a source repository not already remote. */
  async repository(store: string, format: ObjectFormat, gitDirectory: string, signal?: AbortSignal): Promise<void> {
    const state = await this.#store(store, format, signal)
    const missing = (await this.packs.inventory(gitDirectory, signal)).filter(object => !state.covered.has(object.oid))
    await this.#upload(store, state, gitDirectory, missing, signal)
  }

  covers(store: string, oid: string): Promise<boolean> {
    const state = this.#stores.get(store)
    return state ? state.then(state => state.covered.has(oid)) : Promise.resolve(false)
  }

  /** Uploads everything still staged and returns the snapshot's cumulative pack list. */
  async finish(signal?: AbortSignal): Promise<SnapshotPacks> {
    const stores: Record<string, readonly string[]> = { ...this.previous?.stores }
    for (const [store, pending] of this.#stores) {
      const state = await pending
      if (state.staging) await this.#flush(store, state, signal)
      stores[store] = [...state.packs].sort()
    }
    return { version: 1, remote: this.packs.url, stores }
  }

  /** Deletes staged loose objects; uploaded packs stay remote for reuse. */
  async [Symbol.asyncDispose](): Promise<void> {
    await rm(this.#directory, { recursive: true, force: true })
  }

  #store(store: string, format: ObjectFormat, signal?: AbortSignal): Promise<StoreState> {
    let pending = this.#stores.get(store)
    if (!pending) {
      pending = (async () => {
        const known = new Set(this.previous?.stores[store] ?? [])
        // Packs from an interrupted capture are reused, and must then be listed.
        for (const orphan of await this.packs.orphans(store, 'content', known, signal)) known.add(orphan)
        const covered = await this.packs.covered(store, 'content', known, format, signal)
        return { format, covered, packs: known, staged: 0, staging: undefined }
      })()
      this.#stores.set(store, pending)
    }
    return pending.then(state => {
      if (state.format !== format) throw new Error(`store ${store} was captured with another object format`)
      return state
    })
  }

  async #initStaging(store: string, format: ObjectFormat, signal?: AbortSignal): Promise<string> {
    const directory = join(this.#directory, `${store}.git`)
    await mkdir(this.#directory, { recursive: true })
    await this.packs.git.run(['init', '--bare', '-q', '--template=', `--object-format=${format}`, directory], {
      cwd: this.packs.root, ...(signal ? { signal } : {}),
    })
    return directory
  }

  async #flush(store: string, state: StoreState, signal?: AbortSignal): Promise<void> {
    const staging = state.staging
    if (!staging) return
    const missing = (await this.packs.inventory(staging, signal)).filter(object => !state.covered.has(object.oid))
    await this.#upload(store, state, staging, missing, signal)
    await rm(staging, { recursive: true, force: true })
    state.staging = undefined
    state.staged = 0
  }

  async #upload(
    store: string, state: StoreState, gitDirectory: string,
    objects: readonly InventoryObject[], signal?: AbortSignal,
  ): Promise<void> {
    if (!objects.length) return
    for (const pack of (await this.packs.upload(store, 'content', state.format, gitDirectory, objects, signal)).packs) {
      state.packs.add(pack)
      for (const oid of (await this.packs.index(store, 'content', pack, state.format, signal)).oids) state.covered.add(oid)
    }
  }
}
