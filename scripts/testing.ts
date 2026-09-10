import type { TestsStream } from 'node:test'
import type { TestEvent } from 'node:test/reporters'
import { inspect } from 'node:util'

export interface TestConfig {
  roots: readonly string[]
  concurrency: number
  verbose: boolean
  filter: string
}

export interface TestOutput {
  stdout(text: string): void
  stderr(text: string): void
}

// @types/node 22 omits the documented/runtime `counts.failed` field.
type RunnerEvent = Exclude<TestEvent, { type: 'test:summary' }> | {
  type: 'test:summary'
  data: Extract<TestEvent, { type: 'test:summary' }>['data'] & { counts: { failed: number } }
}

type Counts = Extract<RunnerEvent, { type: 'test:summary' }>['data']['counts']

export async function reportTests(
  events: TestsStream,
  verbose: boolean,
  output: TestOutput,
): Promise<boolean> {
  let success = false
  const fileCounts: Counts[] = []
  for await (const event of events as AsyncIterable<RunnerEvent>) {
    const { type, data } = event
    switch (type) {
      case 'test:stdout':
        output.stdout(data.message)
        break
      case 'test:stderr':
        output.stderr(data.message)
        break
      case 'test:diagnostic':
        if (data.file || verbose || data.level === 'error' || data.level === 'warn') {
          output.stderr(`${data.message}\n`)
        }
        break
      case 'test:fail':
        if (data.todo) {
          if (verbose) output.stdout(`TODO ${data.name}\n`)
          break
        }
        // Parent failures repeat the child's error without adding diagnostics.
        if (!('failureType' in data.details.error) || data.details.error.failureType !== 'subtestsFailed') {
          output.stderr(`FAIL ${data.file ?? ''} ${data.name}\n`)
          const error = data.details.error
          const cause = error.cause ?? error
          output.stderr(`${cause instanceof Error ? cause.stack ?? cause.message : inspect(cause, { colors: false, depth: 8 })}\n`)
        }
        break
      case 'test:pass':
        if (verbose) {
          output.stdout(`${data.skip ? 'SKIP' : data.todo ? 'TODO' : 'PASS'} ${data.name}\n`)
        }
        break
      case 'test:summary':
        if (data.file !== undefined) {
          fileCounts.push(data.counts)
          break
        }
        // The final summary includes synthetic passes for empty files. Derive real
        // test counts from node's file summaries, retaining process-level failures.
        const counts = fileCounts.reduce((total, file) => ({
          passed: total.passed + file.passed,
          skipped: total.skipped + file.skipped,
          todo: total.todo + file.todo,
          failed: data.counts.failed,
          cancelled: data.counts.cancelled,
        }), { passed: 0, failed: data.counts.failed, cancelled: data.counts.cancelled, skipped: 0, todo: 0 })
        success = data.success && counts.passed + counts.failed + counts.cancelled > 0
        output.stdout(
          `${counts.passed} passed, ${counts.failed} failed, ${counts.cancelled} cancelled, ${counts.skipped} skipped, ${counts.todo} todo\n`,
        )
        if (counts.passed + counts.failed + counts.cancelled === 0) {
          output.stderr('no tests executed\n')
        }
        break
    }
  }
  return success
}
