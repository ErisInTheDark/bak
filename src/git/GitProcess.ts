import { spawn } from 'node:child_process'
import { devNull } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface GitIdentity {
  readonly name: string
  readonly email: string
}

export interface GitRequest {
  readonly cwd: string
  readonly gitDirectory?: string
  readonly input?: Readable | Uint8Array | string
  readonly output?: Writable
  readonly signal?: AbortSignal
  readonly identity?: GitIdentity
  readonly userConfig?: boolean
  readonly acceptExitCodes?: readonly number[]
}

export interface GitResult {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: string
}

export interface GitTreeEntry {
  readonly name: string
  readonly mode: '100644' | '100755' | '120000' | '040000' | '160000'
  readonly type: 'blob' | 'tree' | 'commit'
  readonly oid: string
}

export namespace GitTreeEntry {
  export function encode(entries: readonly GitTreeEntry[]): string {
    return entries.map(entry => {
      if (!entry.name || entry.name === '.' || entry.name === '..' || /[/\0]/.test(entry.name) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.oid)) throw new Error('invalid Git tree entry')
      return `${entry.mode} ${entry.type} ${entry.oid}\t${entry.name}\0`
    }).join('')
  }
}

export default class GitProcess {
  async run(args: readonly string[], request: GitRequest): Promise<GitResult> {
    request.signal?.throwIfAborted()
    const controller = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
    Object.assign(env, {
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      ...(!request.userConfig ? {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull,
      } : {}),
      ...(request.identity ? {
        GIT_AUTHOR_NAME: request.identity.name,
        GIT_AUTHOR_EMAIL: request.identity.email,
        GIT_COMMITTER_NAME: request.identity.name,
        GIT_COMMITTER_EMAIL: request.identity.email,
      } : {}),
    })
    const child = spawn('git', [
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : devNull}`,
      ...(request.gitDirectory ? [`--git-dir=${request.gitDirectory}`] : []),
      ...args,
    ], { cwd: request.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal })
    const output: Buffer[] = []
    let outputSize = 0
    let stderr = ''
    let failure: unknown
    const fail = (error: unknown) => {
      if (failure === undefined) failure = error
      controller.abort(error)
    }
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString()
    })
    const completion = new Promise<number>(resolve => {
      child.once('error', fail)
      child.once('close', code => {
        const result = code ?? -1
        if (!(request.acceptExitCodes ?? [0]).includes(result)) {
          fail(new Error(`git ${args[0] ?? ''} exited ${result}: ${stderr.trim()}`))
        }
        resolve(result)
      })
    })
    const sink = request.output ?? new Writable({
      write(chunk: Buffer, _encoding, callback) {
        outputSize += chunk.length
        if (outputSize > 16 * 1024 * 1024) {
          callback(new Error('Git output exceeds the buffered limit; use streaming output'))
          return
        }
        output.push(Buffer.from(chunk))
        callback()
      },
    })
    const input = request.input instanceof Readable
      ? request.input
      : Readable.from(request.input === undefined ? [] : [request.input])
    // A failed stream aborts the process and its peer stream. Wait for all
    // handles to close before the caller can dispose its operation or fixture.
    const incoming = pipeline(input, child.stdin, { signal }).catch(fail)
    const outgoing = pipeline(child.stdout, sink, { signal }).catch(fail)
    const [code] = await Promise.all([completion, incoming, outgoing])
    request.signal?.throwIfAborted()
    if (failure !== undefined) throw failure
    return { code, stdout: Buffer.concat(output), stderr }
  }
}
