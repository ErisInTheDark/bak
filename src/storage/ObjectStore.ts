export interface ObjectHead {
  readonly size: number
}

/** Half-open byte range: `start` inclusive, `end` exclusive. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

/**
 * Remote blob storage boundary. Callers deal in keys and bytes; backends own transport,
 * authentication and retries.
 */
export default interface ObjectStore {
  /** Stores bytes once. Repeating identical bytes is a no-op; different bytes under an existing key reject. */
  putImmutable(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>
  get(key: string, signal?: AbortSignal): Promise<Uint8Array | undefined>
  /** Rejects when the key is missing. */
  getRange(key: string, range: ByteRange, signal?: AbortSignal): Promise<Uint8Array>
  head(key: string, signal?: AbortSignal): Promise<ObjectHead | undefined>
  /** Removes every stored version of the key. Missing keys are a no-op. */
  delete(key: string, signal?: AbortSignal): Promise<void>
}
