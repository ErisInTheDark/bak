import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import FixtureDirectory from '../testing/FixtureDirectory.ts'
import loadEnvironment from './load-environment.ts'

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const fixture = await FixtureDirectory.create('bak-env-')
  try {
    await run(fixture.path)
  } finally {
    await fixture.dispose()
  }
}

test('file values load privately while ambient values win', () => withRoot(async root => {
  await writeFile(join(root, '.env'), 'BAK_TEST_FILE=from-file\nBAK_TEST_SHARED=from-file\n')
  const environment = await loadEnvironment({
    directory: root, required: ['BAK_TEST_FILE', 'BAK_TEST_SHARED'], ambient: { BAK_TEST_SHARED: 'ambient' },
  })
  assert.equal(environment.BAK_TEST_FILE, 'from-file')
  assert.equal(environment.BAK_TEST_SHARED, 'ambient')
  assert.equal(process.env.BAK_TEST_FILE, undefined)
}))

test('store lookups run from the env directory and the cwd is restored', () => withRoot(async root => {
  await writeFile(join(root, '.env'), 'BAK_TEST_LOOKUP_CWD=${cwd:any}\n')
  const node = process.execPath.replaceAll('\\', '\\\\')
  const before = process.cwd()
  const environment = await loadEnvironment({
    directory: root, required: ['BAK_TEST_LOOKUP_CWD'],
    ambient: { WB_STORES: `cwd: "${node}" -e "process.stdout.write(process.cwd())" {key}` },
  })
  assert.equal(environment.BAK_TEST_LOOKUP_CWD, root)
  assert.equal(process.cwd(), before)
}))

test('overrides replace file values and resolve through the store while ambient values win', () => withRoot(async root => {
  await writeFile(join(root, '.env'), 'BAK_TEST_KEY=default\nBAK_TEST_AMBIENT=from-file\n')
  const node = process.execPath.replaceAll('\\', '\\\\')
  const environment = await loadEnvironment({
    directory: root, required: ['BAK_TEST_KEY', 'BAK_TEST_ONLY', 'BAK_TEST_AMBIENT'],
    overrides: { BAK_TEST_KEY: '${echo:specific}', BAK_TEST_ONLY: 'override', BAK_TEST_AMBIENT: 'override' },
    ambient: {
      BAK_TEST_AMBIENT: 'ambient',
      WB_STORES: `echo: "${node}" -e "process.stdout.write('store:' + process.argv[1])" {key}`,
    },
  })
  assert.equal(environment.BAK_TEST_KEY, 'store:specific')
  assert.equal(environment.BAK_TEST_ONLY, 'override')
  assert.equal(environment.BAK_TEST_AMBIENT, 'ambient')
}))

test('a missing env file is fine when ambient values cover required names', () => withRoot(async root => {
  const environment = await loadEnvironment({ directory: root, required: ['BAK_TEST_AMBIENT'], ambient: { BAK_TEST_AMBIENT: 'yes' } })
  assert.equal(environment.BAK_TEST_AMBIENT, 'yes')
}))

test('missing required names reject together', () => withRoot(async root => {
  await writeFile(join(root, '.env'), 'BAK_TEST_PRESENT=1\n')
  await assert.rejects(
    loadEnvironment({ directory: root, required: ['BAK_TEST_PRESENT', 'BAK_TEST_A', 'BAK_TEST_B'], ambient: {} }),
    (error: Error) => error.message.includes('BAK_TEST_A') && error.message.includes('BAK_TEST_B'),
  )
}))
