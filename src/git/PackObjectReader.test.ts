import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import GitFixture from '../testing/GitFixture.ts'
import GitProcess from './GitProcess.ts'
import PackIndex from './PackIndex.ts'
import PackObjectReader from './PackObjectReader.ts'

const git = new GitProcess()

async function packed(fixture: GitFixture, options: readonly string[]) {
  const repository = await fixture.repository('source')
  const lines = Array.from({ length: 2_000 }, (_, index) => `line ${index} of a file that deltas well\n`)
  for (let version = 0; version < 4; version++) {
    lines[version * 300] = `edited in version ${version}\n`
    await fixture.write('source/large.txt', lines.join(''))
    await fixture.git(['add', '.'], repository)
    await fixture.git(['commit', '-m', `version ${version}`], repository)
  }
  const objects = (await git.run(['rev-list', '--objects', '--all'], { cwd: repository })).stdout.toString()
  const hash = (await git.run(['pack-objects', ...options, '-q', fixture.path('pack')], {
    cwd: repository, input: objects.split('\n').map(line => line.split(' ')[0]).join('\n'),
  })).stdout.toString().trim()
  const base = fixture.path(`pack-${hash}`)
  const verify = (await git.run(['verify-pack', '-v', `${base}.idx`], { cwd: repository })).stdout.toString()
  const deltas = verify.split('\n').filter(line => /^[0-9a-f]{40} \w+ +\d+ \d+ \d+ \d+ [0-9a-f]{40}$/u.test(line)).length
  return { repository, pack: await readFile(`${base}.pack`), index: await readFile(`${base}.idx`), deltas }
}

for (const [style, options] of [['offset', ['--delta-base-offset']], ['reference', []]] as const) {
  test(`every object of a pack with ${style} deltas reads back through ranges and verifies`, async () => {
    const fixture = await GitFixture.create()
    try {
      const { repository, pack, index: bytes, deltas } = await packed(fixture, options)
      assert.ok(deltas > 0, 'fixture pack must contain deltas')
      const index = PackIndex.parse(bytes, 'sha1')
      const listed = (await git.run(['show-index'], { cwd: repository, input: bytes })).stdout.toString()
        .trim().split('\n').map(line => line.split(' ')[1]).sort()
      assert.deepEqual(index.oids, listed)
      const reader = new PackObjectReader(index, pack.byteLength, async range => pack.subarray(range.start, range.end))
      for (const oid of index.oids) {
        const object = await reader.object(oid)
        assert.equal(object.type, (await git.run(['cat-file', '-t', oid], { cwd: repository })).stdout.toString().trim())
        assert.deepEqual(object.data, (await git.run(['cat-file', object.type, oid], { cwd: repository })).stdout)
      }
    } finally {
      await fixture.dispose()
    }
  })
}

test('a corrupted pack entry or index is rejected', async () => {
  const fixture = await GitFixture.create()
  try {
    const { pack, index: bytes } = await packed(fixture, ['--delta-base-offset'])
    const index = PackIndex.parse(bytes, 'sha1')
    const oid = index.oids[0]!
    const offset = index.offset(oid)!
    const damaged = Buffer.from(pack)
    damaged[index.entryEnd(offset, pack.byteLength) - 1]! ^= 0xff
    const reader = new PackObjectReader(index, pack.byteLength, async range => damaged.subarray(range.start, range.end))
    await assert.rejects(reader.object(oid))
    const badIndex = Buffer.from(bytes)
    badIndex[8 + 1024 + 3]! ^= 1
    assert.throws(() => PackIndex.parse(badIndex, 'sha1'), /checksum/u)
  } finally {
    await fixture.dispose()
  }
})
