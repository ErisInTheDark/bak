import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, opendir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { directoryNames, scanningIO, sourcePath } from './scanning-utils.ts'

test('identities distinguish hardlinks from path spellings and resolve missing suffixes through junctions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bak-fs-'))
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
    await rm(root, { recursive: true, force: true })
  }
})

test('directory iteration releases its handle when a consumer exits early', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bak-fs-'))
  try {
    await writeFile(join(root, 'a'), '')
    const handle = await opendir(root, { encoding: 'buffer' as BufferEncoding })
    for await (const name of directoryNames(sourcePath(root), async () => handle)) {
      assert.equal(name, 'a')
      break
    }
    await assert.rejects(handle.read(), { code: 'ERR_DIR_CLOSED' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
