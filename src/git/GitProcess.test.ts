import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import GitFixture from '../testing/GitFixture.ts'
import GitProcess from './GitProcess.ts'

test('Git process transports binary input and output without text conversion', async () => {
  const fixture = await GitFixture.create()
  try {
    const repository = await fixture.repository('source')
    const git = new GitProcess()
    const bytes = Buffer.from([0, 13, 10, 255, 128, 97])
    const written = await git.run(['hash-object', '-w', '--stdin'], { cwd: repository, input: bytes })
    const object = written.stdout.toString().trim()
    const chunks: Buffer[] = []
    const output = new PassThrough()
    output.on('data', chunk => chunks.push(Buffer.from(chunk)))
    await git.run(['cat-file', 'blob', object], { cwd: repository, output })
    assert.deepEqual(Buffer.concat(chunks), bytes)
  } finally {
    await fixture.dispose()
  }
})

test('Git process cancellation closes a command waiting for input', async () => {
  const fixture = await GitFixture.create()
  try {
    const repository = await fixture.repository('source')
    const controller = new AbortController()
    const input = new PassThrough()
    const pending = new GitProcess().run(['hash-object', '--stdin'], {
      cwd: repository, input, signal: controller.signal,
    })
    controller.abort(new Error('capture cancelled'))
    await assert.rejects(pending, /capture cancelled|abort/i)
    assert.equal(input.destroyed, true)
  } finally {
    await fixture.dispose()
  }
})

test('Git process reports failed commands instead of successful empty output', async () => {
  const fixture = await GitFixture.create()
  try {
    await assert.rejects(new GitProcess().run(['not-a-real-command'], { cwd: fixture.root }), /not-a-real-command/)
  } finally {
    await fixture.dispose()
  }
})
