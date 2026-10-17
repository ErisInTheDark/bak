import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import FixtureDirectory from '../src/testing/FixtureDirectory.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const runner = fileURLToPath(new URL('./test.ts', import.meta.url))

async function probe(sources: string[], args: string[] = []) {
  const fixture = await FixtureDirectory.create('bak-runner-')
  const directory = fixture.path
  try {
    const files = await Promise.all(sources.map(async (source, index) => {
      const path = join(directory, `${index}.test.ts`)
      await writeFile(path, source)
      return path
    }))
    // This is a new runner invocation, not a child test of the current runner.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', runner, ...(files.length ? files : [directory]), ...args], {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
      child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
      child.once('error', reject)
      child.once('close', code => resolve({ code, stdout, stderr }))
    })
  } finally {
    await fixture.dispose()
  }
}

test('compact output aggregates suites and files without listing passing tests', async () => {
  const result = await probe([
    `import { describe, it } from 'node:test'
describe('suite-marker', () => {
  it('pass-marker', () => {})
  it.skip('skip-marker', () => {})
  it.todo('todo-marker', () => { throw new Error('expected-todo-marker') })
})`,
    `import { test } from 'node:test'
test('async-marker', async () => {})`,
    'export {}',
  ])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim().split('\n').length, 1)
  assert.deepEqual(result.stdout.match(/\d+/g)?.map(Number), [2, 0, 0, 1, 1])
  assert.ok(!result.stdout.includes('marker'))
})

test('failed children fail the run and retain their underlying diagnostics', async () => {
  const result = await probe([
    `import { describe, it } from 'node:test'
describe('parent', () => {
  it('failure', async () => { throw new Error('failure-marker') })
  it('still-runs', () => { console.log('completion-marker') })
})`,
  ])
  assert.equal(result.code, 1)
  assert.ok(result.stderr.includes('failure-marker'), result.stderr)
  assert.ok(result.stdout.includes('completion-marker'), result.stdout)
  assert.ok(result.stderr.includes('.test.ts'), result.stderr)
})

test('load failures, empty files and unmatched filters never report success', async () => {
  const load = await probe([`throw new Error('load-marker')`])
  assert.equal(load.code, 1)
  assert.ok(load.stderr.includes('load-marker'), load.stderr)
  const empty = await probe(['export {}'])
  assert.equal(empty.code, 1, empty.stdout)
  const noFiles = await probe([])
  assert.equal(noFiles.code, 1)
  const unmatched = await probe([
    `import { test } from 'node:test'
test('selected', () => { throw new Error('must-not-execute') })`,
  ], ['--filter', 'missing'])
  assert.equal(unmatched.code, 1, unmatched.stdout)
  assert.ok(!unmatched.stderr.includes('must-not-execute'))
})

test('cancelled tests cannot become successful runs', async () => {
  const cancelled = await probe([
    `import { test } from 'node:test'
const controller = new AbortController()
test('unfinished-marker', { signal: controller.signal }, async () => {
  controller.abort()
  await new Promise(() => {})
})`,
  ])
  assert.equal(cancelled.code, 1)
  assert.ok(cancelled.stderr.includes('unfinished-marker'), cancelled.stderr)
})

test('filtering is literal and verbose output is opt-in without swallowing stderr', async () => {
  const result = await probe([
    `import { test } from 'node:test'
test('a.b', () => { console.error('stderr-marker') })
test('axb', () => { throw new Error('must-not-execute') })`,
  ], ['--filter', 'a.b', '--verbose'])
  assert.equal(result.code, 0, result.stderr)
  assert.ok(result.stdout.includes('a.b'), result.stdout)
  assert.ok(result.stderr.includes('stderr-marker'), result.stderr)
  assert.ok(!result.stderr.includes('must-not-execute'))
})
