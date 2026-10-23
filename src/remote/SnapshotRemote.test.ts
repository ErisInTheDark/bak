import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import EncryptedObjectStore from '../crypto/EncryptedObjectStore.ts'
import EncryptionKey from '../crypto/EncryptionKey.ts'
import SnapshotReader from '../snapshot/SnapshotReader.ts'
import SnapshotStore from '../snapshot/SnapshotStore.ts'
import GitFixture from '../testing/GitFixture.ts'
import MemoryObjectStore from '../testing/MemoryObjectStore.ts'
import SnapshotRemote from './SnapshotRemote.ts'

const identity = { name: 'fixture', email: 'fixture@example.invalid' }
const url = 'b2://fixture-bucket/home'
const key = await EncryptionKey.fromPassphrase('correct horse battery staple')

class RecordingStore extends MemoryObjectStore {
  readonly uploads: string[] = []
  failReplace = false

  override async putImmutable(name: string, bytes: Uint8Array): Promise<void> {
    this.uploads.push(name)
    await super.putImmutable(name, bytes)
  }

  override async replace(name: string, bytes: Uint8Array): Promise<void> {
    if (this.failReplace) throw new Error('simulated interruption')
    await super.replace(name, bytes)
  }
}

async function scenario(run: (context: {
  fixture: GitFixture
  root: string
  inner: RecordingStore
  remote: () => EncryptedObjectStore
  commit: (message: string) => Promise<string>
}) => Promise<void>): Promise<void> {
  const fixture = await GitFixture.create()
  try {
    const repository = await fixture.repository('sources/widget')
    await fixture.git(['worktree', 'add', '-b', 'feature', fixture.path('feature')], repository)
    await fixture.write('sources/widget/file.txt', 'dirty main\n')
    await fixture.write('feature/file.txt', 'dirty feature\n')
    await fixture.write('sources/plain/bytes', Buffer.from([0, 255, 128, 10]))
    const root = fixture.path('backup')
    const local = new SnapshotStore(root)
    await local.init()
    const pathspec = `#plain = "${fixture.path('sources/plain')}"\nrepo:/widget = "${repository}"\n`
    const inner = new RecordingStore()
    await run({
      fixture, root, inner,
      remote: () => new EncryptedObjectStore(inner, key),
      commit: async message => (await local.commit({ pathspec, message, identity })).commit,
    })
  } finally {
    await fixture.dispose()
  }
}

test('a pushed backup clones onto a clean folder with readable snapshots and history', () => scenario(async context => {
  const first = await context.commit('first')
  const pushed = await new SnapshotRemote(context.root, context.remote(), url).push()
  assert.deepEqual({ snapshot: pushed.snapshot, changed: pushed.changed }, { snapshot: first, changed: true })
  assert.ok([...context.inner.objects.keys()].every(name => name === 'HEAD' || /^(states|stores)\//u.test(name)))
  const restored = context.fixture.path('restored')
  assert.equal(await SnapshotRemote.clone(restored, context.remote(), url), first)
  const reader = new SnapshotReader(restored)
  assert.deepEqual(await reader.read(first, 'plain/bytes'), Buffer.from([0, 255, 128, 10]))
  assert.equal((await reader.read(first, 'repo:/widget/file.txt')).toString(), 'dirty main\n')
  assert.equal((await reader.read(first, 'repo:/widget+feature/file.txt')).toString(), 'dirty feature\n')
  assert.equal(await readFile(join(restored, SnapshotStore.pathspecFileName), 'utf8'),
    (await new SnapshotReader(context.root).manifest(first)).pathspec)
  await assert.rejects(SnapshotRemote.clone(restored, context.remote(), url), /without \.bak/u)
}))

test('later pushes upload only new packs and leave earlier objects untouched', () => scenario(async context => {
  await context.commit('first')
  const remote = new SnapshotRemote(context.root, context.remote(), url)
  await remote.push()
  const before = new Map(context.inner.objects)
  assert.equal((await remote.push()).changed, false)
  await context.fixture.write('sources/plain/bytes', 'changed\n')
  const second = await context.commit('second')
  context.inner.uploads.length = 0
  const pushed = await remote.push()
  assert.equal(pushed.changed, true)
  assert.ok(pushed.packs >= 1)
  assert.ok(context.inner.uploads.filter(name => name.startsWith('stores/')).every(name => !before.has(name)))
  for (const [name, bytes] of before) if (name !== 'HEAD') assert.deepEqual(context.inner.objects.get(name), bytes)
  const restored = context.fixture.path('restored')
  assert.equal(await SnapshotRemote.clone(restored, context.remote(), url), second)
  assert.equal((await new SnapshotReader(restored).read(second, 'plain/bytes')).toString(), 'changed\n')
}))

test('an interrupted push keeps the previous HEAD and the rerun reuses uploaded packs', () => scenario(async context => {
  await context.commit('first')
  context.inner.failReplace = true
  await assert.rejects(new SnapshotRemote(context.root, context.remote(), url).push(), /simulated interruption/u)
  assert.equal(context.inner.objects.has('HEAD'), false)
  context.inner.failReplace = false
  context.inner.uploads.length = 0
  assert.equal((await new SnapshotRemote(context.root, context.remote(), url).push()).changed, true)
  assert.deepEqual(context.inner.uploads.filter(name => name.startsWith('stores/')), [])
  await SnapshotRemote.clone(context.fixture.path('restored'), context.remote(), url)
}))

test('a folder missing remote snapshots cannot push over them', () => scenario(async context => {
  await context.commit('first')
  await new SnapshotRemote(context.root, context.remote(), url).push()
  const other = context.fixture.path('other')
  await SnapshotRemote.clone(other, context.remote(), url)
  await context.fixture.write('sources/plain/bytes', 'changed\n')
  await context.commit('second')
  await new SnapshotRemote(context.root, context.remote(), url).push()
  await assert.rejects(new SnapshotRemote(other, context.remote(), url).push(), /lacks/u)
}))

test('clone rejects a tampered pack', () => scenario(async context => {
  await context.commit('first')
  await new SnapshotRemote(context.root, context.remote(), url).push()
  const pack = [...context.inner.objects.keys()].find(name => name.endsWith('.pack'))!
  const bytes = Uint8Array.from(context.inner.objects.get(pack)!)
  bytes[bytes.byteLength - 20]! ^= 1
  context.inner.objects.set(pack, bytes)
  await assert.rejects(SnapshotRemote.clone(context.fixture.path('restored'), context.remote(), url), /authentication/u)
}))
