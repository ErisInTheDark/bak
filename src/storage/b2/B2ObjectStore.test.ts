import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import B2ObjectStore, { B2Error, B2Retry } from './B2ObjectStore.ts'

const api = 'https://api.fake.invalid'
const download = 'https://download.fake.invalid'

interface Fault {
  readonly status: number
  readonly retryAfter?: string
  /** Apply the request first, then report failure (a lost response). */
  readonly applied?: boolean
}

/** In-memory stand-in for the B2 native API surface B2ObjectStore uses. */
class FakeB2 {
  readonly files = new Map<string, { id: string, bytes: Uint8Array }>()
  /** Call labels: `authorize`, `download`, `upload` or the API name. */
  readonly calls: string[] = []
  readonly validTokens = new Set<string>()
  /** Queued failures per call label, consumed in order. */
  readonly faults = new Map<string, Fault[]>()
  /** Replaces the upload receipt when set. */
  receipt: object | undefined
  issueValidTokens = true
  #counter = 0

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const label = url.origin === download ? 'download'
      : url.pathname.endsWith('b2_authorize_account') ? 'authorize' : url.pathname.split('/').at(-1)!
    this.calls.push(label)
    const fault = this.faults.get(label)?.shift()
    if (fault && !fault.applied) return this.#fail(fault)
    const response = await this.#handle(input, init)
    return fault ? this.#fail(fault) : response
  }

  #fail(fault: Fault): Response {
    return new Response(JSON.stringify({ status: fault.status, code: 'fault', message: 'injected' }), {
      status: fault.status, headers: fault.retryAfter ? { 'Retry-After': fault.retryAfter } : {},
    })
  }

  readonly #handle: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    const json = (status: number, body: object) => new Response(JSON.stringify(body), { status })
    if (url.pathname.endsWith('b2_authorize_account')) {
      const token = `account-${++this.#counter}`
      if (this.issueValidTokens) this.validTokens.add(token)
      return json(200, { accountId: 'acct', authorizationToken: token, apiInfo: { storageApi: { apiUrl: api, downloadUrl: download } } })
    }
    const name = url.pathname.split('/').at(-1)!
    if (!this.validTokens.has(headers.get('Authorization') ?? '')) {
      return json(401, { status: 401, code: 'expired_auth_token', message: 'expired' })
    }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    if (url.origin === download) {
      const key = decodeURIComponent(url.pathname.replace('/file/bucket/', ''))
      const file = this.files.get(key)
      if (!file) return new Response(null, { status: 404 })
      const sha1 = createHash('sha1').update(file.bytes).digest('hex')
      const range = /^bytes=(\d+)-(\d+)$/u.exec(headers.get('Range') ?? '')
      const bytes = range ? file.bytes.slice(Number(range[1]), Number(range[2]) + 1) : file.bytes
      return new Response(method === 'HEAD' ? null : new Uint8Array(bytes), {
        status: range ? 206 : 200,
        headers: { 'Content-Length': String(bytes.byteLength), 'x-bz-content-sha1': sha1 },
      })
    }
    switch (name) {
      case 'b2_list_buckets': return json(200, { buckets: [{ bucketId: 'bucket-id', bucketName: 'bucket' }] })
      case 'b2_get_upload_url': {
        const token = `upload-${++this.#counter}`
        this.validTokens.add(token)
        return json(200, { uploadUrl: `${api}/upload/upload`, authorizationToken: token })
      }
      case 'upload': {
        const bytes = new Uint8Array(init.body as Uint8Array)
        assert.equal(headers.get('X-Bz-Content-Sha1'), createHash('sha1').update(bytes).digest('hex'))
        this.files.set(decodeURIComponent(headers.get('X-Bz-File-Name')!), { id: `file-${++this.#counter}`, bytes })
        return json(200, this.receipt ?? { contentSha1: headers.get('X-Bz-Content-Sha1'), contentLength: bytes.byteLength })
      }
      case 'b2_list_file_versions': return json(200, {
        files: [...this.files].filter(([key]) => key.startsWith(String(body.prefix))).map(([fileName, { id }]) => ({ fileName, fileId: id })),
      })
      case 'b2_delete_file_version':
        this.files.delete(String(body.fileName))
        return json(200, {})
      default: return json(400, { status: 400, code: 'bad_request', message: name })
    }
  }
}

function store(fake: FakeB2, waits: number[] = []): B2ObjectStore {
  return new B2ObjectStore({ applicationKeyId: 'id', applicationKey: 'key' },
    { backend: 'b2', bucket: 'bucket', prefix: 'home/personal' },
    { fetcher: fake.fetch, sleep: async (milliseconds, signal) => { signal?.throwIfAborted(); waits.push(milliseconds) }, random: () => 0.5 })
}

test('a busy upload retries on a fresh upload URL after backing off', async () => {
  const fake = new FakeB2()
  const waits: number[] = []
  fake.faults.set('upload', [{ status: 503 }, { status: 429, retryAfter: '7' }])
  await store(fake, waits).putImmutable('key', new Uint8Array([1, 2]))
  assert.deepEqual(waits, [500, 7_000])
  assert.equal(fake.calls.filter(call => call === 'b2_get_upload_url').length, 3)
  assert.deepEqual(fake.files.get('home/personal/key')?.bytes, new Uint8Array([1, 2]))
})

test('an upload whose response was lost is found on retry instead of uploaded again', async () => {
  const fake = new FakeB2()
  fake.faults.set('upload', [{ status: 500, applied: true }])
  await store(fake).putImmutable('key', new Uint8Array([1]))
  assert.equal(fake.calls.filter(call => call === 'upload').length, 1)
})

test('persistent server errors give up after the attempt limit and client errors do not retry', async () => {
  const fake = new FakeB2()
  const waits: number[] = []
  const objects = store(fake, waits)
  await objects.putImmutable('key', new Uint8Array([1]))
  fake.calls.length = 0
  fake.faults.set('download', Array.from({ length: 10 }, () => ({ status: 500 })))
  await assert.rejects(objects.get('key'), (error: unknown) => error instanceof B2Error && error.status === 500)
  assert.equal(fake.calls.length, B2Retry.maxAttempts)
  assert.equal(waits.length, B2Retry.maxAttempts - 1)
  fake.calls.length = 0
  fake.faults.set('download', [{ status: 400 }])
  await assert.rejects(objects.get('key'), (error: unknown) => error instanceof B2Error && error.status === 400)
  assert.equal(fake.calls.length, 1)
})

test('aborting during backoff stops retrying', async () => {
  const fake = new FakeB2()
  const controller = new AbortController()
  const objects = new B2ObjectStore({ applicationKeyId: 'id', applicationKey: 'key' },
    { backend: 'b2', bucket: 'bucket', prefix: '' }, {
      fetcher: fake.fetch, random: () => 0,
      sleep: async (_milliseconds, signal) => { controller.abort(new Error('stopped')); signal?.throwIfAborted() },
    })
  fake.faults.set('b2_get_upload_url', Array.from({ length: 10 }, () => ({ status: 503 })))
  await assert.rejects(objects.putImmutable('key', new Uint8Array([1]), controller.signal), /stopped/u)
  assert.equal(fake.calls.filter(call => call === 'b2_get_upload_url').length, 1)
})

test('an upload receipt that disagrees with the sent bytes rejects', async () => {
  const fake = new FakeB2()
  fake.receipt = { contentSha1: '0'.repeat(40), contentLength: 1 }
  await assert.rejects(store(fake).putImmutable('key', new Uint8Array([1])), /expected 1 bytes with sha1/u)
})

test('full-jitter backoff grows exponentially up to the cap', () => {
  assert.equal(B2Retry.delay(1, undefined, 0.999), 999)
  assert.equal(B2Retry.delay(3, undefined, 0.5), 2_000)
  assert.equal(B2Retry.delay(20, undefined, 0.5), B2Retry.capMilliseconds / 2)
  assert.equal(B2Retry.delay(20, 3, 0.5), 3_000)
})

test('objects are stored once under the prefix, read back in whole or by range, and deleted', async () => {
  const fake = new FakeB2()
  const objects = store(fake)
  const bytes = new TextEncoder().encode('hello b2 pack')
  await objects.putImmutable('packs/a b', bytes)
  await objects.putImmutable('packs/a b', bytes)
  assert.equal(fake.calls.filter(call => call === 'upload').length, 1)
  assert.deepEqual([...fake.files.keys()], ['home/personal/packs/a b'])
  assert.deepEqual(await objects.get('packs/a b'), bytes)
  assert.deepEqual(await objects.getRange('packs/a b', { start: 6, end: 8 }), bytes.slice(6, 8))
  assert.deepEqual(await objects.head('packs/a b'), { size: bytes.byteLength })
  await assert.rejects(objects.putImmutable('packs/a b', new TextEncoder().encode('different')), /different content/u)
  await objects.replace('HEAD', new TextEncoder().encode('one'))
  await objects.replace('HEAD', new TextEncoder().encode('two'))
  assert.deepEqual(await objects.get('HEAD'), new TextEncoder().encode('two'))
  await objects.delete('packs/a b')
  assert.equal(await objects.get('packs/a b'), undefined)
  assert.equal(await objects.head('packs/a b'), undefined)
})

test('an expired token is renewed once and the request succeeds', async () => {
  const fake = new FakeB2()
  const objects = store(fake)
  await objects.putImmutable('key', new Uint8Array([1, 2, 3]))
  fake.validTokens.clear()
  assert.deepEqual(await objects.get('key'), new Uint8Array([1, 2, 3]))
  assert.equal(fake.calls.filter(call => call === 'authorize').length, 2)
})

test('an expired upload URL is replaced without reauthorising the account', async () => {
  const fake = new FakeB2()
  const objects = store(fake)
  await objects.putImmutable('first', new Uint8Array([1]))
  for (const token of fake.validTokens) if (token.startsWith('upload-')) fake.validTokens.delete(token)
  await objects.putImmutable('second', new Uint8Array([2]))
  assert.equal(fake.calls.filter(call => call === 'authorize').length, 1)
  assert.equal(fake.calls.filter(call => call === 'b2_get_upload_url').length, 2)
  assert.deepEqual(await objects.get('second'), new Uint8Array([2]))
})

test('repeated authorisation failure rejects after one renewal', async () => {
  const fake = new FakeB2()
  const objects = store(fake)
  await objects.putImmutable('key', new Uint8Array([1]))
  fake.validTokens.clear()
  fake.issueValidTokens = false
  await assert.rejects(objects.get('key'), (error: unknown) => error instanceof B2Error && error.status === 401)
  assert.equal(fake.calls.filter(call => call === 'authorize').length, 2)
})
