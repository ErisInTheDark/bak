import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import GitFixture from '../testing/GitFixture.ts'
import BakCli from './BakCli.ts'

test('backup commands initialise, capture, list and read without mixing diagnostics into bytes', async () => {
  const fixture = await GitFixture.create()
  try {
    const output: Buffer[] = []
    const errors: Buffer[] = []
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    stdout.on('data', chunk => output.push(Buffer.from(chunk)))
    stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
    const cli = new BakCli({ stdout, stderr })
    const prefix = ['--root', fixture.path('backup')]
    assert.equal(await cli.run([...prefix, 'init']), 0)
    const file = await fixture.write('source/file', Buffer.from([0, 255, 13, 10]))
    await fixture.write('backup/bak.pathspec', `#file = "${file}"`)
    assert.equal(await cli.run([...prefix, 'commit', '-m', 'first', '--author', 'fixture <fixture@example.invalid>']), 0)
    output.length = 0
    assert.equal(await cli.run([...prefix, 'log']), 0)
    assert.ok(Buffer.concat(output).toString().includes('first'))
    output.length = 0
    assert.equal(await cli.run([...prefix, 'show', 'HEAD', 'file']), 0)
    assert.deepEqual(Buffer.concat(output), Buffer.from([0, 255, 13, 10]))
    assert.equal(Buffer.concat(errors).length, 0)
    output.length = 0
    assert.equal(await cli.run([...prefix, 'show', 'HEAD', 'missing']), 1)
    assert.equal(Buffer.concat(output).length, 0)
    assert.ok(Buffer.concat(errors).toString().includes('does not exist'))
  } finally {
    await fixture.dispose()
  }
})
