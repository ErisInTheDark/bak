import { createHash } from 'node:crypto'

export type ObjectFormat = 'sha1' | 'sha256'

export interface RemoteReference {
  readonly name: string
  readonly oid: string
}

/** One local Git store (`main` or a repository id) as published remotely. */
export interface RemoteStoreState {
  readonly id: string
  readonly objectFormat: ObjectFormat
  /** Every pack needed to recover the store, as `pack-<hash>`. */
  readonly packs: readonly string[]
  readonly refs: readonly RemoteReference[]
}

/** Immutable, content-addressed description of a complete published backup. */
interface RemoteState {
  readonly version: 1
  readonly snapshot: string
  readonly previous: string | null
  readonly stores: readonly RemoteStoreState[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oid(value: unknown, format: ObjectFormat): value is string {
  return typeof value === 'string' && (format === 'sha1' ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u).test(value)
}

namespace RemoteState {
  export const headKey = 'HEAD'
  export const snapshotsRef = 'refs/heads/snapshots'

  export function key(bytes: Uint8Array): string {
    return `states/${createHash('sha256').update(bytes).digest('hex')}.json`
  }

  export function isKey(value: string): boolean {
    return /^states\/[0-9a-f]{64}\.json$/u.test(value)
  }

  export function packKey(store: string, pack: string, extension: 'pack' | 'idx'): string {
    return `stores/${store}/packs/${pack}.${extension}`
  }

  export function encode(state: RemoteState): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(state)}\n`)
  }

  export function parse(bytes: Uint8Array): RemoteState {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!record(value) || value.version !== 1 || !oid(value.snapshot, 'sha1') ||
      !(value.previous === null || (typeof value.previous === 'string' && isKey(value.previous))) ||
      !Array.isArray(value.stores)) {
      throw new Error('invalid remote state')
    }
    const stores = value.stores as unknown[]
    const valid = stores.every(store => {
      if (!record(store) || typeof store.id !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(store.id) ||
        (store.objectFormat !== 'sha1' && store.objectFormat !== 'sha256') ||
        !Array.isArray(store.packs) || !Array.isArray(store.refs)) return false
      const format = store.objectFormat
      return store.packs.every(pack => typeof pack === 'string' && /^pack-[0-9a-f]{40,64}$/u.test(pack)) &&
        store.refs.every(reference => record(reference) && oid(reference.oid, format) &&
          typeof reference.name === 'string' && /^refs\/[^\0-\x20~^:?*[\\]+$/u.test(reference.name) &&
          !reference.name.includes('..'))
    })
    const ids = stores.map(store => (store as Record<string, unknown>).id)
    const main = stores.find(store => (store as Record<string, unknown>).id === 'main') as RemoteStoreState | undefined
    if (!valid || new Set(ids).size !== ids.length || main?.objectFormat !== 'sha1' ||
      !main.refs.some(reference => reference.name === snapshotsRef && reference.oid === value.snapshot)) {
      throw new Error('invalid remote state stores')
    }
    return value as unknown as RemoteState
  }
}

export default RemoteState
