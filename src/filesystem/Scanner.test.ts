import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import PathspecEvaluator from '../config/PathspecEvaluator.ts'
import Scanner, { type ScanRecord } from './Scanner.ts'
import { nativePath, scanningIO, sourcePath } from './scanning-utils.ts'

const execute = promisify(execFile)

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'bak-scan-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function git(cwd: string, ...args: string[]) {
  return (await execute('git', args, {
    cwd, windowsHide: true,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  })).stdout.trim()
}

const rule = (path: string) => `"${path.replaceAll('\\', '/')}"`

async function collect(stream: AsyncIterable<ScanRecord>): Promise<ScanRecord[]> {
  const records: ScanRecord[] = []
  for await (const record of stream) records.push(record)
  return records
}

function completion(records: ScanRecord[]) {
  const last = records.at(-1)
  assert.equal(last?.type, 'completion')
  assert.ok(last?.type === 'completion')
  return last
}

test('scan integrates aliases, shared exclusions and independently re-included descendants', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'cache', 'keep'), { recursive: true })
    await writeFile(join(root, 'cache', 'keep', '[draft]'), 'kept')
    await writeFile(join(root, 'cache', 'other'), 'excluded')
    const evaluator = new PathspecEvaluator(`#one = ${rule(root)}\n#two = ${rule(root)}\n!#one/cache\n#two/cache/keep`)
    const records = await collect(new Scanner(evaluator).scan())
    const entries = records.filter(record => record.type === 'entry')
    assert.equal(entries.filter(entry => entry.kind === 'file').length, 1)
    assert.equal(entries.filter(entry => entry.source.path.endsWith('/cache/keep')).length, 1)
    assert.ok(records.some(record => record.type === 'root' && record.destination.path === 'two/cache/keep'))
    assert.equal(completion(records).complete, true)
  })
})

test('junction exclusions are shared before emission and outside targets are ordinary content', async () => {
  await fixture(async root => {
    const data = join(root, 'data')
    const outside = join(root, 'outside')
    const mirror = join(root, 'mirror')
    await mkdir(data)
    await mkdir(outside)
    await writeFile(join(data, 'keep'), 'keep')
    await writeFile(join(data, 'cache'), 'excluded')
    await writeFile(join(outside, 'external'), 'external')
    await symlink(data, mirror, process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(outside, join(data, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
    const records = await collect(new Scanner(new PathspecEvaluator(
      `${rule(data)}\n${rule(mirror)}\n!${rule(join(mirror, 'cache'))}`,
    )).scan())
    assert.equal(records.filter(record => record.type === 'entry' && record.kind === 'file').length, 2)
    assert.ok(records.some(record => record.type === 'entry' && record.source.path.endsWith('/outside/external')))
    assert.equal(completion(records).complete, true)
  })
})

test('hardlinked files share content while cycles and missing roots cannot produce complete scans', async () => {
  await fixture(async root => {
    const data = join(root, 'data')
    await mkdir(data)
    await writeFile(join(data, 'a'), 'same')
    await link(join(data, 'a'), join(data, 'b'))
    await symlink(data, join(data, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
    const records = await collect(new Scanner(new PathspecEvaluator(
      `${rule(data)}\n${rule(join(root, 'missing'))}`,
    )).scan())
    assert.equal(records.filter(record => record.type === 'entry' && record.kind === 'file').length, 1)
    assert.equal(records.filter(record => record.type === 'problem').length, 2)
    assert.equal(completion(records).complete, false)
  })
})

test('repository discovery preserves dirty and untracked files without flattening git storage', async () => {
  await fixture(async root => {
    await git(root, 'init', '--quiet')
    await writeFile(join(root, 'tracked'), 'original')
    await git(root, 'add', 'tracked')
    await git(root, 'commit', '--quiet', '-m', 'fixture')
    const head = await git(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'tracked'), 'dirty')
    await writeFile(join(root, 'untracked'), 'untracked')
    const nested = join(root, 'nested')
    await mkdir(nested)
    await git(nested, 'init', '--quiet')
    const records = await collect(new Scanner(new PathspecEvaluator(rule(root))).scan())
    assert.deepEqual(records.filter(record => record.type === 'problem'), [])
    assert.equal(records.filter(record => record.type === 'repository').length, 2)
    assert.equal(records.filter(record => record.type === 'entry' && record.kind === 'file').length, 2)
    assert.equal(completion(records).complete, true)
    assert.equal(await git(root, 'rev-parse', 'HEAD'), head)
    assert.equal(await readFile(join(root, 'tracked'), 'utf8'), 'dirty')
    const ordinary = await collect(new Scanner(new PathspecEvaluator(
      `${rule(root)}\n!${rule(join(root, '.git'))}\n!${rule(nested)}`,
    )).scan())
    assert.equal(ordinary.filter(record => record.type === 'repository').length, 0)
    assert.equal(completion(ordinary).complete, true)
  })
})

test('bare repositories and linked worktrees retain common storage identity', async () => {
  await fixture(async root => {
    const bare = join(root, 'bare')
    await git(root, 'init', '--quiet', '--bare', bare)
    const work = join(root, 'work')
    await mkdir(work)
    await git(work, 'init', '--quiet')
    await writeFile(join(work, 'a'), 'a')
    await git(work, 'add', 'a')
    await git(work, 'commit', '--quiet', '-m', 'fixture')
    const linked = join(root, 'linked')
    await git(work, 'worktree', 'add', '--quiet', '--detach', linked)
    const records = await collect(new Scanner(new PathspecEvaluator(rule(root))).scan())
    assert.deepEqual(records.filter(record => record.type === 'problem'), [])
    const repositories = records.filter(record => record.type === 'repository')
    assert.equal(repositories.length, 3)
    assert.equal(repositories.filter(repo => repo.bare).length, 1)
    const trees = repositories.filter(repo => !repo.bare)
    assert.deepEqual(trees[0]!.commonDirectory, trees[1]!.commonDirectory)
    assert.notDeepEqual(trees[0]!.gitDirectory, trees[1]!.gitDirectory)
    assert.equal(completion(records).complete, true)
  })
})

test('read failures continue independent entries and cancellation does not survive into another scan', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'bad'), 'bad')
    await writeFile(join(root, 'good'), 'good')
    const scanner = new Scanner(new PathspecEvaluator(rule(root)), {
      ...scanningIO,
      inspect: async path => {
        if (nativePath(path).endsWith('/bad')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return scanningIO.inspect(path)
      },
    })
    const failed = await collect(scanner.scan())
    assert.ok(failed.some(record => record.type === 'entry' && record.source.path.endsWith('/good')))
    assert.equal(completion(failed).complete, false)
    const controller = new AbortController()
    controller.abort()
    const cancelled = await collect(scanner.scan({ signal: controller.signal }))
    assert.equal(completion(cancelled).complete, false)
    assert.equal(completion(cancelled).cancelled, true)
    const repeated = await collect(scanner.scan())
    assert.equal(repeated.filter(record => record.type === 'entry').length, failed.filter(record => record.type === 'entry').length)
  })
})

test('root junction relationships survive shared-content deduplication in either root order', async () => {
  await fixture(async root => {
    const data = join(root, 'data')
    const mirror = join(root, 'mirror')
    await mkdir(data)
    await symlink(data, mirror, process.platform === 'win32' ? 'junction' : 'dir')
    for (const paths of [[data, mirror], [mirror, data]]) {
      const records = await collect(new Scanner(new PathspecEvaluator(paths.map(rule).join('\n'))).scan())
      const roots = records.filter(record => record.type === 'root')
      assert.equal(roots.length, 2)
      assert.equal(roots[0]!.id, roots[1]!.id)
      assert.equal(roots.filter(record => record.symbolic).length, 1)
      assert.equal(roots.find(record => record.symbolic)?.symbolic?.materialised, false)
      assert.equal(completion(records).complete, true)
    }
    const onlyLink = await collect(new Scanner(new PathspecEvaluator(rule(mirror))).scan())
    const exposure = onlyLink.find(record => record.type === 'root')
    assert.ok(exposure?.type === 'root')
    assert.equal(exposure.symbolic?.materialised, true)
  })
})

test('selected directory links share a subtree and preserve their relationship', async () => {
  await fixture(async root => {
    const data = join(root, 'data')
    await mkdir(data)
    await writeFile(join(data, 'a'), 'a')
    await symlink(data, join(root, 'mirror'), process.platform === 'win32' ? 'junction' : 'dir')
    const records = await collect(new Scanner(new PathspecEvaluator(rule(root))).scan())
    assert.equal(records.filter(record => record.type === 'entry' && record.kind === 'file').length, 1)
    assert.ok(records.some(record => record.type === 'link' && record.relationship === 'symbolic' && record.materialised === false))
    const ids = new Set(records.filter(record => record.type === 'entry').map(record => record.id))
    for (const record of records) if (record.type === 'link') assert.ok(ids.has(record.id))
    assert.equal(completion(records).complete, true)
  })
})

test('file link references do not duplicate selected content in either enumeration order', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'target'), 'content')
    await writeFile(join(root, 'pointer'), 'scanner boundary fixture')
    for (const names of [['pointer', 'target'], ['target', 'pointer']]) {
      const scanner = new Scanner(new PathspecEvaluator(rule(root)), {
        ...scanningIO,
        children: async function* () { yield* names },
        inspect: async path => path.path.endsWith('/pointer')
          ? { ...await scanningIO.inspect(sourcePath(join(root, 'target'))), symbolic: { target: 'target' } }
          : scanningIO.inspect(path),
      })
      const records = await collect(scanner.scan())
      const files = records.filter(record => record.type === 'entry').filter(record => record.kind === 'file')
      const reference = records.find(record => record.type === 'link' && record.relationship === 'symbolic')
      assert.equal(files.length, 1)
      assert.ok(reference?.type === 'link')
      assert.equal(reference.id, files[0]!.id)
      assert.equal(reference.materialised, false)
      assert.equal(completion(records).complete, true)
    }
  })
})

test('incompatible external directory contexts fail regardless of enumeration order', async () => {
  await fixture(async root => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    const outside = join(root, 'outside')
    for (const path of [a, b, outside]) await mkdir(path)
    await writeFile(join(outside, 'cache'), 'cache')
    for (const path of [a, b]) {
      await symlink(outside, join(path, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    // The second inclusion would override the exclusion only on its route.
    // That cannot authorise two versions of the same external directory.
    for (const [first, second] of [[a, b], [b, a]]) {
      const text = `${rule(first!)}\n!${rule(join(outside, 'cache'))}\n${rule(second!)}`
      const records = await collect(new Scanner(new PathspecEvaluator(text)).scan())
      assert.ok(records.some(record => record.type === 'problem' && record.operation === 'share contents'))
      assert.equal(completion(records).complete, false)
    }
  })
})

test('malformed repository markers and failed Git queries retain working files but fail completion', async () => {
  await fixture(async root => {
    await writeFile(join(root, '.git'), 'gitdir: missing-storage\n')
    await writeFile(join(root, 'working'), 'working')
    const malformed = await collect(new Scanner(new PathspecEvaluator(rule(root))).scan())
    assert.ok(malformed.some(record => record.type === 'problem' && record.operation === 'detect repository'))
    assert.equal(malformed.filter(record => record.type === 'entry' && record.kind === 'file').length, 1)
    assert.equal(completion(malformed).complete, false)
    const failed = await collect(new Scanner(new PathspecEvaluator(rule(root)), {
      ...scanningIO,
      git: async () => { throw Object.assign(new Error('git unavailable'), { code: 'ENOENT' }) },
    }).scan())
    assert.ok(failed.some(record => record.type === 'entry' && record.source.path.endsWith('/working')))
    assert.equal(completion(failed).complete, false)
  })
})

test('malformed bare candidates are not flattened into ordinary content', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'HEAD'), 'invalid')
    await mkdir(join(root, 'objects'))
    await writeFile(join(root, 'objects', 'data'), 'not ordinary snapshot content')
    const records = await collect(new Scanner(new PathspecEvaluator(rule(root))).scan())
    assert.equal(records.filter(record => record.type === 'entry' && record.kind === 'file').length, 0)
    assert.equal(completion(records).complete, false)
  })
})

test('administrative subtrees cannot bypass repository boundaries as explicit roots', async () => {
  await fixture(async root => {
    await git(root, 'init', '--quiet', '--bare')
    const records = await collect(new Scanner(new PathspecEvaluator(rule(join(root, 'objects')))).scan())
    assert.equal(completion(records).complete, false)
    assert.equal(records.filter(record => record.type === 'entry').length, 0)
  })
})

test('early consumer exit closes traversal without a success record', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'a'), 'a')
    let opened = 0
    const scanner = new Scanner(new PathspecEvaluator(rule(root)), {
      ...scanningIO,
      children: async function* (path) {
        opened++
        try {
          yield* scanningIO.children(path)
        } finally {
          opened--
        }
      },
    })
    const records: ScanRecord[] = []
    for await (const record of scanner.scan()) {
      records.push(record)
      if (record.type === 'entry' && record.kind === 'file') break
    }
    assert.equal(opened, 0)
    assert.equal(records.some(record => record.type === 'completion'), false)
    assert.equal(completion(await collect(scanner.scan())).complete, true)
  })
})

test('iterator return cancels an awaited Git query without timers or a surviving process', async () => {
  await fixture(async root => {
    await git(root, 'init', '--quiet')
    let started!: () => void
    const queryStarted = new Promise<void>(resolve => { started = resolve })
    let active = false
    const scanner = new Scanner(new PathspecEvaluator(rule(root)), {
      ...scanningIO,
      git: async (_args, _cwd, signal) => {
        active = true
        started()
        try {
          return await new Promise<string>((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
          })
        } finally {
          active = false
        }
      },
    })
    const iterator = scanner.scan()
    await iterator.next() // root
    await iterator.next() // directory
    const next = iterator.next()
    await queryStarted
    const returned = iterator.return()
    const result = await next
    await returned
    assert.equal(active, false)
    assert.ok(result.value?.type === 'completion' && result.value.cancelled && !result.value.complete)
  })
})

test('links into repository storage cannot produce unresolved ordinary-file references', async () => {
  await fixture(async root => {
    const repository = join(root, 'repo')
    await mkdir(repository)
    await git(repository, 'init', '--quiet')
    await symlink(join(repository, '.git', 'objects'), join(root, 'objects'),
      process.platform === 'win32' ? 'junction' : 'dir')
    const records = await collect(new Scanner(new PathspecEvaluator(rule(root))).scan())
    assert.equal(completion(records).complete, false)
    assert.ok(records.some(record => record.type === 'problem'))
  })
})

test('rule-path retargeting during traversal invalidates completion', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'a'), 'a')
    let scanned = false
    const records = await collect(new Scanner(new PathspecEvaluator(rule(root)), {
      ...scanningIO,
      resolveRule: async path => scanned
        ? sourcePath(join(root, 'different'))
        : scanningIO.resolveRule(path),
      children: async function* (path) {
        yield* scanningIO.children(path)
        scanned = true
      },
    }).scan())
    assert.equal(completion(records).complete, false)
  })
})

test('equivalent external routes share content despite different inclusion rule positions', async () => {
  await fixture(async root => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    const outside = join(root, 'outside')
    for (const path of [a, b, outside]) await mkdir(path)
    await writeFile(join(outside, 'file'), 'content')
    for (const path of [a, b]) {
      await symlink(outside, join(path, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    const records = await collect(new Scanner(new PathspecEvaluator(`${rule(a)}\n${rule(b)}`)).scan())
    assert.equal(completion(records).complete, true)
    assert.equal(records.filter(record => record.type === 'entry' && record.kind === 'file').length, 1)
  })
})

test('selecting only a gitfile cannot be reported as an ordinary complete file snapshot', async () => {
  await fixture(async root => {
    await writeFile(join(root, '.git'), 'gitdir: elsewhere\n')
    const records = await collect(new Scanner(new PathspecEvaluator(rule(join(root, '.git')))).scan())
    assert.equal(completion(records).complete, false)
    assert.equal(records.filter(record => record.type === 'entry').length, 0)
  })
})

test('failed directory enumeration still visits independent directories', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'bad'))
    await mkdir(join(root, 'good'))
    await writeFile(join(root, 'good', 'file'), 'good')
    const records = await collect(new Scanner(new PathspecEvaluator(rule(root)), {
      ...scanningIO,
      children: async function* (path) {
        if (path.path.endsWith('/bad')) throw Object.assign(new Error('read failed'), { code: 'EIO' })
        yield* scanningIO.children(path)
      },
    }).scan())
    assert.ok(records.some(record => record.type === 'entry' && record.source.path.endsWith('/good/file')))
    assert.equal(completion(records).complete, false)
  })
})
