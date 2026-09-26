import assert from 'node:assert/strict'
import { link, mkdir, opendir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { directoryNames, scanningIO, sourcePath } from './scanning-utils.ts'
import GitFixture from '../testing/GitFixture.ts'

test('identities distinguish hardlinks from path spellings and resolve missing suffixes through junctions', async () => {
  const fixture = await GitFixture.create()
  const root = fixture.root
  try {
    await mkdir(join(root, 'data'))
    await writeFile(join(root, 'data', 'a'), 'contents')
    await link(join(root, 'data', 'a'), join(root, 'b'))
    await symlink(join(root, 'data'), join(root, 'mirror'), process.platform === 'win32' ? 'junction' : 'dir')
    const a = await scanningIO.inspect(sourcePath(join(root, 'data', 'a')))
    const b = await scanningIO.inspect(sourcePath(join(root, 'b')))
    assert.equal(a.id, b.id)
    assert.notDeepEqual(a.source, b.source)
    const mirror = await scanningIO.inspect(sourcePath(join(root, 'mirror')))
    assert.deepEqual(mirror.source, (await scanningIO.inspect(sourcePath(join(root, 'data')))).source)
    assert.ok(mirror.symbolic)
    assert.deepEqual(
      await scanningIO.resolveRule(sourcePath(join(root, 'mirror', 'missing', 'child'))),
      sourcePath(join(root, 'data', 'missing', 'child')),
    )
  } finally {
    await fixture.dispose()
  }
})

test('directory iteration releases its handle when a consumer exits early', async () => {
  const fixture = await GitFixture.create()
  const root = fixture.root
  try {
    await writeFile(join(root, 'a'), '')
    const handle = await opendir(root, { encoding: 'buffer' as BufferEncoding })
    for await (const name of directoryNames(sourcePath(root), async () => handle)) {
      assert.equal(name, 'a')
      break
    }
    await assert.rejects(handle.read(), { code: 'ERR_DIR_CLOSED' })
  } finally {
    await fixture.dispose()
  }
})

test('invalid filename bytes fail without leaking the directory handle', async () => {
  const fixture = await GitFixture.create()
  try {
    const handle = await opendir(fixture.root)
    const malformed = {
      read: async () => ({ name: Buffer.from([0xff]) }),
      close: () => handle.close(),
    } as unknown as typeof handle
    const names = directoryNames(sourcePath(fixture.root), async () => malformed)
    await assert.rejects(names.next(), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' })
    await assert.rejects(handle.read(), { code: 'ERR_DIR_CLOSED' })
  } finally {
    await fixture.dispose()
  }
})

test('text paths from filesystem metadata cannot silently replace invalid UTF-8', async () => {
  const fixture = await GitFixture.create()
  try {
    const valid = await fixture.write('valid', Buffer.from([0xc3, 0xa9]))
    assert.equal(await scanningIO.readText(sourcePath(valid)), '\u00e9')
    const invalid = await fixture.write('invalid', Buffer.from([0xff]))
    await assert.rejects(scanningIO.readText(sourcePath(invalid)), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' })
  } finally {
    await fixture.dispose()
  }
})
