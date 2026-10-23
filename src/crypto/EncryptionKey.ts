import { createHmac, hkdfSync, scrypt } from 'node:crypto'
import type { Environment } from '../config/load-environment.ts'

/** Every machine must derive the same key from the passphrase alone, so the scrypt salt is fixed. */
const passphraseSalt = 'bak encryption v1'
const scryptOptions = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }

function subkey(master: Uint8Array, purpose: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `bak ${purpose}`, length))
}

/** Master key derived from the encryption passphrase; owns every secret derivation. */
export default class EncryptionKey {
  static readonly environmentName = 'BAK_ENCRYPTION_PASSPHRASE'
  static readonly minimumPassphraseLength = 16

  static async fromPassphrase(passphrase: string): Promise<EncryptionKey> {
    const normalised = passphrase.normalize('NFC')
    if ([...normalised].length < EncryptionKey.minimumPassphraseLength) {
      throw new Error(`encryption passphrase needs at least ${EncryptionKey.minimumPassphraseLength} characters`)
    }
    const master = await new Promise<Buffer>((resolve, reject) => {
      scrypt(normalised, passphraseSalt, 32, scryptOptions, (error, key) => error ? reject(error) : resolve(key))
    })
    return new EncryptionKey(master)
  }

  static async fromEnvironment(environment: Environment): Promise<EncryptionKey> {
    const passphrase = environment[EncryptionKey.environmentName]
    if (!passphrase) throw new Error(`${EncryptionKey.environmentName} is empty`)
    return EncryptionKey.fromPassphrase(passphrase)
  }

  /** Non-secret 8-byte identifier stored in object headers to detect a different passphrase. */
  readonly id: Buffer
  readonly #encryption: Buffer
  readonly #mac: Buffer

  private constructor(master: Uint8Array) {
    this.#encryption = subkey(master, 'encryption')
    this.#mac = subkey(master, 'mac')
    this.id = subkey(master, 'key id', 8)
  }

  /** Deterministic so identical uploads produce identical ciphertext and immutable puts stay idempotent. */
  objectSalt(name: string, plaintext: Uint8Array): Buffer {
    const nameBytes = Buffer.from(name, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(nameBytes.byteLength)
    return createHmac('sha256', this.#mac).update(length).update(nameBytes).update(plaintext).digest()
  }

  objectKey(salt: Uint8Array): Buffer {
    return Buffer.from(hkdfSync('sha256', this.#encryption, salt, 'bak object v1', 32))
  }
}
