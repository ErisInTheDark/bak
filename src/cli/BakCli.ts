import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import PathspecEvaluator from '../config/PathspecEvaluator.ts'
import RemoteLocation from '../config/RemoteLocation.ts'
import GitProcess, { type GitIdentity } from '../git/GitProcess.ts'
import { errorCode, nativePath } from '../filesystem/scanning-utils.ts'
import RemotePacks from '../remote/RemotePacks.ts'
import SnapshotRemote from '../remote/SnapshotRemote.ts'
import SnapshotReader from '../snapshot/SnapshotReader.ts'
import SnapshotStore from '../snapshot/SnapshotStore.ts'
import openRemoteStore, { type RemoteStore } from '../storage/open-remote-store.ts'

export interface CliOutput {
  readonly stdout: Writable
  readonly stderr: Writable
}

export type RemoteOpener = typeof openRemoteStore

interface CommandContext {
  readonly root: string
  readonly arguments: readonly string[]
  readonly output: CliOutput
  readonly openRemote: RemoteOpener
  readonly message?: string
  readonly author?: string
  readonly relocate?: readonly string[]
  readonly signal?: AbortSignal
}

async function readPathspec(root: string): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(root, SnapshotStore.pathspecFileName)))
}

async function readOptionalPathspec(root: string): Promise<string | undefined> {
  try {
    return await readPathspec(root)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

/** Opens the folder's `@remote`, or `url` when given, with the folder's `@env` overrides. */
async function openFolderRemote(context: CommandContext, url?: string): Promise<RemoteStore> {
  const pathspec = url === undefined ? await readPathspec(context.root) : await readOptionalPathspec(context.root)
  const evaluator = pathspec === undefined ? undefined : new PathspecEvaluator(pathspec)
  const location = url === undefined ? evaluator?.getRemote() : RemoteLocation.parse(url)
  if (!location) throw new Error(`add @remote = b2://bucket[/prefix] to ${SnapshotStore.pathspecFileName}`)
  return context.openRemote({
    location, ...(evaluator ? { overrides: evaluator.getEnvironment() } : {}), ...(context.signal ? { signal: context.signal } : {}),
  })
}

async function openFolderPacks(context: CommandContext, url?: string): Promise<RemotePacks> {
  const { location, store } = await openFolderRemote(context, url)
  return new RemotePacks(context.root, store, RemoteLocation.format(location))
}

function mebibytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
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
    const content = await openFolderPacks(context)
    const result = await new SnapshotStore(context.root).commit({
      pathspec: await readPathspec(context.root),
      message: context.message, identity, content,
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
    const short = result.commit.slice(0, 12)
    let published
    try {
      published = await new SnapshotRemote(content).push(context.signal)
    } catch (error) {
      throw new Error(`captured ${short} locally but publishing failed: ${error instanceof Error ? error.message : String(error)}; run bak push to retry`,
        { cause: error })
    }
    const captured = result.changed ? `committed ${short}` : `no changes (${short})`
    context.output.stdout.write(published.changed
      ? `${captured} and published to ${content.url} (${published.packs} metadata packs, ${mebibytes(published.bytes)})\n`
      : `${captured}; ${content.url} is up to date\n`)
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
    const target = await new SnapshotReader(context.root).resolve(snapshot!, path, context.signal)
    if (target.entry?.kind === 'file') {
      const reader = new SnapshotReader(context.root, await openFolderPacks(context))
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
  remote: async context => {
    if (context.arguments.length !== 1 || context.arguments[0] !== 'check') throw new Error('remote requires check')
    const signal = context.signal
    const { location, key: encryptionKey, store } = await openFolderRemote(context)
    const key = `bak-probe/${randomUUID()}`
    const bytes = new TextEncoder().encode(`bak remote check ${key}\n`)
    await store.putImmutable(key, bytes, signal)
    try {
      const whole = await store.get(key, signal)
      const range = await store.getRange(key, { start: 4, end: 10 }, signal)
      const head = await store.head(key, signal)
      if (!whole || Buffer.compare(whole, bytes) || Buffer.compare(range, bytes.subarray(4, 10)) || !head || head.size !== bytes.byteLength) {
        throw new Error(`b2 probe ${key} did not read back what was written`)
      }
    } finally {
      await store.delete(key, signal)
    }
    context.output.stdout.write(`authorised for ${RemoteLocation.format(location)} (key id ${encryptionKey.id.toString('hex')}); `
      + 'encrypted put/get/range/head/delete ok\n')
  },
  push: async context => {
    if (context.arguments.length) throw new Error('push does not accept positional arguments')
    const packs = await openFolderPacks(context)
    const result = await new SnapshotRemote(packs).push(context.signal)
    const short = result.snapshot.slice(0, 12)
    context.output.stdout.write(result.changed
      ? `pushed ${short} to ${packs.url} (${result.packs} new metadata packs, ${mebibytes(result.bytes)})\n`
      : `${packs.url} is up to date (${short})\n`)
  },
  clone: async context => {
    if (context.arguments.length > 1) throw new Error('clone accepts at most one b2:// url')
    const packs = await openFolderPacks(context, context.arguments[0])
    const snapshot = await SnapshotRemote.clone(packs, context.signal)
    context.output.stdout.write(`cloned ${packs.url} at ${snapshot.slice(0, 12)} into ${context.root}; every snapshot object is local or remote\n`)
  },
  fsck: async context => {
    if (context.arguments.length) throw new Error('fsck does not accept positional arguments')
    const packs = await openFolderPacks(context)
    const result = await new SnapshotRemote(packs).verify(context.signal)
    context.output.stdout.write(`verified ${result.packs} packs (${mebibytes(result.bytes)}) of ${result.snapshot.slice(0, 12)} on ${packs.url}; every object is recoverable\n`)
  },
}

export default class BakCli {
  constructor(
    readonly output: CliOutput = { stdout: process.stdout, stderr: process.stderr },
    private readonly openRemote: RemoteOpener = openRemoteStore,
  ) {}

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
        this.output.stdout.write('bak [--root <directory>] init | commit -m <message> | log | show <snapshot> [path] | remote check | push | clone [url] | fsck\n')
        return 0
      }
      const [command, ...arguments_] = positionals
      const handler = command ? commands[command] : undefined
      if (!handler) throw new Error('choose init, commit, log, show, remote, push, clone or fsck')
      signal?.throwIfAborted()
      await handler({
        root: resolve(values.root ?? process.cwd()), arguments: arguments_, output: this.output, openRemote: this.openRemote,
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
