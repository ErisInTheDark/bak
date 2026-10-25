import assert from 'node:assert/strict'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { test } from 'node:test'
import PathspecEvaluator from '../config/PathspecEvaluator.ts'
import Scanner from '../filesystem/Scanner.ts'
import RemotePacks from '../remote/RemotePacks.ts'
import ContentStaging from '../snapshot/ContentStaging.ts'
import GitFixture from '../testing/GitFixture.ts'
import MemoryObjectStore from '../testing/MemoryObjectStore.ts'
import RepositoryCapture from './RepositoryCapture.ts'
import { sourcePath } from '../filesystem/scanning-utils.ts'

const url = 'b2://fixture-bucket/repositories'

test('repository capture uploads reflog-only history and the raw index without source dependencies', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = await fixture.repository('source')
    const initial = await fixture.git(['rev-parse', 'HEAD'], source)
    await fixture.write('source/file.txt', 'reflog-only\n')
    await fixture.git(['commit', '-am', 'transient'], source)
    const transient = await fixture.git(['rev-parse', 'HEAD'], source)
    const transientBlob = await fixture.git(['rev-parse', 'HEAD:file.txt'], source)
    await fixture.git(['reset', '--hard', initial], source)
    await fixture.write('source/file.txt', 'staged\n')
    await fixture.git(['add', '.'], source)
    const index = await readFile(fixture.path('source/.git/index'))
    const records = []
    for await (const record of new Scanner(new PathspecEvaluator(`repo:/source = "${source}"`)).scan()) records.push(record)
    const repository = records.find(record => record.type === 'repository')
    assert.ok(repository)
    const directory = fixture.path('captured.git')
    await fixture.git(['init', '--bare', '--template=', directory])
    await mkdir(fixture.path('backup'))
    const packs = new RemotePacks(fixture.path('backup'), new MemoryObjectStore(), url)
    await using staging = new ContentStaging(packs, null, 'first')
    const result = await new RepositoryCapture().capture({
      source: repository,
      identity: {
        id: 'fixture', name: 'source', commonDirectory: repository.commonDirectory,
        source: repository.source, objectFormat: repository.objectFormat,
      },
      directory, staging, author: { name: 'fixture', email: 'fixture@example.invalid' }, transaction: 'first',
      nested: async () => { throw new Error('unexpected nested storage') },
    })
    const uploaded = (await staging.finish()).stores.fixture!
    assert.equal(await fixture.git(['rev-parse', 'HEAD'], source), initial)
    assert.deepEqual(await readFile(fixture.path('source/.git/index')), index)
    await rename(source, fixture.path('source-unavailable'))
    assert.equal((await packs.read('fixture', uploaded, transient, 'sha1')).type, 'commit')
    assert.equal((await packs.read('fixture', uploaded, transientBlob, 'sha1')).data.toString(), 'reflog-only\n')
    const capturedIndex = result.administrative.find(entry => entry.path === 'index')
    assert.ok(capturedIndex?.oid)
    assert.deepEqual((await packs.read('fixture', uploaded, capturedIndex.oid, 'sha1')).data, index)
  } finally {
    await fixture.dispose()
  }
})

test('a failed object upload fails instead of returning captured repository state', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = await fixture.repository('source')
    const directory = fixture.path('captured.git')
    await fixture.git(['init', '--bare', '--template=', directory])
    const commonDirectory = sourcePath(fixture.path('source/.git'))
    class Unreachable extends MemoryObjectStore {
      override async putImmutable(): Promise<void> {
        throw new Error('remote unreachable')
      }
    }
    await mkdir(fixture.path('backup'))
    await using staging = new ContentStaging(new RemotePacks(fixture.path('backup'), new Unreachable(), url), null, 'failed')
    await assert.rejects(new RepositoryCapture().capture({
      source: {
        source: sourcePath(source), gitDirectory: commonDirectory, commonDirectory,
        bare: false, objectFormat: 'sha1', origin: null, worktrees: [],
      },
      identity: { id: 'fixture', name: 'source', source: sourcePath(source), commonDirectory, objectFormat: 'sha1' },
      directory, staging, author: { name: 'fixture', email: 'fixture@example.invalid' }, transaction: 'failed',
      nested: async () => { throw new Error('unexpected nested storage') },
    }), /remote unreachable/u)
    assert.equal(await fixture.git(['--git-dir=' + directory, 'for-each-ref']), '')
  } finally {
    await fixture.dispose()
  }
})
