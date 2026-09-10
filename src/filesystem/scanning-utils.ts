import { execFile } from 'node:child_process'
import { lstat, opendir, readlink, realpath, stat } from 'node:fs/promises'
import { devNull } from 'node:os'
import { basename, dirname, isAbsolute, parse, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { PhysicalPath } from '../config/PathspecEvaluator.ts'

export interface Metadata {
  readonly device: string
  readonly inode: string
  readonly links: string
  readonly mode: number
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
}

export interface Inspection {
  readonly source: PhysicalPath
  readonly id: string
  readonly kind: 'file' | 'directory'
  readonly metadata: Metadata
  readonly symbolic?: { readonly target: string }
}

export interface ScanningIO {
  inspect(path: PhysicalPath): Promise<Inspection>
  exists(path: PhysicalPath): Promise<boolean>
  resolveRule(path: PhysicalPath): Promise<PhysicalPath>
  children(path: PhysicalPath): AsyncIterable<string>
  git(args: readonly string[], cwd: PhysicalPath, signal?: AbortSignal): Promise<string>
}

export function nativePath(path: PhysicalPath): string {
  if (process.platform === 'win32' ? path.root === '/' : path.root !== '/') {
    throw new Error(`source root ${path.root} is not native to this platform`)
  }
  const value = path.root + path.path
  if (!isAbsolute(value) || path.path.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('expected an absolute source without parent traversal')
  }
  return value
}

export function sourcePath(path: string): PhysicalPath {
  if (!isAbsolute(path)) throw new Error('expected an absolute native path')
  const root = parse(path).root
  return {
    root: root.split(sep).join('/'),
    path: path.slice(root.length).split(sep).join('/'),
  }
}

export function childPath(parent: PhysicalPath, name: string): PhysicalPath {
  if (!name || name === '.' || name === '..' || name.includes('/') ||
    name.includes('\0') || (sep === '\\' && name.includes('\\'))) {
    throw new Error('invalid directory entry name')
  }
  return { root: parent.root, path: [parent.path, name].filter(Boolean).join('/') }
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

async function inspect(path: PhysicalPath): Promise<Inspection> {
  const native = nativePath(path)
  const link = await lstat(native, { bigint: true })
  const canonical = await realpath(native)
  const stats = await stat(canonical, { bigint: true })
  if (!link.isSymbolicLink() && (link.dev !== stats.dev || link.ino !== stats.ino)) {
    throw new Error('source identity changed during inspection')
  }
  let symbolic: Inspection['symbolic']
  if (link.isSymbolicLink()) {
    symbolic = { target: await readlink(native) }
    const after = await lstat(native, { bigint: true })
    if (link.dev !== after.dev || link.ino !== after.ino || link.ctimeNs !== after.ctimeNs ||
      await realpath(native) !== canonical) {
      throw new Error('link changed during inspection')
    }
  }
  if (!stats.isFile() && !stats.isDirectory()) throw new Error('unsupported filesystem entry type')
  if (stats.ino <= 0n) throw new Error('filesystem does not provide a usable entry identity')
  return {
    source: sourcePath(canonical),
    id: `${stats.dev}:${stats.ino}`,
    kind: stats.isDirectory() ? 'directory' : 'file',
    metadata: {
      device: String(stats.dev),
      inode: String(stats.ino),
      links: String(stats.nlink),
      mode: Number(stats.mode),
      size: String(stats.size),
      mtimeNs: String(stats.mtimeNs),
      ctimeNs: String(stats.ctimeNs),
    },
    ...(symbolic ? { symbolic } : {}),
  }
}

async function resolveRule(path: PhysicalPath): Promise<PhysicalPath> {
  let current = nativePath(path)
  const suffix: string[] = []
  for (;;) {
    try {
      // Test the entry, not its target: a dangling link must not become a
      // fictitious missing suffix appended to its parent's identity.
      await lstat(current)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      suffix.unshift(basename(current))
      current = parent
      continue
    }
    return sourcePath(resolve(await realpath(current), ...suffix))
  }
}

export async function* directoryNames(
  path: PhysicalPath,
  open: typeof opendir = opendir,
): AsyncGenerator<string> {
  // Runtime supports buffer names, but @types/node omits this encoding.
  const directory = await open(nativePath(path), { encoding: 'buffer' as BufferEncoding })
  try {
    for (;;) {
      const entry = await directory.read()
      if (!entry) break
      // Node's Dir typings omit the buffer-name overload.
      const name: unknown = entry.name
      if (!Buffer.isBuffer(name)) throw new Error('expected a byte-encoded directory entry')
      yield new TextDecoder('utf-8', { fatal: true }).decode(name)
    }
  } finally {
    await directory.close()
  }
}

const execute = promisify(execFile)

async function git(args: readonly string[], cwd: PhysicalPath, signal?: AbortSignal): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  const result = await execute('git', [...args], {
    cwd: nativePath(cwd),
    env: {
      ...env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull,
    },
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    ...(signal ? { signal } : {}),
  })
  return result.stdout.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '')
}

async function exists(path: PhysicalPath): Promise<boolean> {
  try {
    await lstat(nativePath(path))
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

export const scanningIO: ScanningIO = { inspect, exists, resolveRule, children: directoryNames, git }
