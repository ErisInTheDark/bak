import { createCipheriv, createDecipheriv } from 'node:crypto'
import type ObjectStore from '../storage/ObjectStore.ts'
import type { ByteRange, ObjectHead } from '../storage/ObjectStore.ts'
import type EncryptionKey from './EncryptionKey.ts'

const magic = Buffer.from('bakE', 'latin1')
const version = 1
const headerSize = magic.byteLength + 1 + 8 + 32 + 8
const chunkSize = 64 * 1024
const tagSize = 16
const storedChunkSize = chunkSize + tagSize

interface Header {
  readonly bytes: Buffer
  readonly salt: Buffer
  readonly size: number
}

function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / chunkSize))
}

function chunkLength(size: number, index: number): number {
  return Math.min(chunkSize, size - index * chunkSize)
}

function storedSize(size: number): number {
  return headerSize + size + tagSize * chunkCount(size)
}

function nonce(index: number): Buffer {
  const bytes = Buffer.alloc(12)
  bytes.writeBigUInt64BE(BigInt(index), 4)
  return bytes
}

/**
 * Client-side encryption over any ObjectStore. Format v1: a 53-byte header
 * (magic, version, key id, salt, plaintext size) then AES-256-GCM chunks of 64 KiB.
 * Fixed chunk sizes keep ranged reads bounded. Every chunk authenticates the header
 * and object name, so tampering, truncation and renaming fail.
 */
export default class EncryptedObjectStore implements ObjectStore {
  constructor(private readonly inner: ObjectStore, private readonly key: EncryptionKey) {}

  async putImmutable(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.inner.putImmutable(name, this.#sealed(name, bytes), signal)
  }

  async replace(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.inner.replace(name, this.#sealed(name, bytes), signal)
  }

  /** Encrypts, then decrypts the exact output, so nothing unreadable is ever sent. */
  #sealed(name: string, bytes: Uint8Array): Buffer {
    const stored = this.#encrypt(name, bytes)
    const header = this.#header(name, stored.subarray(0, headerSize))
    const check = this.#decrypt(name, header, 0, chunkCount(header.size) - 1, stored.subarray(headerSize))
    if (!check.equals(bytes)) throw this.#corrupt(name, 'did not decrypt back to its plaintext before upload')
    return stored
  }

  #encrypt(name: string, bytes: Uint8Array): Buffer {
    const salt = this.key.objectSalt(name, bytes)
    const header = Buffer.alloc(headerSize)
    magic.copy(header)
    header.writeUInt8(version, magic.byteLength)
    this.key.id.copy(header, magic.byteLength + 1)
    salt.copy(header, magic.byteLength + 9)
    header.writeBigUInt64BE(BigInt(bytes.byteLength), headerSize - 8)
    const objectKey = this.key.objectKey(salt)
    const aad = this.#aad(header, name)
    const parts: Buffer[] = [header]
    for (let index = 0; index < chunkCount(bytes.byteLength); index++) {
      const cipher = createCipheriv('aes-256-gcm', objectKey, nonce(index)).setAAD(aad)
      const start = index * chunkSize
      parts.push(cipher.update(bytes.subarray(start, start + chunkLength(bytes.byteLength, index))), cipher.final(), cipher.getAuthTag())
    }
    return Buffer.concat(parts)
  }

  async get(name: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const stored = await this.inner.get(name, signal)
    if (!stored) return undefined
    const header = this.#header(name, stored.subarray(0, headerSize))
    if (stored.byteLength !== storedSize(header.size)) throw this.#corrupt(name, 'has the wrong length')
    return this.#decrypt(name, header, 0, chunkCount(header.size) - 1, stored.subarray(headerSize))
  }

  async getRange(name: string, range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start) {
      throw new RangeError(`invalid byte range ${range.start}-${range.end}`)
    }
    const header = this.#header(name, await this.inner.getRange(name, { start: 0, end: headerSize }, signal))
    if (range.end > header.size) throw new RangeError(`byte range ${range.start}-${range.end} exceeds ${name} size ${header.size}`)
    const first = Math.floor(range.start / chunkSize)
    const last = Math.floor((range.end - 1) / chunkSize)
    const stored = await this.inner.getRange(name, {
      start: headerSize + first * storedChunkSize,
      end: headerSize + last * storedChunkSize + chunkLength(header.size, last) + tagSize,
    }, signal)
    const plaintext = this.#decrypt(name, header, first, last, stored)
    const offset = first * chunkSize
    return plaintext.subarray(range.start - offset, range.end - offset)
  }

  async head(name: string, signal?: AbortSignal): Promise<ObjectHead | undefined> {
    const stored = await this.inner.head(name, signal)
    if (!stored) return undefined
    const body = stored.size - headerSize
    const size = body - tagSize * Math.max(1, Math.ceil(body / storedChunkSize))
    if (body < tagSize || storedSize(size) !== stored.size) throw this.#corrupt(name, 'has an impossible length')
    return { size }
  }

  async delete(name: string, signal?: AbortSignal): Promise<void> {
    await this.inner.delete(name, signal)
  }

  #aad(header: Buffer, name: string): Buffer {
    return Buffer.concat([header, Buffer.from(name, 'utf8')])
  }

  #header(name: string, bytes: Uint8Array): Header {
    const header = Buffer.from(bytes)
    if (header.byteLength !== headerSize || !header.subarray(0, magic.byteLength).equals(magic)) {
      throw this.#corrupt(name, 'is not a bak encrypted object')
    }
    const found = header.readUInt8(magic.byteLength)
    if (found !== version) throw this.#corrupt(name, `uses unsupported encryption format ${found}`)
    const keyId = header.subarray(magic.byteLength + 1, magic.byteLength + 9)
    if (!keyId.equals(this.key.id)) {
      throw new Error(`${name} was encrypted with a different passphrase (key id ${keyId.toString('hex')}, expected ${this.key.id.toString('hex')})`)
    }
    const size = Number(header.readBigUInt64BE(headerSize - 8))
    if (!Number.isSafeInteger(size)) throw this.#corrupt(name, 'has an impossible size')
    return { bytes: header, salt: header.subarray(magic.byteLength + 9, headerSize - 8), size }
  }

  #decrypt(name: string, header: Header, first: number, last: number, stored: Uint8Array): Buffer {
    const objectKey = this.key.objectKey(header.salt)
    const aad = this.#aad(header.bytes, name)
    const parts: Buffer[] = []
    let offset = 0
    for (let index = first; index <= last; index++) {
      const length = chunkLength(header.size, index)
      const decipher = createDecipheriv('aes-256-gcm', objectKey, nonce(index)).setAAD(aad)
      try {
        decipher.setAuthTag(stored.subarray(offset + length, offset + length + tagSize))
        parts.push(decipher.update(stored.subarray(offset, offset + length)), decipher.final())
      } catch (error) {
        throw this.#corrupt(name, `failed authentication at chunk ${index}`, error)
      }
      offset += length + tagSize
    }
    if (offset !== stored.byteLength) throw this.#corrupt(name, 'has the wrong length')
    return Buffer.concat(parts)
  }

  #corrupt(name: string, problem: string, cause?: unknown): Error {
    return new Error(`encrypted object ${name} ${problem}`, cause === undefined ? undefined : { cause })
  }
}
