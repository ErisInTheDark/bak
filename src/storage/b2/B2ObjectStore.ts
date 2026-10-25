import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Environment } from '../../config/load-environment.ts'
import type RemoteLocation from '../../config/RemoteLocation.ts'
import type ObjectStore from '../ObjectStore.ts'
import type { ByteRange, ObjectHead } from '../ObjectStore.ts'

export interface B2Credentials {
  readonly applicationKeyId: string
  readonly applicationKey: string
}

export interface B2Options {
  readonly fetcher?: typeof fetch
  /** Abortable wait used between retries. */
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  /** Uniform [0, 1) source for retry jitter. */
  readonly random?: () => number
}

interface Session {
  readonly accountId: string
  readonly apiUrl: string
  readonly downloadUrl: string
  readonly token: string
  readonly bucketId: string
}

interface UploadTarget {
  readonly uploadUrl: string
  readonly token: string
}

const authorizeUrl = 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account'
const apiVersionPath = '/b2api/v3/'
const transientStatuses = new Set([408, 429, 500, 502, 503, 504])

export class B2Error extends Error {
  constructor(
    readonly operation: string, readonly status: number, readonly code: string, message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`b2 ${operation} failed (${status} ${code}): ${message}`)
  }

  get transient(): boolean {
    return transientStatuses.has(this.status)
  }
}

export namespace B2Retry {
  export const maxAttempts = 6
  export const baseMilliseconds = 1_000
  export const capMilliseconds = 30_000

  /** Wait before retry number `attempt` (1-based): b2's Retry-After, else full-jitter exponential backoff. */
  export function delay(attempt: number, retryAfterSeconds: number | undefined, random: number): number {
    if (retryAfterSeconds !== undefined) return retryAfterSeconds * 1_000
    return Math.floor(random * Math.min(capMilliseconds, baseMilliseconds * 2 ** (attempt - 1)))
  }

  /** Network failures (fetch rejects with TypeError) and b2's documented transient statuses. */
  export function transient(error: unknown): boolean {
    return error instanceof B2Error ? error.transient : error instanceof TypeError
  }
}

function encodeFileName(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex')
}

export default class B2ObjectStore implements ObjectStore {
  static readonly environmentNames = ['B2_APPLICATION_KEY_ID', 'B2_APPLICATION_KEY'] as const

  static fromEnvironment(environment: Environment, location: RemoteLocation, options: B2Options = {}): B2ObjectStore {
    const [applicationKeyId, applicationKey] = B2ObjectStore.environmentNames.map(name => {
      const value = environment[name]?.trim()
      if (!value) throw new Error(`${name} is empty`)
      return value
    })
    return new B2ObjectStore({ applicationKeyId: applicationKeyId!, applicationKey: applicationKey! }, location, options)
  }

  #session: Promise<Session> | undefined
  #upload: Promise<UploadTarget> | undefined
  readonly #fetch: typeof fetch
  readonly #sleep: NonNullable<B2Options['sleep']>
  readonly #random: () => number

  constructor(
    private readonly credentials: B2Credentials,
    readonly location: RemoteLocation,
    options: B2Options = {},
  ) {
    this.#fetch = options.fetcher ?? fetch
    this.#sleep = options.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, signal ? { signal } : {}))
    this.#random = options.random ?? Math.random
  }

  get bucketName(): string {
    return this.location.bucket
  }

  #fileName(key: string): string {
    return this.location.prefix ? `${this.location.prefix}/${key}` : key
  }

  async putImmutable(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const sha1 = sha1Hex(bytes)
    // A retried upload stats again, so one that landed but lost its response is recognised.
    await this.#attempt(async session => {
      const existing = await this.#stat(session, key, signal)
      if (existing) {
        if (existing.sha1 === sha1 && existing.size === bytes.byteLength) return
        throw new Error(`b2 object ${key} already exists with different content`)
      }
      await this.#send(session, key, bytes, sha1, signal)
    }, signal)
  }

  async replace(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const sha1 = sha1Hex(bytes)
    await this.#attempt(session => this.#send(session, key, bytes, sha1, signal), signal)
  }

  async get(key: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    return this.#attempt(async session => {
      const response = await this.#download(session, 'GET', key, undefined, signal)
      return response ? new Uint8Array(await response.arrayBuffer()) : undefined
    }, signal)
  }

  async getRange(key: string, range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start) {
      throw new RangeError(`invalid byte range ${range.start}-${range.end}`)
    }
    return this.#attempt(async session => {
      const response = await this.#download(session, 'GET', key, range, signal)
      if (!response) throw new Error(`b2 object ${key} does not exist`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (response.status !== 206 || bytes.byteLength !== range.end - range.start) {
        throw new Error(`b2 returned ${bytes.byteLength} bytes for range ${range.start}-${range.end} of ${key}`)
      }
      return bytes
    }, signal)
  }

  async head(key: string, signal?: AbortSignal): Promise<ObjectHead | undefined> {
    const stat = await this.#attempt(session => this.#stat(session, key, signal), signal)
    return stat && { size: stat.size }
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    const fileName = this.#fileName(key)
    await this.#attempt(async session => {
      for (;;) {
        const { files } = await this.#api<{ files: { fileId: string, fileName: string }[] }>(session, 'b2_list_file_versions',
          { bucketId: session.bucketId, prefix: fileName, startFileName: fileName, maxFileCount: 100 }, signal)
        const versions = files.filter(file => file.fileName === fileName)
        if (!versions.length) return
        for (const version of versions) {
          await this.#api(session, 'b2_delete_file_version', { fileName: version.fileName, fileId: version.fileId }, signal)
        }
      }
    }, signal)
  }

  /**
   * Sole retry owner. Transient failures back off and retry up to `B2Retry.maxAttempts`;
   * an expired account token renews once. Helpers below make single requests.
   */
  async #attempt<T>(operation: (session: Session) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let renewed = false
    for (let attempt = 1; ; attempt++) {
      const pending = this.#currentSession(signal)
      try {
        return await operation(await pending)
      } catch (error) {
        signal?.throwIfAborted()
        const expired = error instanceof B2Error && error.status === 401
        const uploadExpired = expired && error.operation === 'upload'
        if (expired && !uploadExpired && error.operation !== 'b2_authorize_account') {
          if (this.#session === pending) this.#session = undefined
          if (renewed) throw error
          renewed = true
          continue
        }
        if (!(uploadExpired || B2Retry.transient(error)) || attempt >= B2Retry.maxAttempts) throw error
        // #send already dropped the upload URL; an expired one is replaced without waiting.
        if (!uploadExpired) {
          await this.#sleep(B2Retry.delay(attempt, error instanceof B2Error ? error.retryAfterSeconds : undefined, this.#random()), signal)
        }
      }
    }
  }

  #currentSession(signal?: AbortSignal): Promise<Session> {
    if (this.#session) return this.#session
    const pending: Promise<Session> = this.#authorise(signal).catch(error => {
      if (this.#session === pending) this.#session = undefined
      throw error
    })
    this.#session = pending
    return pending
  }

  async #stat(session: Session, key: string, signal?: AbortSignal): Promise<{ size: number, sha1: string } | undefined> {
    const response = await this.#download(session, 'HEAD', key, undefined, signal)
    if (!response) return undefined
    const size = Number(response.headers.get('Content-Length'))
    const sha1 = response.headers.get('x-bz-content-sha1')?.toLowerCase()
    if (!Number.isSafeInteger(size) || !sha1 || !/^[0-9a-f]{40}$/u.test(sha1)) {
      throw new Error(`b2 object ${key} has no usable size or sha1`)
    }
    return { size, sha1 }
  }

  /** Uploads once and requires b2's receipt to report the sha1 and length it stored. */
  async #send(session: Session, key: string, bytes: Uint8Array, sha1: string, signal?: AbortSignal): Promise<void> {
    const pending = this.#upload ??= this.#getUploadTarget(session, signal)
    try {
      const target = await pending
      const response = await this.#fetch(target.uploadUrl, {
        method: 'POST', body: new Uint8Array(bytes), ...(signal ? { signal } : {}),
        headers: {
          'Authorization': target.token,
          'X-Bz-File-Name': encodeFileName(this.#fileName(key)),
          'Content-Type': 'application/octet-stream',
          'X-Bz-Content-Sha1': sha1,
        },
      })
      await this.#check('upload', response)
      const receipt = await response.json() as { contentSha1?: unknown, contentLength?: unknown }
      if (receipt.contentSha1 !== sha1 || receipt.contentLength !== bytes.byteLength) {
        throw new Error(`b2 stored ${key} as ${String(receipt.contentLength)} bytes with sha1 ${String(receipt.contentSha1)}; expected ${bytes.byteLength} bytes with sha1 ${sha1}`)
      }
    } catch (error) {
      // B2 expects a fresh upload URL after any failed upload.
      if (this.#upload === pending) this.#upload = undefined
      throw error
    }
  }

  async #download(session: Session, method: 'GET' | 'HEAD', key: string, range: ByteRange | undefined, signal?: AbortSignal): Promise<Response | undefined> {
    const response = await this.#fetch(`${session.downloadUrl}/file/${encodeURIComponent(this.bucketName)}/${encodeFileName(this.#fileName(key))}`, {
      method, ...(signal ? { signal } : {}),
      headers: { 'Authorization': session.token, ...(range ? { 'Range': `bytes=${range.start}-${range.end - 1}` } : {}) },
    })
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    await this.#check('download', response)
    return response
  }

  async #api<T = unknown>(session: Session, name: string, body: object, signal?: AbortSignal): Promise<T> {
    const response = await this.#fetch(`${session.apiUrl}${apiVersionPath}${name}`, {
      method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}),
      headers: { 'Authorization': session.token, 'Content-Type': 'application/json' },
    })
    await this.#check(name, response)
    return await response.json() as T
  }

  async #authorise(signal?: AbortSignal): Promise<Session> {
    const basic = Buffer.from(`${this.credentials.applicationKeyId}:${this.credentials.applicationKey}`).toString('base64')
    const response = await this.#fetch(authorizeUrl, { headers: { Authorization: `Basic ${basic}` }, ...(signal ? { signal } : {}) })
    await this.#check('b2_authorize_account', response)
    const account = await response.json() as {
      accountId: string, authorizationToken: string,
      apiInfo: { storageApi: { apiUrl: string, downloadUrl: string } },
    }
    const { apiUrl, downloadUrl } = account.apiInfo.storageApi
    const buckets = await this.#fetch(`${apiUrl}${apiVersionPath}b2_list_buckets`, {
      method: 'POST', ...(signal ? { signal } : {}),
      body: JSON.stringify({ accountId: account.accountId, bucketName: this.bucketName }),
      headers: { 'Authorization': account.authorizationToken, 'Content-Type': 'application/json' },
    })
    await this.#check('b2_list_buckets', buckets)
    const bucket = (await buckets.json() as { buckets: { bucketId: string, bucketName: string }[] })
      .buckets.find(candidate => candidate.bucketName === this.bucketName)
    if (!bucket) throw new Error(`b2 bucket ${this.bucketName} is not visible to this application key`)
    return { accountId: account.accountId, apiUrl, downloadUrl, token: account.authorizationToken, bucketId: bucket.bucketId }
  }

  async #getUploadTarget(session: Session, signal?: AbortSignal): Promise<UploadTarget> {
    const target = await this.#api<{ uploadUrl: string, authorizationToken: string }>(
      session, 'b2_get_upload_url', { bucketId: session.bucketId }, signal)
    return { uploadUrl: target.uploadUrl, token: target.authorizationToken }
  }

  async #check(operation: string, response: Response): Promise<void> {
    if (response.ok) return
    let code = 'unknown'
    let message = response.statusText
    try {
      const body = await response.json() as { code?: unknown, message?: unknown }
      if (typeof body.code === 'string') code = body.code
      if (typeof body.message === 'string') message = body.message
    } catch {
      // HEAD responses and some gateway errors carry no JSON body.
    }
    const retryAfter = Number(response.headers.get('Retry-After') ?? Number.NaN)
    throw new B2Error(operation, response.status, code, message,
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined)
  }
}
