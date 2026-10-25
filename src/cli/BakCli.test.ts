import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import EncryptionKey from '../crypto/EncryptionKey.ts'
import GitFixture from '../testing/GitFixture.ts'
import MemoryObjectStore from '../testing/MemoryObjectStore.ts'
import BakCli, { type RemoteOpener } from './BakCli.ts'

const key = await EncryptionKey.fromPassphrase('correct horse battery staple')
const url = 'b2://fixture-bucket/cli'

class InterruptibleStore extends MemoryObjectStore {
  failReplace = false

  override async replace(name: string, bytes: Uint8Array): Promise<void> {
    if (this.failReplace) throw new Error('remote unreachable')
    await super.replace(name, bytes)
  }
}

async function session(run: (context: {
  fixture: GitFixture
  cli: BakCli
  store: InterruptibleStore
  output: Buffer[]
  errors: Buffer[]
  text: () => string
}) => Promise<void>): Promise<void> {
  const fixture = await GitFixture.create()
  try {
    const output: Buffer[] = []
    const errors: Buffer[] = []
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    stdout.on('data', chunk => output.push(Buffer.from(chunk)))
    stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
    const store = new InterruptibleStore()
    const openRemote: RemoteOpener = async options => ({ location: options.location, key, store })
    await run({ fixture, cli: new BakCli({ stdout, stderr }, openRemote), store, output, errors, text: () => Buffer.concat(output).toString() })
  } finally {
    await fixture.dispose()
  }
}

const author = ['--author', 'fixture <fixture@example.invalid>']

test('commit captures and publishes, so a clean folder recovers it without a push', () => session(async context => {
  const prefix = ['--root', context.fixture.path('backup')]
  assert.equal(await context.cli.run([...prefix, 'init']), 0)
  const file = await context.fixture.write('source/file', Buffer.from([0, 255, 13, 10]))
  await context.fixture.write('backup/.bakspec', `@remote = ${url}\n#file = "${file}"`)
  assert.equal(await context.cli.run([...prefix, 'commit', '-m', 'first', ...author]), 0)
  assert.match(context.text(), /committed [0-9a-f]{12} and published to/u)
  context.output.length = 0
  assert.equal(await context.cli.run([...prefix, 'log']), 0)
  assert.ok(context.text().includes('first'))
  const restored = ['--root', context.fixture.path('restored')]
  assert.equal(await context.cli.run([...restored, 'clone', url]), 0)
  context.output.length = 0
  assert.equal(await context.cli.run([...restored, 'show', 'HEAD', 'file']), 0)
  assert.deepEqual(Buffer.concat(context.output), Buffer.from([0, 255, 13, 10]))
  context.output.length = 0
  assert.equal(await context.cli.run([...prefix, 'fsck']), 0)
  assert.match(context.text(), /every object is recoverable/u)
  assert.equal(Buffer.concat(context.errors).length, 0)
  context.output.length = 0
  assert.equal(await context.cli.run([...prefix, 'show', 'HEAD', 'missing']), 1)
  assert.equal(Buffer.concat(context.output).length, 0)
  assert.ok(Buffer.concat(context.errors).toString().includes('does not exist'))
}))

test('a failed publish keeps the captured snapshot and push publishes it later', () => session(async context => {
  const prefix = ['--root', context.fixture.path('backup')]
  await context.cli.run([...prefix, 'init'])
  const file = await context.fixture.write('source/file', 'captured')
  await context.fixture.write('backup/.bakspec', `@remote = ${url}\n#file = "${file}"`)
  context.store.failReplace = true
  assert.equal(await context.cli.run([...prefix, 'commit', '-m', 'first', ...author]), 1)
  assert.match(Buffer.concat(context.errors).toString(), /captured [0-9a-f]{12} locally but publishing failed: remote unreachable; run bak push/u)
  assert.equal(context.store.objects.has('HEAD'), false)
  context.store.failReplace = false
  assert.equal(await context.cli.run([...prefix, 'push']), 0)
  assert.match(context.text(), /pushed [0-9a-f]{12}/u)
  assert.equal(await context.cli.run(['--root', context.fixture.path('restored'), 'clone', url]), 0)
}))
