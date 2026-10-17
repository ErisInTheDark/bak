import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesRoot = fileURLToPath(new URL('../../.tmp/fixtures/', import.meta.url))

/** Owns one disposable test directory under the project's gitignored `.tmp/fixtures`. */
export default class FixtureDirectory {
  /** Git discovery must stop here so fixtures never resolve to the project's own repository. */
  static readonly root = fixturesRoot

  private constructor(readonly path: string) {}

  static async create(prefix: string): Promise<FixtureDirectory> {
    await mkdir(fixturesRoot, { recursive: true })
    return new FixtureDirectory(await realpath(await mkdtemp(join(fixturesRoot, prefix))))
  }

  async dispose(): Promise<void> {
    const actual = await realpath(this.path)
    if (actual !== this.path || dirname(actual) !== await realpath(fixturesRoot)) {
      throw new Error('refusing cleanup outside the owned fixture')
    }
    await rm(actual, { recursive: true })
  }
}
