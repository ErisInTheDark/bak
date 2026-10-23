import assert from 'node:assert/strict'
import { test } from 'node:test'
import EncryptionKey from './EncryptionKey.ts'

test('passphrases derive stable key ids and short passphrases reject', async () => {
  const [first, again, other] = await Promise.all([
    EncryptionKey.fromPassphrase('correct horse battery staple'),
    EncryptionKey.fromEnvironment({ [EncryptionKey.environmentName]: 'correct horse battery staple' }),
    EncryptionKey.fromPassphrase('correct horse battery stapler'),
  ])
  assert.deepEqual(first.id, again.id)
  assert.notDeepEqual(first.id, other.id)
  await assert.rejects(EncryptionKey.fromPassphrase('too short'), /at least 16/u)
  await assert.rejects(EncryptionKey.fromEnvironment({}), /BAK_ENCRYPTION_PASSPHRASE/u)
})
