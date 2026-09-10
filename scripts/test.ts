import { readdir, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from 'node:test'
import { parseArgs } from 'node:util'
import config from '../test.config.ts'
import { reportTests } from './testing.ts'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

async function discover(path: string): Promise<string[]> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return []
  if (info.isFile()) {
    if (!path.endsWith('.test.ts')) throw new Error(`not a test file: ${path}`)
    return [path]
  }
  if (!info.isDirectory()) throw new Error(`not a file or directory: ${path}`)
  const files: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.test.ts'))) {
      files.push(...await discover(resolve(path, entry.name)))
    }
  }
  return files
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      filter: { type: 'string' },
      verbose: { type: 'boolean' },
    },
  })
  if (!Number.isSafeInteger(config.concurrency) || config.concurrency < 1) {
    throw new Error('test concurrency must be a positive integer')
  }
  const selected = positionals.length ? positionals : config.roots
  const files = [...new Set((await Promise.all(
    selected.map(path => discover(resolve(projectRoot, path))),
  )).flat())].sort()
  if (!files.length) throw new Error('no test files selected')
  const filter = values.filter ?? config.filter
  const events = run({
    files,
    concurrency: config.concurrency,
    isolation: 'process',
    execArgv: ['--import', 'tsx'],
    testNamePatterns: filter ? [new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))] : undefined,
  })
  const success = await reportTests(events, values.verbose ?? config.verbose, {
    stdout: text => { process.stdout.write(text) },
    stderr: text => { process.stderr.write(text) },
  })
  process.exitCode = success ? 0 : 1
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
