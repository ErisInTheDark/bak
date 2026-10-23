import type ObjectStore from '../storage/ObjectStore.ts'
import type { ByteRange, ObjectHead } from '../storage/ObjectStore.ts'

/** In-memory ObjectStore with immutable-put semantics. `objects` is public so tests can tamper. */
export default class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>()

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    const existing = this.objects.get(key)
    if (existing && Buffer.compare(existing, bytes) !== 0) throw new Error(`${key} already exists with different content`)
    this.objects.set(key, Uint8Array.from(bytes))
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const bytes = this.objects.get(key)
    return bytes && Uint8Array.from(bytes)
  }

  async getRange(key: string, range: ByteRange): Promise<Uint8Array> {
    const bytes = this.objects.get(key)
    if (!bytes) throw new Error(`${key} does not exist`)
    if (range.start < 0 || range.end <= range.start || range.end > bytes.byteLength) {
      throw new RangeError(`invalid byte range ${range.start}-${range.end} of ${key}`)
    }
    return bytes.slice(range.start, range.end)
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    const bytes = this.objects.get(key)
    return bytes && { size: bytes.byteLength }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
}
