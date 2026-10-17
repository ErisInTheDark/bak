import { config } from '@inthedark/wb'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Environment = Readonly<Record<string, string | undefined>>

export interface LoadEnvironmentOptions {
  readonly required: readonly string[]
  /** Holds `.env` and selects the wb store folder. Defaults to the bak checkout. */
  readonly directory?: string
  /** Replace `.env` values before store references resolve; ambient values still win. */
  readonly overrides?: Readonly<Record<string, string>>
  readonly ambient?: Environment
  readonly signal?: AbortSignal
}

const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Loads `.env` through wb's store-aware dotenv into a private copy of the ambient environment.
 * Secrets never enter `process.env`, which Git subprocesses inherit. wb store lookups resolve
 * against the process cwd, so loading runs from `directory` and restores the cwd afterwards.
 */
export default async function loadEnvironment(options: LoadEnvironmentOptions): Promise<Environment> {
  const directory = options.directory ?? checkoutRoot
  const environment: Record<string, string | undefined> = { ...(options.ambient ?? process.env) }
  const previous = process.cwd()
  process.chdir(directory)
  try {
    const { error } = await config({
      path: join(directory, '.env'), processEnv: environment, required: options.required,
      map: parsed => ({ ...parsed, ...options.overrides }),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (error && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    process.chdir(previous)
  }
  return Object.freeze(environment)
}
