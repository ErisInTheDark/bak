import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import FixtureDirectory from './FixtureDirectory.ts'

const execute = promisify(execFile)

export default class GitFixture {
  private constructor(private readonly directory: FixtureDirectory) {}

  get root(): string {
    return this.directory.path
  }

  static async create(): Promise<GitFixture> {
    return new GitFixture(await FixtureDirectory.create('bak-fixture-'))
  }

  path(...parts: string[]): string {
    const path = resolve(this.root, ...parts)
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error('fixture path escapes its root')
    }
    return path
  }

  async write(path: string, contents: string | Uint8Array): Promise<string> {
    const target = this.path(path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
    return target
  }

  async git(args: readonly string[], cwd = this.root): Promise<string> {
    return GitFixture.runGit(cwd, ...args)
  }

  static async runGit(cwd: string, ...args: string[]): Promise<string> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
    const result = await execute('git', [...args], {
      cwd,
      windowsHide: true,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CEILING_DIRECTORIES: FixtureDirectory.root,
      },
    })
    return result.stdout.trimEnd()
  }

  async repository(name: string, format: 'sha1' | 'sha256' = 'sha1'): Promise<string> {
    const path = this.path(name)
    await this.git(['init', '--template=', `--object-format=${format}`, '-b', 'main', path])
    await this.write(`${name}/file.txt`, 'original\n')
    await this.git(['add', '.'], path)
    await this.git(['commit', '-m', 'initial'], path)
    return path
  }

  dispose(): Promise<void> {
    return this.directory.dispose()
  }
}
