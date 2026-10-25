import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import EncryptedObjectStore from '../crypto/EncryptedObjectStore.ts'
import EncryptionKey from '../crypto/EncryptionKey.ts'
import GitProcess, { type GitRequest } from '../git/GitProcess.ts'
import SnapshotReader from '../snapshot/SnapshotReader.ts'
import SnapshotStore from '../snapshot/SnapshotStore.ts'
import GitFixture from '../testing/GitFixture.ts'
import MemoryObjectStore from '../testing/MemoryObjectStore.ts'
import RemotePacks from './RemotePacks.ts'
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

interface Scenario {
  readonly fixture: GitFixture
  readonly root: string
  readonly inner: RecordingStore
  /** Remote packs for `root` (default: the backup folder) over the shared encrypted store. */
  readonly packs: (root?: string, git?: GitProcess) => RemotePacks
  readonly commit: (message: string, git?: GitProcess, signal?: AbortSignal) => Promise<string>
}

async function scenario(run: (context: Scenario) => Promise<void>): Promise<void> {
  const fixture = await GitFixture.create()
  try {
    const repository = await fixture.repository('sources/widget')
    await fixture.git(['worktree', 'add', '-b', 'feature', fixture.path('feature')], repository)
    await fixture.write('sources/widget/file.txt', 'dirty main\n')
    await fixture.write('feature/file.txt', 'dirty feature\n')
    await fixture.write('sources/plain/bytes', Buffer.from([0, 255, 128, 10]))
    const root = fixture.path('backup')
    await new SnapshotStore(root).init()
    const pathspec = `#plain = "${fixture.path('sources/plain')}"\nrepo:/widget = "${repository}"\n`
    const inner = new RecordingStore()
    const packs = (folder = root, git?: GitProcess) =>
      new RemotePacks(folder, new EncryptedObjectStore(inner, key), url, git ? { git } : {})
    await run({
      fixture, root, inner, packs,
      commit: async (message, git, signal) => (await new SnapshotStore(root, git).commit({
        pathspec, message, identity, content: packs(root, git), ...(signal ? { signal } : {}),
      })).commit,
    })
  } finally {
    await fixture.dispose()
  }
}

const contentUploads = (inner: RecordingStore) => inner.uploads.filter(name => /^stores\/[^/]+\/content\//u.test(name))
const metadataUploads = (inner: RecordingStore) => inner.uploads.filter(name => /^stores\/[^/]+\/metadata\//u.test(name))

test('a pushed backup clones onto a clean folder that reads every file lazily from the remote', () => scenario(async context => {
  const first = await context.commit('first')
  assert.ok(contentUploads(context.inner).length > 0, 'commit uploads captured contents')
  assert.equal(metadataUploads(context.inner).length, 0)
  const pushed = await new SnapshotRemote(context.packs()).push()
  assert.deepEqual({ snapshot: pushed.snapshot, changed: pushed.changed }, { snapshot: first, changed: true })
  assert.ok([...context.inner.objects.keys()].every(name => name === 'HEAD' || /^(states|stores)\//u.test(name)))
  const restored = context.fixture.path('restored')
  const packs = context.packs(restored)
  assert.equal(await SnapshotRemote.clone(packs), first)
  const reader = new SnapshotReader(restored, packs)
  assert.deepEqual(await reader.read(first, 'plain/bytes'), Buffer.from([0, 255, 128, 10]))
  assert.equal((await reader.read(first, 'repo:/widget/file.txt')).toString(), 'dirty main\n')
  assert.equal((await reader.read(first, 'repo:/widget+feature/file.txt')).toString(), 'dirty feature\n')
  assert.equal(await readFile(join(restored, SnapshotStore.pathspecFileName), 'utf8'),
    (await new SnapshotReader(context.root).manifest(first)).pathspec)
  await assert.rejects(SnapshotRemote.clone(packs), /without \.bak/u)
}))

test('later commits and pushes upload only new packs and leave earlier objects untouched', () => scenario(async context => {
  await context.commit('first')
  const remote = new SnapshotRemote(context.packs())
  await remote.push()
  const before = new Map(context.inner.objects)
  assert.equal((await remote.push()).changed, false)
  await context.fixture.write('sources/plain/bytes', 'changed\n')
  context.inner.uploads.length = 0
  const second = await context.commit('second')
  const pushed = await remote.push()
  assert.equal(pushed.changed, true)
  assert.ok(contentUploads(context.inner).length >= 1)
  assert.ok(context.inner.uploads.filter(name => name.startsWith('stores/')).every(name => !before.has(name)))
  for (const [name, bytes] of before) if (name !== 'HEAD') assert.deepEqual(context.inner.objects.get(name), bytes)
  const restored = context.fixture.path('restored')
  const packs = context.packs(restored)
  assert.equal(await SnapshotRemote.clone(packs), second)
  assert.equal((await new SnapshotReader(restored, packs).read(second, 'plain/bytes')).toString(), 'changed\n')
}))

test('an interrupted push keeps the previous HEAD and the rerun reuses uploaded packs', () => scenario(async context => {
  await context.commit('first')
  context.inner.failReplace = true
  await assert.rejects(new SnapshotRemote(context.packs()).push(), /simulated interruption/u)
  assert.equal(context.inner.objects.has('HEAD'), false)
  context.inner.failReplace = false
  context.inner.uploads.length = 0
  assert.equal((await new SnapshotRemote(context.packs()).push()).changed, true)
  assert.deepEqual(context.inner.uploads.filter(name => name.startsWith('stores/')), [])
  await SnapshotRemote.clone(context.packs(context.fixture.path('restored')))
}))

test('an interrupted commit reruns without uploading its contents again', () => scenario(async context => {
  const controller = new AbortController()
  class CancelAtCommit extends GitProcess {
    override async run(args: readonly string[], request: GitRequest) {
      if (args[0] === 'hash-object' && args.includes('commit') && request.gitDirectory?.endsWith('main.git')) {
        controller.abort(new Error('interrupted commit'))
      }
      return super.run(args, request)
    }
  }
  await assert.rejects(context.commit('first', new CancelAtCommit(), controller.signal), /interrupted commit/u)
  const uploaded = contentUploads(context.inner)
  assert.ok(uploaded.length > 0)
  context.inner.uploads.length = 0
  const first = await context.commit('first')
  assert.deepEqual(contentUploads(context.inner), [])
  await new SnapshotRemote(context.packs()).push()
  const restored = context.fixture.path('restored')
  const packs = context.packs(restored)
  assert.equal(await SnapshotRemote.clone(packs), first)
  assert.equal((await new SnapshotReader(restored, packs).read(first, 'repo:/widget/file.txt')).toString(), 'dirty main\n')
}))

test('a folder missing remote snapshots cannot push over them', () => scenario(async context => {
  await context.commit('first')
  await new SnapshotRemote(context.packs()).push()
  const other = context.fixture.path('other')
  await SnapshotRemote.clone(context.packs(other))
  await context.fixture.write('sources/plain/bytes', 'changed\n')
  await context.commit('second')
  await new SnapshotRemote(context.packs()).push()
  await assert.rejects(new SnapshotRemote(context.packs(other)).push(), /lacks/u)
}))

test('push publishes nothing when a content pack the snapshot needs is gone', () => scenario(async context => {
  await context.commit('first')
  const pack = [...context.inner.objects.keys()].find(name => /\/content\/.*\.pack$/u.test(name))!
  context.inner.objects.delete(pack)
  await assert.rejects(new SnapshotRemote(context.packs()).push(), /missing/u)
  assert.equal(context.inner.objects.has('HEAD'), false)
}))

test('fsck downloads and verifies every pack, and catches a tampered content pack', () => scenario(async context => {
  await context.commit('first')
  const remote = new SnapshotRemote(context.packs())
  await remote.push()
  const verified = await remote.verify()
  assert.equal(verified.packs, [...context.inner.objects.keys()].filter(name => name.endsWith('.pack')).length)
  const pack = [...context.inner.objects.keys()].find(name => /\/content\/.*\.pack$/u.test(name))!
  const bytes = Uint8Array.from(context.inner.objects.get(pack)!)
  bytes[bytes.byteLength - 20]! ^= 1
  context.inner.objects.set(pack, bytes)
  await assert.rejects(remote.verify(), /authentication/u)
}))
