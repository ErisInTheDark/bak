import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import GitProcess, { type GitIdentity } from '../git/GitProcess.ts'
import { nativePath } from '../filesystem/scanning-utils.ts'
import SnapshotReader from '../snapshot/SnapshotReader.ts'
import SnapshotStore from '../snapshot/SnapshotStore.ts'

export interface CliOutput {
  readonly stdout: Writable
  readonly stderr: Writable
}

interface CommandContext {
  readonly root: string
  readonly arguments: readonly string[]
  readonly output: CliOutput
  readonly message?: string
  readonly author?: string
  readonly relocate?: readonly string[]
  readonly signal?: AbortSignal
}

const commands: Readonly<Record<string, (context: CommandContext) => Promise<void>>> = {
  init: async context => {
    if (context.arguments.length) throw new Error('init does not accept positional arguments')
    await new SnapshotStore(context.root).init(context.signal)
    context.output.stdout.write(`initialised ${context.root}\n`)
  },
  commit: async context => {
    if (context.arguments.length || !context.message) throw new Error('commit requires -m <message>')
    let identity: GitIdentity
    if (context.author) {
      const match = /^([^<>\r\n]+)<([^<>\r\n]+)>$/.exec(context.author)
      if (!match) throw new Error('author must be Name <email>')
      identity = { name: match[1]!.trim(), email: match[2]!.trim() }
    } else {
      const request = {
        cwd: context.root, gitDirectory: join(context.root, '.bak', 'main.git'),
        userConfig: true, acceptExitCodes: [0, 1], ...(context.signal ? { signal: context.signal } : {}),
      }
      const git = new GitProcess()
      const name = (await git.run(['config', '--get', 'user.name'], request)).stdout.toString().trim()
      const email = (await git.run(['config', '--get', 'user.email'], request)).stdout.toString().trim()
      if (!name || !email) throw new Error('configure Git user.name and user.email or provide --author "Name <email>"')
      identity = { name, email }
    }
    const result = await new SnapshotStore(context.root).commit({
      pathspec: new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(context.root, 'bak.pathspec'))),
      message: context.message, identity,
      ...(context.relocate ? { relocate: context.relocate } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
      report: record => {
        if (record.type === 'skipped') {
          context.output.stderr.write(`skipped ${nativePath(record.source)}; named copies: ${record.namedCopies.join(', ')}\n`)
        } else {
          context.output.stderr.write(`${record.operation}: ${record.message}\n`)
        }
      },
    })
    context.output.stdout.write(result.changed ? `${result.commit}\n` : `no changes (${result.commit})\n`)
  },
  log: async context => {
    if (context.arguments.length) throw new Error('log does not accept positional arguments')
    const result = await new GitProcess().run([
      'log', '--format=%h %ad %s', '--date=iso-strict', 'refs/heads/snapshots',
    ], {
      cwd: context.root, gitDirectory: join(context.root, '.bak', 'main.git'),
      ...(context.signal ? { signal: context.signal } : {}),
    })
    context.output.stdout.write(result.stdout)
  },
  show: async context => {
    if (!context.arguments.length || context.arguments.length > 2) throw new Error('show requires <snapshot> [path]')
    const [snapshot, path = ''] = context.arguments
    const reader = new SnapshotReader(context.root)
    const target = await reader.resolve(snapshot!, path, context.signal)
    if (target.entry?.kind === 'file') {
      const output = new Writable({
        write(chunk: Buffer, _encoding, done) { context.output.stdout.write(chunk, done) },
      })
      const fail = (error: Error) => { output.destroy(error) }
      context.output.stdout.on('error', fail)
      try {
        await reader.streamTarget(target, output, context.signal)
      } finally {
        context.output.stdout.removeListener('error', fail)
      }
    } else {
      context.output.stdout.write(target.children.map(name => `${name}\n`).join(''))
    }
  },
}

export default class BakCli {
  constructor(readonly output: CliOutput = { stdout: process.stdout, stderr: process.stderr }) {}

  async run(args: readonly string[], signal?: AbortSignal): Promise<number> {
    try {
      const { values, positionals } = parseArgs({
        args: [...args], allowPositionals: true,
        options: {
          root: { type: 'string' },
          message: { type: 'string', short: 'm' },
          author: { type: 'string' },
          relocate: { type: 'string', multiple: true },
          help: { type: 'boolean', short: 'h' },
        },
      })
      if (values.help) {
        this.output.stdout.write('bak [--root <directory>] init | commit -m <message> | log | show <snapshot> [path]\n')
        return 0
      }
      const [command, ...arguments_] = positionals
      const handler = command ? commands[command] : undefined
      if (!handler) throw new Error('choose init, commit, log or show')
      signal?.throwIfAborted()
      await handler({
        root: resolve(values.root ?? process.cwd()), arguments: arguments_, output: this.output,
        ...(values.message !== undefined ? { message: values.message } : {}),
        ...(values.author !== undefined ? { author: values.author } : {}),
        ...(values.relocate !== undefined ? { relocate: values.relocate } : {}),
        ...(signal ? { signal } : {}),
      })
      return 0
    } catch (error) {
      this.output.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return signal?.aborted ? 130 : 1
    }
  }
}
