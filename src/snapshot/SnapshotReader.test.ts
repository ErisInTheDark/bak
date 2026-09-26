import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Writable } from 'node:stream'
import GitFixture from '../testing/GitFixture.ts'
import SnapshotStore from './SnapshotStore.ts'
import SnapshotReader from './SnapshotReader.ts'
import { SnapshotManifest } from './snapshot-format.ts'

test('readback merges independent descendant roots into synthetic directory listings', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = fixture.path('source')
    await fixture.write('source/visible', 'visible')
    await fixture.write('source/hidden/keep/file', 'kept')
    await fixture.write('source/hidden/excluded', 'not selected')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    await store.commit({
      pathspec: `#home = "${source}"\n!#home/hidden\n#home/hidden/keep = "${fixture.path('source/hidden/keep')}"`,
      message: 'independent subtree', identity: { name: 'fixture', email: 'fixture@example.invalid' },
    })
    const reader = new SnapshotReader(root)
    assert.deepEqual((await reader.resolve('HEAD', 'home')).children, ['hidden', 'visible'])
    assert.deepEqual((await reader.resolve('HEAD', 'home/hidden')).children, ['keep'])
    assert.equal((await reader.read('HEAD', 'home/hidden/keep/file')).toString(), 'kept')
    await assert.rejects(reader.read('HEAD', 'home/hidden/excluded'), /does not exist/)
  } finally {
    await fixture.dispose()
  }
})

test('persisted metadata rejects invalid versions and unsafe object-store references', () => {
  assert.throws(() => SnapshotManifest.parse('{"version":2}'), /invalid/)
  assert.throws(() => SnapshotManifest.parse(JSON.stringify({
    version: 1, pathspec: '', entries: [{
      id: 'a', source: { root: '/', path: 'a' }, kind: 'file',
      metadata: { device: '1', inode: '1', links: '1', size: '1', mode: 0o100644, mtimeNs: '1', ctimeNs: '1' },
      objects: [{ repository: '../outside', oid: 'a'.repeat(40) }],
    }], roots: [], links: [], mounts: [], repositories: [], catalog: [], skipped: [],
  })), /invalid/)
})

test('streamed readback propagates cancellation without buffering a whole large file', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = await fixture.write('large', Buffer.alloc(17 * 1024 * 1024, 0xa5))
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    await store.commit({
      pathspec: `#large = "${source}"`, message: 'large file',
      identity: { name: 'fixture', email: 'fixture@example.invalid' },
    })
    const controller = new AbortController()
    let received = 0
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        received += chunk.length
        controller.abort(new Error('read cancelled'))
        done()
      },
    })
    await assert.rejects(new SnapshotReader(root).stream('HEAD', 'large', output, controller.signal), /read cancelled/)
    assert.ok(received > 0 && received < 17 * 1024 * 1024)
  } finally {
    await fixture.dispose()
  }
})
