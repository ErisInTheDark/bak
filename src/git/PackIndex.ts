import { createHash } from 'node:crypto'
import type { ObjectFormat } from './GitProcess.ts'

const signature = Buffer.from([0xff, 0x74, 0x4f, 0x63])
const fanoutSize = 256 * 4

/** Parsed Git pack index (version 2): object ids and their pack offsets. */
export default class PackIndex {
  /** Validates layout and trailing checksum. */
  static parse(bytes: Uint8Array, format: ObjectFormat): PackIndex {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const hashLength = format === 'sha1' ? 20 : 32
    if (buffer.byteLength < 8 + fanoutSize + 2 * hashLength || !buffer.subarray(0, 4).equals(signature) || buffer.readUInt32BE(4) !== 2) {
      throw new Error('not a version 2 pack index')
    }
    const body = buffer.byteLength - hashLength
    if (!createHash(format).update(buffer.subarray(0, body)).digest().equals(buffer.subarray(body))) {
      throw new Error('pack index checksum mismatch')
    }
    const count = buffer.readUInt32BE(8 + fanoutSize - 4)
    const names = 8 + fanoutSize
    const offsets = names + count * (hashLength + 4)
    const large = offsets + count * 4
    const largeCount = (body - hashLength - large) / 8
    if (!Number.isInteger(largeCount) || largeCount < 0) throw new Error('pack index has an invalid length')
    const oids: string[] = []
    const positions = new Map<string, number>()
    for (let index = 0; index < count; index++) {
      const oid = buffer.toString('hex', names + index * hashLength, names + (index + 1) * hashLength)
      if (index && oid <= oids[index - 1]!) throw new Error('pack index object ids are not sorted')
      const small = buffer.readUInt32BE(offsets + index * 4)
      let position = small
      if (small & 0x80000000) {
        const slot = small & 0x7fffffff
        if (slot >= largeCount) throw new Error('pack index has an invalid large offset')
        position = Number(buffer.readBigUInt64BE(large + slot * 8))
      }
      oids.push(oid)
      positions.set(oid, position)
    }
    return new PackIndex(format, oids, positions, buffer.toString('hex', body - hashLength, body))
  }

  readonly #positions: ReadonlyMap<string, number>
  readonly #starts: readonly number[]

  private constructor(
    readonly format: ObjectFormat,
    /** Sorted object ids. */
    readonly oids: readonly string[],
    positions: ReadonlyMap<string, number>,
    /** Checksum trailer of the pack this index describes. */
    readonly packChecksum: string,
  ) {
    this.#positions = positions
    this.#starts = [...positions.values()].sort((a, b) => a - b)
  }

  offset(oid: string): number | undefined {
    return this.#positions.get(oid)
  }

  has(oid: string): boolean {
    return this.#positions.has(oid)
  }

  /** Exclusive end of the entry starting at `offset`: the next entry, or the pack trailer. */
  entryEnd(offset: number, packSize: number): number {
    let low = 0
    let high = this.#starts.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.#starts[middle]! <= offset) low = middle + 1
      else high = middle
    }
    return low < this.#starts.length ? this.#starts[low]! : packSize - (this.format === 'sha1' ? 20 : 32)
  }
}
