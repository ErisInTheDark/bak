import { createHash } from 'node:crypto'
import type { Environment } from '../../config/load-environment.ts'
import type RemoteLocation from '../../config/RemoteLocation.ts'
import type ObjectStore from '../ObjectStore.ts'
import type { ByteRange, ObjectHead } from '../ObjectStore.ts'

export interface B2Credentials {
  readonly applicationKeyId: string
  readonly applicationKey: string
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

export class B2Error extends Error {
  constructor(readonly operation: string, readonly status: number, readonly code: string, message: string) {
    super(`b2 ${operation} failed (${status} ${code}): ${message}`)
  }

  /** The request's authorisation (account token or upload URL) must be renewed before retrying. */
  get requiresReauthorisation(): boolean {
    return this.status === 401 || (this.operation === 'upload' && (this.status === 503 || this.status === 408))
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

  static fromEnvironment(environment: Environment, location: RemoteLocation, fetcher: typeof fetch = fetch): B2ObjectStore {
    const [applicationKeyId, applicationKey] = B2ObjectStore.environmentNames.map(name => {
      const value = environment[name]?.trim()
      if (!value) throw new Error(`${name} is empty`)
      return value
    })
    return new B2ObjectStore({ applicationKeyId: applicationKeyId!, applicationKey: applicationKey! }, location, fetcher)
  }

  #session: Promise<Session> | undefined
  #upload: Promise<UploadTarget> | undefined

  constructor(
    private readonly credentials: B2Credentials,
    readonly location: RemoteLocation,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get bucketName(): string {
    return this.location.bucket
  }

  #fileName(key: string): string {
    return this.location.prefix ? `${this.location.prefix}/${key}` : key
  }

  async putImmutable(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const sha1 = sha1Hex(bytes)
    const existing = await this.#stat(key, signal)
    if (existing) {
      if (existing.sha1 === sha1 && existing.size === bytes.byteLength) return
      throw new Error(`b2 object ${key} already exists with different content`)
    }
    await this.#authorised(async session => {
      const pending = this.#upload ??= this.#getUploadTarget(session, signal)
      try {
        const target = await pending
        const response = await this.fetcher(target.uploadUrl, {
          method: 'POST', body: new Uint8Array(bytes), ...(signal ? { signal } : {}),
          headers: {
            'Authorization': target.token,
            'X-Bz-File-Name': encodeFileName(this.#fileName(key)),
            'Content-Type': 'application/octet-stream',
            'X-Bz-Content-Sha1': sha1,
          },
        })
        await this.#check('upload', response)
      } catch (error) {
        // B2 expects a fresh upload URL after any failed upload.
        if (this.#upload === pending) this.#upload = undefined
        throw error
      }
    }, signal)
  }

  async get(key: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const response = await this.#download('GET', key, undefined, signal)
    return response ? new Uint8Array(await response.arrayBuffer()) : undefined
  }

  async getRange(key: string, range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start) {
      throw new RangeError(`invalid byte range ${range.start}-${range.end}`)
    }
    const response = await this.#download('GET', key, range, signal)
    if (!response) throw new Error(`b2 object ${key} does not exist`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (response.status !== 206 || bytes.byteLength !== range.end - range.start) {
      throw new Error(`b2 returned ${bytes.byteLength} bytes for range ${range.start}-${range.end} of ${key}`)
    }
    return bytes
  }

  async head(key: string, signal?: AbortSignal): Promise<ObjectHead | undefined> {
    const stat = await this.#stat(key, signal)
    return stat && { size: stat.size }
  }

  async #stat(key: string, signal?: AbortSignal): Promise<{ size: number, sha1: string } | undefined> {
    const response = await this.#download('HEAD', key, undefined, signal)
    if (!response) return undefined
    const size = Number(response.headers.get('Content-Length'))
    const sha1 = response.headers.get('x-bz-content-sha1')?.toLowerCase()
    if (!Number.isSafeInteger(size) || !sha1 || !/^[0-9a-f]{40}$/u.test(sha1)) {
      throw new Error(`b2 object ${key} has no usable size or sha1`)
    }
    return { size, sha1 }
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    const fileName = this.#fileName(key)
    for (;;) {
      const { files } = await this.#api<{ files: { fileId: string, fileName: string }[] }>('b2_list_file_versions',
        session => ({ bucketId: session.bucketId, prefix: fileName, startFileName: fileName, maxFileCount: 100 }), signal)
      const versions = files.filter(file => file.fileName === fileName)
      if (!versions.length) return
      for (const version of versions) {
        await this.#api('b2_delete_file_version', () => ({ fileName: version.fileName, fileId: version.fileId }), signal)
      }
    }
  }

  async #download(method: 'GET' | 'HEAD', key: string, range: ByteRange | undefined, signal?: AbortSignal): Promise<Response | undefined> {
    return this.#authorised(async session => {
      const response = await this.fetcher(`${session.downloadUrl}/file/${encodeURIComponent(this.bucketName)}/${encodeFileName(this.#fileName(key))}`, {
        method, ...(signal ? { signal } : {}),
        headers: { 'Authorization': session.token, ...(range ? { 'Range': `bytes=${range.start}-${range.end - 1}` } : {}) },
      })
      if (response.status === 404) {
        await response.body?.cancel()
        return undefined
      }
      await this.#check('download', response)
      return response
    }, signal)
  }

  async #api<T = unknown>(name: string, body: (session: Session) => object, signal?: AbortSignal): Promise<T> {
    return this.#authorised(async session => {
      const response = await this.fetcher(`${session.apiUrl}${apiVersionPath}${name}`, {
        method: 'POST', body: JSON.stringify(body(session)), ...(signal ? { signal } : {}),
        headers: { 'Authorization': session.token, 'Content-Type': 'application/json' },
      })
      await this.#check(name, response)
      return await response.json() as T
    }, signal)
  }

  /** Sole retry owner: one renewal of the account session and upload target after an authorisation failure. */
  async #authorised<T>(operation: (session: Session) => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const pending = this.#session ??= this.#authorise(signal)
      let session: Session
      try {
        session = await pending
      } catch (error) {
        if (this.#session === pending) this.#session = undefined
        throw error
      }
      try {
        return await operation(session)
      } catch (error) {
        if (attempt > 0 || !(error instanceof B2Error) || !error.requiresReauthorisation) throw error
        if (error.operation !== 'upload' && this.#session === pending) this.#session = undefined
      }
    }
  }

  async #authorise(signal?: AbortSignal): Promise<Session> {
    const basic = Buffer.from(`${this.credentials.applicationKeyId}:${this.credentials.applicationKey}`).toString('base64')
    const response = await this.fetcher(authorizeUrl, { headers: { Authorization: `Basic ${basic}` }, ...(signal ? { signal } : {}) })
    await this.#check('b2_authorize_account', response)
    const account = await response.json() as {
      accountId: string, authorizationToken: string,
      apiInfo: { storageApi: { apiUrl: string, downloadUrl: string } },
    }
    const { apiUrl, downloadUrl } = account.apiInfo.storageApi
    const buckets = await this.fetcher(`${apiUrl}${apiVersionPath}b2_list_buckets`, {
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
    const response = await this.fetcher(`${session.apiUrl}${apiVersionPath}b2_get_upload_url`, {
      method: 'POST', body: JSON.stringify({ bucketId: session.bucketId }), ...(signal ? { signal } : {}),
      headers: { 'Authorization': session.token, 'Content-Type': 'application/json' },
    })
    await this.#check('b2_get_upload_url', response)
    const target = await response.json() as { uploadUrl: string, authorizationToken: string }
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
    throw new B2Error(operation, response.status, code, message)
  }
}
