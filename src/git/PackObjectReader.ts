import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import type { ByteRange } from '../storage/ObjectStore.ts'
import type PackIndex from './PackIndex.ts'

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag'

export interface GitObject {
  readonly type: GitObjectType
  readonly data: Buffer
}

const baseTypes: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' }
const offsetDelta = 6
const referenceDelta = 7
/** Far beyond Git's own depth limits; only a malicious reference cycle reaches it. */
const maximumDepth = 4096

/** Reads single objects out of a pack through byte-range reads, resolving deltas within the pack. */
export default class PackObjectReader {
  constructor(
    private readonly index: PackIndex,
    private readonly packSize: number,
    private readonly read: (range: ByteRange) => Promise<Uint8Array>,
  ) {}

  /** Returns the object only after its contents hash to `oid`. */
  async object(oid: string): Promise<GitObject> {
    const offset = this.index.offset(oid)
    if (offset === undefined) throw new Error(`object ${oid} is not in this pack`)
    const object = await this.#at(offset, 0)
    const actual = createHash(this.index.format)
      .update(`${object.type} ${object.data.byteLength}\0`).update(object.data).digest('hex')
    if (actual !== oid) throw new Error(`pack object ${oid} hashes to ${actual}`)
    return object
  }

  async #at(offset: number, depth: number): Promise<GitObject> {
    if (depth > maximumDepth) throw new Error('pack delta chain is too deep')
    const end = this.index.entryEnd(offset, this.packSize)
    if (end <= offset) throw new Error(`pack entry at ${offset} is empty`)
    const entry = Buffer.from(await this.read({ start: offset, end }))
    let position = 0
    const next = () => {
      if (position >= entry.byteLength) throw new Error(`pack entry at ${offset} is truncated`)
      return entry[position++]!
    }
    let byte = next()
    const type = (byte >> 4) & 7
    let size = byte & 15
    for (let shift = 4; byte & 0x80; shift += 7) {
      byte = next()
      size += (byte & 0x7f) * 2 ** shift
    }
    let base: number | undefined
    if (type === offsetDelta) {
      byte = next()
      let distance = byte & 0x7f
      while (byte & 0x80) {
        byte = next()
        distance = (distance + 1) * 128 + (byte & 0x7f)
      }
      if (distance <= 0 || distance > offset) throw new Error(`pack entry at ${offset} has an invalid delta base`)
      base = offset - distance
    } else if (type === referenceDelta) {
      const length = this.index.format === 'sha1' ? 20 : 32
      if (position + length > entry.byteLength) throw new Error(`pack entry at ${offset} is truncated`)
      const reference = entry.toString('hex', position, position + length)
      position += length
      base = this.index.offset(reference)
      if (base === undefined) throw new Error(`pack entry at ${offset} needs base ${reference} outside the pack`)
    } else if (!baseTypes[type]) {
      throw new Error(`pack entry at ${offset} has unknown type ${type}`)
    }
    const data = inflateSync(entry.subarray(position))
    if (data.byteLength !== size) throw new Error(`pack entry at ${offset} inflated to the wrong size`)
    if (base === undefined) return { type: baseTypes[type]!, data }
    const resolved = await this.#at(base, depth + 1)
    return { type: resolved.type, data: PackObjectReader.applyDelta(resolved.data, data) }
  }

  static applyDelta(base: Buffer, delta: Buffer): Buffer {
    let position = 0
    const next = () => {
      if (position >= delta.byteLength) throw new Error('delta is truncated')
      return delta[position++]!
    }
    const varint = () => {
      let value = 0
      let byte: number
      let shift = 0
      do {
        byte = next()
        value += (byte & 0x7f) * 2 ** shift
        shift += 7
      } while (byte & 0x80)
      return value
    }
    if (varint() !== base.byteLength) throw new Error('delta base has the wrong size')
    const result = Buffer.alloc(varint())
    let written = 0
    while (position < delta.byteLength) {
      const op = next()
      if (op & 0x80) {
        let start = 0
        let length = 0
        for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) start += next() * 2 ** (8 * bit)
        for (let bit = 0; bit < 3; bit++) if (op & (1 << (4 + bit))) length += next() * 2 ** (8 * bit)
        if (length === 0) length = 0x10000
        if (start + length > base.byteLength || written + length > result.byteLength) throw new Error('delta copy is out of bounds')
        base.copy(result, written, start, start + length)
        written += length
      } else if (op) {
        if (position + op > delta.byteLength || written + op > result.byteLength) throw new Error('delta insert is out of bounds')
        delta.copy(result, written, position, position + op)
        position += op
        written += op
      } else {
        throw new Error('delta uses a reserved opcode')
      }
    }
    if (written !== result.byteLength) throw new Error('delta produced the wrong size')
    return result
  }
}
