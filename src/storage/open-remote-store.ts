import loadEnvironment from '../config/load-environment.ts'
import type PathspecEvaluator from '../config/PathspecEvaluator.ts'
import type RemoteLocation from '../config/RemoteLocation.ts'
import EncryptedObjectStore from '../crypto/EncryptedObjectStore.ts'
import EncryptionKey from '../crypto/EncryptionKey.ts'
import SnapshotStore from '../snapshot/SnapshotStore.ts'
import B2ObjectStore from './b2/B2ObjectStore.ts'
import type ObjectStore from './ObjectStore.ts'

export interface RemoteStore {
  readonly location: RemoteLocation
  readonly key: EncryptionKey
  /** Encrypts before anything reaches the backend. */
  readonly store: ObjectStore
}

/** Opens a backup folder's `@remote` with credentials from the checkout `.env` and its `@env` overrides. */
export default async function openRemoteStore(evaluator: PathspecEvaluator, signal?: AbortSignal): Promise<RemoteStore> {
  const location = evaluator.getRemote()
  if (!location) throw new Error(`add @remote = b2://bucket[/prefix] to ${SnapshotStore.pathspecFileName}`)
  const environment = await loadEnvironment({
    required: [...B2ObjectStore.environmentNames, EncryptionKey.environmentName],
    overrides: evaluator.getEnvironment(), ...(signal ? { signal } : {}),
  })
  const key = await EncryptionKey.fromEnvironment(environment)
  return { location, key, store: new EncryptedObjectStore(B2ObjectStore.fromEnvironment(environment, location), key) }
}
