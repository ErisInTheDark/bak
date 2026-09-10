import type { TestConfig } from './scripts/testing.ts'

export default {
  roots: ['src', 'scripts'],
  concurrency: 1,
  verbose: false,
  filter: '',
} satisfies TestConfig
