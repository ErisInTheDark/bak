import assert from 'node:assert/strict'
import { readFile, rename } from 'node:fs/promises'
import { test } from 'node:test'
import PathspecEvaluator from '../config/PathspecEvaluator.ts'
import Scanner from '../filesystem/Scanner.ts'
import GitProcess from '../git/GitProcess.ts'
import GitFixture from '../testing/GitFixture.ts'
import RepositoryCapture from './RepositoryCapture.ts'
import { sourcePath } from '../filesystem/scanning-utils.ts'

test('repository capture retains reflog-only history and raw index without source dependencies', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = await fixture.repository('source')
    const initial = await fixture.git(['rev-parse', 'HEAD'], source)
    await fixture.write('source/file.txt', 'reflog-only\n')
    await fixture.git(['commit', '-am', 'transient'], source)
    const transient = await fixture.git(['rev-parse', 'HEAD'], source)
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
    const result = await new RepositoryCapture().capture({
      source: repository,
      identity: {
        id: 'fixture', name: 'source', commonDirectory: repository.commonDirectory,
        source: repository.source, objectFormat: repository.objectFormat,
      },
      directory, author: { name: 'fixture', email: 'fixture@example.invalid' }, transaction: 'first',
      nested: async () => { throw new Error('unexpected nested storage') },
    })
    assert.equal(await fixture.git(['rev-parse', 'HEAD'], source), initial)
    assert.deepEqual(await readFile(fixture.path('source/.git/index')), index)
    await rename(source, fixture.path('source-unavailable'))
    assert.equal(await fixture.git(['--git-dir=' + directory, 'show', `${transient}:file.txt`]), 'reflog-only')
    const capturedIndex = result.administrative.find(entry => entry.path === 'index')
    assert.ok(capturedIndex?.oid)
    const read = await new GitProcess().run(['cat-file', 'blob', capturedIndex.oid], { cwd: fixture.root, gitDirectory: directory })
    assert.deepEqual(read.stdout, index)
    await fixture.git(['--git-dir=' + directory, 'gc', '--prune=now'])
    assert.equal(await fixture.git(['--git-dir=' + directory, 'show', `${transient}:file.txt`]), 'reflog-only')
  } finally {
    await fixture.dispose()
  }
})

test('a rejected pack transfer fails instead of returning captured repository state', async () => {
  const fixture = await GitFixture.create()
  try {
    const source = await fixture.repository('source')
    const directory = fixture.path('wrong-format.git')
    await fixture.git(['init', '--bare', '--object-format=sha256', '--template=', directory])
    const commonDirectory = sourcePath(fixture.path('source/.git'))
    await assert.rejects(new RepositoryCapture().capture({
      source: {
        source: sourcePath(source), gitDirectory: commonDirectory, commonDirectory,
        bare: false, objectFormat: 'sha1', origin: null, worktrees: [],
      },
      identity: { id: 'fixture', name: 'source', source: sourcePath(source), commonDirectory, objectFormat: 'sha1' },
      directory, author: { name: 'fixture', email: 'fixture@example.invalid' }, transaction: 'failed',
      nested: async () => { throw new Error('unexpected nested storage') },
    }))
    assert.equal(await fixture.git(['--git-dir=' + directory, 'for-each-ref']), '')
  } finally {
    await fixture.dispose()
  }
})
