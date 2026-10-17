import assert from 'node:assert/strict'
import { test } from 'node:test'
import RemoteLocation from './RemoteLocation.ts'

test('b2 urls parse into a bucket and optional prefix', () => {
  assert.deepEqual(RemoteLocation.parse('b2://my-bak-bucket'), { backend: 'b2', bucket: 'my-bak-bucket', prefix: '' })
  assert.deepEqual(RemoteLocation.parse('b2://my-bak-bucket/'), { backend: 'b2', bucket: 'my-bak-bucket', prefix: '' })
  assert.deepEqual(RemoteLocation.parse('b2://my-bak-bucket/home/personal/'),
    { backend: 'b2', bucket: 'my-bak-bucket', prefix: 'home/personal' })
  assert.equal(RemoteLocation.format(RemoteLocation.parse('b2://my-bak-bucket/personal')), 'b2://my-bak-bucket/personal')
})

test('unsupported or unsafe remotes are rejected', () => {
  for (const url of [
    'my-bak-bucket', 's3://my-bak-bucket', 'b2://short', 'b2://b2-reserved', 'b2://bad_bucket',
    'b2://my-bak-bucket/a//b', 'b2://my-bak-bucket/../escape', 'b2://my-bak-bucket/./here', 'b2://my-bak-bucket/wild*',
  ]) {
    assert.throws(() => RemoteLocation.parse(url), Error, url)
  }
})
