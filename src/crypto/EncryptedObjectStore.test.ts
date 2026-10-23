import assert from 'node:assert/strict'
import { test } from 'node:test'
import MemoryObjectStore from '../testing/MemoryObjectStore.ts'
import EncryptedObjectStore from './EncryptedObjectStore.ts'
import EncryptionKey from './EncryptionKey.ts'

const chunk = 64 * 1024
const key = await EncryptionKey.fromPassphrase('correct horse battery staple')
const otherKey = await EncryptionKey.fromPassphrase('a different strong passphrase')

function pattern(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) % 251)
}

function setup() {
  const inner = new MemoryObjectStore()
  return { inner, store: new EncryptedObjectStore(inner, key) }
}

test('objects round trip with bounded ranges and plaintext sizes', async () => {
  const { inner, store } = setup()
  for (const size of [0, 10, chunk, 2 * chunk + 5]) {
    const bytes = pattern(size)
    await store.putImmutable(`packs/${size}`, bytes)
    assert.deepEqual(await store.get(`packs/${size}`), Buffer.from(bytes))
    assert.deepEqual(await store.head(`packs/${size}`), { size })
    if (size >= 32) assert.equal(Buffer.from(inner.objects.get(`packs/${size}`)!).includes(Buffer.from(bytes.subarray(0, 32))), false)
  }
  const bytes = pattern(2 * chunk + 5)
  for (const [start, end] of [[0, 1], [chunk - 3, chunk + 3], [2 * chunk, 2 * chunk + 5], [5, 2 * chunk + 4]] as const) {
    assert.deepEqual(await store.getRange(`packs/${bytes.byteLength}`, { start, end }), Buffer.from(bytes.subarray(start, end)))
  }
  await assert.rejects(store.getRange(`packs/${bytes.byteLength}`, { start: 0, end: bytes.byteLength + 1 }), RangeError)
  assert.equal(await store.get('missing'), undefined)
  assert.equal(await store.head('missing'), undefined)
})

test('identical puts are idempotent and different content under the same name rejects', async () => {
  const { inner, store } = setup()
  await store.putImmutable('packs/a', pattern(100))
  const stored = inner.objects.get('packs/a')
  await store.putImmutable('packs/a', pattern(100))
  assert.deepEqual(inner.objects.get('packs/a'), stored)
  await assert.rejects(store.putImmutable('packs/a', pattern(101)))
})

test('tampering, truncation, renaming and a different passphrase are rejected', async () => {
  const { inner, store } = setup()
  const size = 2 * chunk + 5
  await store.putImmutable('packs/a', pattern(size))
  const original = inner.objects.get('packs/a')!
  const variant = (name: string, change: (bytes: Uint8Array) => Uint8Array) => {
    inner.objects.set(name, change(Uint8Array.from(original)))
    return name
  }
  const flippedChunk = variant('flipped-chunk', bytes => { bytes[53 + 100]! ^= 1; return bytes })
  const flippedHeader = variant('flipped-header', bytes => { bytes[20]! ^= 1; return bytes })
  const truncated = variant('truncated', bytes => bytes.subarray(0, 53 + 2 * (chunk + 16)))
  inner.objects.set('renamed', original)
  for (const name of [flippedChunk, flippedHeader, truncated, 'renamed']) {
    await assert.rejects(store.get(name), /encrypted object/u, name)
  }
  await assert.rejects(store.getRange(flippedChunk, { start: 0, end: 10 }), /failed authentication/u)
  await assert.rejects(new EncryptedObjectStore(inner, otherKey).get('packs/a'), /different passphrase/u)
})
