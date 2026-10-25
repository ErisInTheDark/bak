import assert from 'node:assert/strict'
import { link, mkdir, readdir, readFile, rename, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import PathspecEvaluator from '../config/PathspecEvaluator.ts'
import RemotePacks from '../remote/RemotePacks.ts'
import GitFixture from '../testing/GitFixture.ts'
import MemoryObjectStore from '../testing/MemoryObjectStore.ts'
import SnapshotReader from './SnapshotReader.ts'
import SnapshotStore from './SnapshotStore.ts'
import GitProcess, { type GitRequest } from '../git/GitProcess.ts'

const identity = { name: 'fixture', email: 'fixture@example.invalid' }
const url = 'b2://fixture-bucket/backup'
const remotes = new Map<string, RemotePacks>()

/** One in-memory remote per backup folder, shared by its commits and reads. */
function content(root: string): RemotePacks {
  let remote = remotes.get(root)
  if (!remote) {
    remote = new RemotePacks(root, new MemoryObjectStore(), url)
    remotes.set(root, remote)
  }
  return remote
}

function reader(root: string): SnapshotReader {
  return new SnapshotReader(root, content(root))
}

test('complete snapshots retain ordinary bytes, dirty repositories and worktrees without their sources', async () => {
  const fixture = await GitFixture.create()
  try {
    const repository = await fixture.repository('sources/widget')
    const feature = fixture.path('feature')
    await fixture.git(['worktree', 'add', '-b', 'feature', feature], repository)
    await fixture.write('sources/widget/file.txt', 'dirty main\n')
    await fixture.write('feature/file.txt', 'dirty feature\n')
    await fixture.write('sources/plain/bytes', Buffer.from([0, 255, 128, 10]))
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const pathspec = `#plain = "${fixture.path('sources/plain')}"\nrepo:/widget = "${repository}"`
    const result = await store.commit({ pathspec, message: 'first', identity, content: content(root) })
    assert.equal(result.changed, true)
    const unchanged = await store.commit({ pathspec, message: 'unchanged', identity, content: content(root) })
    assert.equal(unchanged.changed, false)
    assert.equal(unchanged.commit, result.commit)
    await rename(fixture.path('sources'), fixture.path('sources-unavailable'))
    await rename(feature, fixture.path('feature-unavailable'))
    assert.deepEqual(await reader(root).read(result.commit, 'plain/bytes'), Buffer.from([0, 255, 128, 10]))
    assert.equal((await reader(root).read(result.commit, 'repo:/widget/file.txt')).toString(), 'dirty main\n')
    assert.equal((await reader(root).read(result.commit, 'repo:/widget+feature/file.txt')).toString(), 'dirty feature\n')
  } finally {
    await fixture.dispose()
  }
})

test('captured contents and repository history live only in the remote, not in local storage', async () => {
  const fixture = await GitFixture.create()
  try {
    const repository = await fixture.repository('sources/widget')
    const history = await fixture.git(['rev-parse', 'HEAD'], repository)
    await fixture.write('sources/plain/bytes', 'plain contents\n')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const result = await store.commit({
      pathspec: `#plain = "${fixture.path('sources/plain')}"\nrepo:/widget = "${repository}"`,
      message: 'remote first', identity, content: content(root),
    })
    const manifest = await new SnapshotReader(root).manifest(result.commit)
    const plain = manifest.entries.find(entry => entry.kind === 'file' && entry.objects[0]?.repository === 'main')!.objects[0]!
    const repositoryStore = store.directory(manifest.repositories[0]!.identity.id)
    const present = async (gitDirectory: string, oid: string) =>
      (await new GitProcess().run(['cat-file', '-e', oid], { cwd: root, gitDirectory, acceptExitCodes: [0, 1, 128] })).code === 0
    assert.equal(await present(store.directory('main'), plain.oid), false)
    assert.equal(await present(repositoryStore, history), false)
    for (const entry of manifest.repositories[0]!.administrative) if (entry.oid) assert.equal(await present(repositoryStore, entry.oid), false)
    assert.deepEqual(await readdir(join(root, '.bak', 'staging')), [])
    assert.equal((await reader(root).read(result.commit, 'plain/bytes')).toString(), 'plain contents\n')
    await assert.rejects(new SnapshotReader(root).read(result.commit, 'plain/bytes'), /stored remotely/u)
  } finally {
    await fixture.dispose()
  }
})

test('a folder whose history lives on another remote refuses to commit', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = await fixture.write('source/file', 'safe')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const options = { pathspec: `#file = "${source}"`, message: 'first', identity }
    await store.commit({ ...options, content: content(root) })
    await assert.rejects(store.commit({
      ...options, content: new RemotePacks(root, new MemoryObjectStore(), 'b2://other-bucket'),
    }), /changing remotes/u)
  } finally {
    await fixture.dispose()
  }
})

test('failed selection cannot replace a published snapshot', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = await fixture.write('source/file', 'safe')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const good = await store.commit({ pathspec: `#file = "${source}"`, message: 'good', identity, content: content(root) })
    await assert.rejects(store.commit({
      pathspec: `"${fixture.path('missing')}"`, message: 'bad', identity, content: content(root),
    }), /incomplete|missing|ENOENT/)
    const head = await fixture.git(['--git-dir=' + fixture.path('backup/.bak/main.git'), 'rev-parse', 'HEAD'])
    assert.equal(head, good.commit)
  } finally {
    await fixture.dispose()
  }
})

test('initialisation creates a selection file without overwriting an existing one', async () => {
  const fixture = await GitFixture.create()
  try {
    const root = fixture.path('backup')
    await mkdir(root)
    const store = new SnapshotStore(root)
    await store.init()
    const starter = await readFile(fixture.path('backup/.bakspec'), 'utf8')
    assert.equal(new PathspecEvaluator(starter).getScanRoots().length, 0)
    await fixture.write('backup/.bakspec', '# user-owned selection\n')
    await store.init()
    assert.equal(await readFile(fixture.path('backup/.bakspec'), 'utf8'), '# user-owned selection\n')
  } finally {
    await fixture.dispose()
  }
})

test('storage created by the earlier local-contents format is refused', async () => {
  const fixture = await GitFixture.create()
  try {
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    await fixture.git(['--git-dir=' + fixture.path('backup/.bak/main.git'), 'config', 'bak.formatVersion', '1'])
    await assert.rejects(store.checkStorage(), /earlier bak/u)
  } finally {
    await fixture.dispose()
  }
})

test('explicit relocation preserves identity without changing earlier snapshots', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = await fixture.repository('original')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const first = await store.commit({ pathspec: `repo:/project = "${source}"`, message: 'first', identity, content: content(root) })
    const original = await reader(root).manifest(first.commit)
    await rename(source, fixture.path('moved'))
    const pathspec = `repo:/project = "${fixture.path('moved')}"`
    await assert.rejects(store.commit({ pathspec, message: 'unacknowledged', identity, content: content(root) }), /relocation/)
    const second = await store.commit({ pathspec, message: 'moved', identity, relocate: ['repo:/project'], content: content(root) })
    const current = await reader(root).manifest(second.commit)
    assert.equal(current.repositories[0]!.identity.id, original.repositories[0]!.identity.id)
    assert.notDeepEqual(current.repositories[0]!.identity.commonDirectory, original.repositories[0]!.identity.commonDirectory)
    assert.equal((await reader(root).read(first.commit, 'repo:/project/file.txt')).toString(), 'original\n')
    assert.equal((await reader(root).read(second.commit, 'repo:/project/file.txt')).toString(), 'original\n')
  } finally {
    await fixture.dispose()
  }
})

test('nested mixed-format repositories preserve their own histories and selected working bytes', async () => {
  const fixture = await GitFixture.create()
  try {
    const outer = await fixture.repository('outer')
    await fixture.repository('outer/inner', 'sha256')
    await fixture.write('outer/inner/file.txt', 'dirty sha256\n')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const result = await store.commit({ pathspec: `repo:/outer = "${outer}"`, message: 'mixed', identity, content: content(root) })
    const manifest = await reader(root).manifest(result.commit)
    assert.ok(manifest.repositories.some(repository => repository.identity.objectFormat === 'sha256'))
    await rename(outer, fixture.path('source-unavailable'))
    assert.equal((await reader(root).read(result.commit, 'repo:/outer/inner/file.txt')).toString(), 'dirty sha256\n')
    assert.equal((await reader(root).read(result.commit, 'repo:/inner/file.txt')).toString(), 'dirty sha256\n')
  } finally {
    await fixture.dispose()
  }
})

test('concurrent captures cannot overwrite a snapshot published since their baseline', async () => {
  const fixture = await GitFixture.create()
  try {
    const file = await fixture.write('source/file', 'before')
    const root = fixture.path('backup')
    const initial = new SnapshotStore(root)
    await initial.init()
    const options = { pathspec: `#file = "${file}"`, message: 'first', identity, content: content(root) }
    const previous = await initial.commit(options)
    await fixture.write('source/file', 'after')
    let arrived = 0
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    class PublicationGate extends GitProcess {
      override async run(args: readonly string[], request: GitRequest) {
        if (args[0] === 'update-ref' && args[1] === 'refs/heads/snapshots') {
          arrived++
          if (arrived === 2) release()
          await ready
        }
        return super.run(args, request)
      }
    }
    const git = new PublicationGate()
    const results = await Promise.allSettled([
      new SnapshotStore(root, git).commit({ ...options, message: 'one' }),
      new SnapshotStore(root, git).commit({ ...options, message: 'two' }),
    ])
    const winners = results.filter(result => result.status === 'fulfilled')
    assert.equal(winners.length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    const published = winners[0]!.value.commit
    assert.equal(await fixture.git(['--git-dir=' + fixture.path('backup/.bak/main.git'), 'rev-parse', 'HEAD']), published)
    assert.equal(await fixture.git(['--git-dir=' + fixture.path('backup/.bak/main.git'), 'rev-parse', 'HEAD^']), previous.commit)
  } finally {
    await fixture.dispose()
  }
})

test('cancellation before publication leaves the previous snapshot readable', async () => {
  const fixture = await GitFixture.create()
  try {
    const file = await fixture.write('source/file', 'before')
    const root = fixture.path('backup')
    const initial = new SnapshotStore(root)
    await initial.init()
    const options = { pathspec: `#file = "${file}"`, message: 'first', identity, content: content(root) }
    const previous = await initial.commit(options)
    await fixture.write('source/file', 'after')
    const controller = new AbortController()
    class CancelBeforePublication extends GitProcess {
      override async run(args: readonly string[], request: GitRequest) {
        const result = await super.run(args, request)
        if (args[0] === 'hash-object' && args.includes('commit')) controller.abort(new Error('cancelled before publication'))
        return result
      }
    }
    await assert.rejects(new SnapshotStore(root, new CancelBeforePublication()).commit({
      ...options, signal: controller.signal,
    }), /cancelled/)
    assert.equal((await reader(root).read('HEAD', 'file')).toString(), 'before')
    assert.equal(await fixture.git(['--git-dir=' + fixture.path('backup/.bak/main.git'), 'rev-parse', 'HEAD']), previous.commit)
  } finally {
    await fixture.dispose()
  }
})

test('repository capture respects explicitly excluded administrative files', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = await fixture.repository('source')
    await fixture.write('source/.git/private-note', 'must not be backed up')
    await fixture.git(['remote', 'add', 'origin', 'https://fixture-user:fixture-secret@host/project'], source)
    await fixture.write('private-hooks/hook', 'excluded linked administrative contents')
    await symlink(fixture.path('private-hooks'), fixture.path('source/.git/hooks'),
      process.platform === 'win32' ? 'junction' : 'dir')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const result = await store.commit({
      pathspec: `repo:/source = "${source}"\n!repo:/source/.git/private-note\n!repo:/source/.git/config\n!"${fixture.path('private-hooks')}"`,
      message: 'selected metadata', identity, content: content(root),
    })
    const manifest = await reader(root).manifest(result.commit)
    assert.ok(!manifest.repositories[0]!.administrative.some(entry => entry.path === 'private-note'))
    assert.ok(manifest.repositories[0]!.administrative.some(entry => entry.path === 'HEAD'))
    assert.ok(!JSON.stringify(manifest).includes('fixture-secret'))
    assert.ok(!manifest.repositories[0]!.administrative.some(entry => entry.path === 'hooks' || entry.path.startsWith('hooks/')))
  } finally {
    await fixture.dispose()
  }
})

test('a lost publication acknowledgement is reconciled against the published ref', async () => {
  const fixture = await GitFixture.create()
  try {
    const file = await fixture.write('source/file', 'captured')
    const root = fixture.path('backup')
    await new SnapshotStore(root).init()
    class LostAcknowledgement extends GitProcess {
      override async run(args: readonly string[], request: GitRequest) {
        const result = await super.run(args, request)
        if (args[0] === 'update-ref' && args[1] === 'refs/heads/snapshots') {
          throw new Error('publication acknowledgement lost')
        }
        return result
      }
    }
    const result = await new SnapshotStore(root, new LostAcknowledgement()).commit({
      pathspec: `#file = "${file}"`, message: 'published', identity, content: content(root),
    })
    assert.equal(await fixture.git(['--git-dir=' + fixture.path('backup/.bak/main.git'), 'rev-parse', 'HEAD']), result.commit)
    assert.equal((await reader(root).read(result.commit, 'file')).toString(), 'captured')
  } finally {
    await fixture.dispose()
  }
})

test('shared aliases, hardlinks and selected junction targets retain one content version', async () => {
  const fixture = await GitFixture.create()
  try {
    const file = await fixture.write('source/data/file', 'shared bytes')
    await link(file, fixture.path('source/data/other'))
    await symlink(fixture.path('source/data'), fixture.path('source/link'),
      process.platform === 'win32' ? 'junction' : 'dir')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const result = await store.commit({
      pathspec: `#one = "${fixture.path('source')}"\n#two = "${fixture.path('source')}"`,
      message: 'relationships', identity, content: content(root),
    })
    const manifest = await reader(root).manifest(result.commit)
    assert.ok(manifest.links.some(link => link.relationship === 'hardlink'))
    assert.ok(manifest.links.some(link => link.relationship === 'symbolic' && !link.materialised))
    await rename(fixture.path('source'), fixture.path('source-unavailable'))
    for (const path of ['one/data/file', 'two/data/other', 'one/link/file']) {
      assert.equal((await reader(root).read(result.commit, path)).toString(), 'shared bytes')
    }
  } finally {
    await fixture.dispose()
  }
})

test('bare and alternate-backed repositories retain history after all source stores disappear', async () => {
  const fixture = await GitFixture.create()
  try {
    const original = await fixture.repository('original')
    const head = await fixture.git(['rev-parse', 'HEAD'], original)
    const blob = await fixture.git(['rev-parse', 'HEAD:file.txt'], original)
    const alternate = fixture.path('alternate')
    const bare = fixture.path('bare.git')
    await fixture.git(['clone', '--shared', original, alternate])
    await fixture.git(['clone', '--bare', original, bare])
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const result = await store.commit({
      pathspec: `repo:/alternate = "${alternate}"\nrepo:/bare = "${bare}"`,
      message: 'repository stores', identity, content: content(root),
    })
    const manifest = await reader(root).manifest(result.commit)
    const packs = await reader(root).packs(result.commit)
    await rename(original, fixture.path('original-unavailable'))
    await rename(alternate, fixture.path('alternate-unavailable'))
    await rename(bare, fixture.path('bare-unavailable'))
    for (const repository of manifest.repositories) {
      const id = repository.identity.id
      assert.equal((await content(root).read(id, packs.stores[id]!, head, 'sha1')).type, 'commit')
      assert.equal((await content(root).read(id, packs.stores[id]!, blob, 'sha1')).data.toString(), 'original\n')
    }
    assert.equal(manifest.repositories.length, 2)
  } finally {
    await fixture.dispose()
  }
})

test('automatic worktree contents remain captured when its gitfile is excluded', async () => {
  const fixture = await GitFixture.create()
  try {
    const main = await fixture.repository('main')
    const feature = fixture.path('feature')
    await fixture.git(['worktree', 'add', '-b', 'feature', feature], main)
    await fixture.write('feature/file.txt', 'ordinary worktree contents')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const result = await store.commit({
      pathspec: `"${main}"\n!"${fixture.path('feature/.git')}"`,
      message: 'ordinary worktree', identity, content: content(root),
    })
    assert.equal((await reader(root).read(result.commit, 'repo:/main+feature/file.txt')).toString(),
      'ordinary worktree contents')
  } finally {
    await fixture.dispose()
  }
})

test('commit refuses storage redirected into a source repository', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = await fixture.repository('source')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const refs = await fixture.git(['for-each-ref'], source)
    await rename(fixture.path('backup/.bak/main.git'), fixture.path('backup/.bak/saved.git'))
    await symlink(fixture.path('source/.git'), fixture.path('backup/.bak/main.git'),
      process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(store.commit({
      pathspec: `#file = "${fixture.path('source/file.txt')}"`, message: 'must not write source refs', identity, content: content(root),
    }))
    assert.equal(await fixture.git(['for-each-ref'], source), refs)
  } finally {
    await fixture.dispose()
  }
})

test('captured contents that never reach the remote cannot pass the publication gate', async () => {
  const fixture = await GitFixture.create()
  try {
    const file = await fixture.write('source/file', 'before')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const options = { pathspec: `#file = "${file}"`, message: 'first', identity, content: content(root) }
    const previous = await store.commit(options)
    await fixture.write('source/file', 'after')
    let removed = false
    class LostBlob extends GitProcess {
      override async run(args: readonly string[], request: GitRequest) {
        const result = await super.run(args, request)
        if (!removed && args[0] === 'hash-object' && request.gitDirectory?.includes('staging')) {
          const oid = result.stdout.toString().trim()
          await unlink(join(request.gitDirectory, 'objects', oid.slice(0, 2), oid.slice(2)))
          removed = true
        }
        return result
      }
    }
    await assert.rejects(new SnapshotStore(root, new LostBlob()).commit({
      ...options, content: new RemotePacks(root, content(root).objects, url, { git: new LostBlob() }),
    }), /did not reach the remote/u)
    assert.ok(removed)
    assert.equal(await fixture.git(['--git-dir=' + fixture.path('backup/.bak/main.git'), 'rev-parse', 'HEAD']), previous.commit)
  } finally {
    await fixture.dispose()
  }
})

test('a later nested repository mount selects its referenced Git storage despite an earlier parent exclusion', async () => {
  const fixture = await GitFixture.create()
  try {
    const outer = await fixture.repository('outer')
    const child = await fixture.repository('outer/child')
    await mkdir(fixture.path('outer/.git/modules'))
    await rename(fixture.path('outer/child/.git'), fixture.path('outer/.git/modules/child'))
    await fixture.write('outer/child/.git', 'gitdir: ../.git/modules/child\n')
    const root = fixture.path('backup')
    const store = new SnapshotStore(root)
    await store.init()
    const result = await store.commit({
      pathspec: `#outer = "${outer}"\n!#outer/.git\nrepo:/child = "${child}"`,
      message: 'nested owner', identity, content: content(root),
    })
    assert.equal((await reader(root).read(result.commit, 'repo:/child/file.txt')).toString(), 'original\n')
    const manifest = await reader(root).manifest(result.commit)
    assert.equal(manifest.repositories.length, 1)
    assert.ok(manifest.repositories[0]!.administrative.some(entry => entry.path === 'HEAD'))
  } finally {
    await fixture.dispose()
  }
})
