import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import GitFixture from '../testing/GitFixture.ts'
import { FileCapture } from './capture-file.ts'
import { scanningIO, sourcePath } from './scanning-utils.ts'

test('file capture preserves bytes and rejects changes before and during capture', async () => {
  const fixture = await GitFixture.create()
  try {
    const path = await fixture.write('bytes', Buffer.from([0, 255, 13, 10]))
    const file = await scanningIO.inspect(sourcePath(path))
    const bytes = await FileCapture.read(file, async stream => {
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks)
    })
    assert.deepEqual(bytes, Buffer.from([0, 255, 13, 10]))
    await assert.rejects(FileCapture.read(file, async stream => {
      for await (const _chunk of stream) { /* drain before modifying the fixture */ }
      await writeFile(path, 'changed while capture is pending')
    }), /changed/)
    await assert.rejects(FileCapture.read(file, async () => 'not read'), /changed/)
  } finally {
    await fixture.dispose()
  }
})

test('file capture rejects a consumer that does not finish reading', async () => {
  const fixture = await GitFixture.create()
  try {
    const path = await fixture.write('bytes', 'selected bytes')
    const file = await scanningIO.inspect(sourcePath(path))
    await assert.rejects(FileCapture.read(file, async () => 'premature success'), /did not finish/)
  } finally {
    await fixture.dispose()
  }
})
