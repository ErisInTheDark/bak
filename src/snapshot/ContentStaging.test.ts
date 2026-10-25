import assert from 'node:assert/strict'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanningIO, sourcePath } from '../filesystem/scanning-utils.ts'
import RemotePacks from '../remote/RemotePacks.ts'
import GitFixture from '../testing/GitFixture.ts'
import MemoryObjectStore from '../testing/MemoryObjectStore.ts'
import ContentStaging from './ContentStaging.ts'

test('staging uploads in bounded packs, empties itself and never uploads covered contents again', async () => {
  const fixture = await GitFixture.create()
  try {
    const files = []
    for (let index = 0; index < 5; index++) {
      files.push(await scanningIO.inspect(sourcePath(await fixture.write(`source/${index}`, `${index}`.repeat(4_000)))))
    }
    const root = fixture.path('backup')
    const objects = new MemoryObjectStore()
    const packs = new RemotePacks(root, objects, 'b2://fixture-bucket/staging', { packSize: 6_000 })
    const staging = new ContentStaging(packs, null, 'first')
    const oids = []
    for (const file of files) oids.push(await staging.file('main', 'sha1', file))
    const flushed = [...objects.objects.keys()].filter(name => name.endsWith('.pack')).length
    assert.ok(flushed >= 2, 'staging flushes before the capture finishes')
    const first = await staging.finish()
    await staging[Symbol.asyncDispose]()
    await assert.rejects(stat(join(root, '.bak', 'staging', 'first')), /ENOENT/u)
    for (const oid of oids) assert.ok(await staging.covers('main', oid))
    for (const [index, oid] of oids.entries()) {
      assert.equal((await packs.read('main', first.stores.main!, oid, 'sha1')).data.toString(), `${index}`.repeat(4_000))
    }
    const uploaded = objects.objects.size
    const again = new ContentStaging(packs, first, 'second')
    for (const file of files) await again.file('main', 'sha1', file)
    assert.deepEqual(await again.finish(), first)
    await again[Symbol.asyncDispose]()
    assert.equal(objects.objects.size, uploaded)
    assert.deepEqual(await readdir(join(root, '.bak', 'staging')), [])
  } finally {
    await fixture.dispose()
  }
})
