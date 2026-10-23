import loadEnvironment from '../config/load-environment.ts'
import type RemoteLocation from '../config/RemoteLocation.ts'
import EncryptedObjectStore from '../crypto/EncryptedObjectStore.ts'
import EncryptionKey from '../crypto/EncryptionKey.ts'
import B2ObjectStore from './b2/B2ObjectStore.ts'
import type ObjectStore from './ObjectStore.ts'

export interface RemoteStoreOptions {
  readonly location: RemoteLocation
  /** A backup folder's `@env` values, layered over the checkout `.env`. */
  readonly overrides?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

export interface RemoteStore {
  readonly location: RemoteLocation
  readonly key: EncryptionKey
  /** Encrypts before anything reaches the backend. */
  readonly store: ObjectStore
}

/** Opens a remote with credentials and passphrase from the checkout `.env` plus folder overrides. */
export default async function openRemoteStore(options: RemoteStoreOptions): Promise<RemoteStore> {
  const environment = await loadEnvironment({
    required: [...B2ObjectStore.environmentNames, EncryptionKey.environmentName],
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const key = await EncryptionKey.fromEnvironment(environment)
  const location = options.location
  return { location, key, store: new EncryptedObjectStore(B2ObjectStore.fromEnvironment(environment, location), key) }
}
