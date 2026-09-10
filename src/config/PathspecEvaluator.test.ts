import assert from 'node:assert/strict'
import { test } from 'node:test'
import PathspecEvaluator from './PathspecEvaluator.ts'

const example = `
C:/Users/Username # backs up this dir and everything inside it
$Documents = C:/Users/Username/Documents
!$Documents
#projects/foo = $Documents/foo
!#projects/foo/out
!#projects/foo/.git
`

test('the complete selection example excludes documents but restores the aliased project', () => {
  const evaluator = new PathspecEvaluator(example)
  const select = (suffix: string) => evaluator.evaluate(`C:/Users/Username/${suffix}`)
  assert.deepEqual(select('Desktop/a.txt'), [
    { kind: 'physical', root: 'C:/', path: 'Users/Username/Desktop/a.txt' },
  ])
  assert.deepEqual(select('Documents/other.txt'), [])
  assert.deepEqual(select('Documents/foo/src/a.ts'), [{ kind: 'alias', path: 'projects/foo/src/a.ts' }])
  assert.deepEqual(select('Documents/foo/out/a.js'), [])
  assert.deepEqual(select('Documents/foo/.git/config'), [])
})

test('later physical inclusion restores a subtree without restoring its siblings', () => {
  const evaluator = new PathspecEvaluator('/home\n!/home/docs\n/home/docs/project')
  assert.deepEqual(evaluator.evaluate('/home/docs/project/a'), [
    { kind: 'physical', root: '/', path: 'home/docs/project/a' },
  ])
  assert.deepEqual(evaluator.evaluate('/home/docs/other'), [])
})

test('variables alone select nothing, expand earlier variables, and accept suffixes', () => {
  const evaluator = new PathspecEvaluator('$Home = /home/user\n$Docs = $Home/docs\n$Docs/project')
  assert.deepEqual(evaluator.evaluate('/home/user/other'), [])
  assert.deepEqual(evaluator.evaluate('/home/user/docs/project/a'), [
    { kind: 'physical', root: '/', path: 'home/user/docs/project/a' },
  ])
})

test('alias exclusions and re-inclusion update the shared source at every exposure', () => {
  const prefix = '/data\n#first = /data\n#second = /data\n!#first/tmp'
  assert.deepEqual(new PathspecEvaluator(prefix).evaluate('/data/tmp/a'), [])
  assert.deepEqual(new PathspecEvaluator(`${prefix}\n!/data/tmp`).evaluate('/data/tmp/a'), [])
  assert.deepEqual(new PathspecEvaluator(`${prefix}\n!/data/tmp\n#first/tmp`).evaluate('/data/tmp/a'), [
    { kind: 'physical', root: '/', path: 'data/tmp/a' },
    { kind: 'alias', path: 'first/tmp/a' },
    { kind: 'alias', path: 'second/tmp/a' },
  ])
})

test('aliased repository markers have one shared selection state', () => {
  const text = '#one = /project\n#two = /project\n!#one/.git'
  assert.deepEqual(new PathspecEvaluator(text).evaluate('/project/.git'), [])
  assert.deepEqual(new PathspecEvaluator(text).evaluate('/project/.git/config'), [])
  assert.deepEqual(new PathspecEvaluator(`${text}\n#two/.git`).evaluate('/project/.git/config'), [
    { kind: 'alias', path: 'one/.git/config' },
    { kind: 'alias', path: 'two/.git/config' },
  ])
})

test('a later alias declaration restores shared contents without reopening excluded ancestors', () => {
  const evaluator = new PathspecEvaluator('/home\n!/home/docs\n#one = /home/docs/foo\n!#one/out\n#two = /home/docs/foo')
  assert.deepEqual(evaluator.evaluate('/home/docs/foo/out/a'), [
    { kind: 'alias', path: 'one/out/a' },
    { kind: 'alias', path: 'two/out/a' },
  ])
  assert.deepEqual(evaluator.evaluate('/home/docs/other'), [])
})

test('identical destinations are deduplicated and repeated aliases can re-include', () => {
  const evaluator = new PathspecEvaluator('/data\n/data/sub\n#copy = /data\n#copy = /data\n#copy')
  assert.deepEqual(evaluator.evaluate('/data/sub/a'), [
    { kind: 'physical', root: '/', path: 'data/sub/a' },
    { kind: 'alias', path: 'copy/sub/a' },
  ])
  const reIncluded = new PathspecEvaluator('/data\n#copy = /data\n!#copy\n#copy = /data')
  assert.deepEqual(reIncluded.evaluate('/data/a'), [{ kind: 'alias', path: 'copy/a' }])
})

test('subtree matching respects components and case, including alias boundaries', () => {
  const evaluator = new PathspecEvaluator('/foo\n#copy = /foo\n!#copy/out')
  assert.deepEqual(evaluator.evaluate('/foobar/a'), [])
  assert.deepEqual(evaluator.evaluate('/Foo/a'), [])
  assert.deepEqual(evaluator.evaluate('/foo/outside'), [
    { kind: 'physical', root: '/', path: 'foo/outside' },
    { kind: 'alias', path: 'copy/outside' },
  ])
})

test('normalises drive, UNC and POSIX separators without losing root identity', () => {
  for (const [rule, candidate, root, path] of [
    ['C:\\data\\', 'C:/data/./a', 'C:/', 'data/a'],
    ['\\\\server\\share\\data', '//server/share/data/a', '//server/share/', 'data/a'],
    ['/', '/data/a', '/', 'data/a'],
  ]) {
    assert.deepEqual(new PathspecEvaluator(rule!).evaluate(candidate!), [{ kind: 'physical', root, path }])
  }
})

test('quoted values protect comments, equals signs and path whitespace', () => {
  const evaluator = new PathspecEvaluator('# a comment\n$Data = "C:\\my # data\\x=y "\n#"my copy" = $Data # comment')
  assert.deepEqual(evaluator.evaluate('C:/my # data/x=y /a'), [{ kind: 'alias', path: 'my copy/a' }])
  assert.deepEqual(evaluator.evaluate('C:/my # data/x=y/a'), [])
})

test('empty selection and excluded .git have no implicit repository behaviour', () => {
  assert.deepEqual(new PathspecEvaluator('# comment\n').evaluate('/a'), [])
  const evaluator = new PathspecEvaluator('/project\n!/project/.git')
  assert.deepEqual(evaluator.evaluate('/project/.git'), [])
  assert.deepEqual(evaluator.evaluate('/project/src/a'), [{ kind: 'physical', root: '/', path: 'project/src/a' }])
})

test('invalid rules report their source line instead of guessing', () => {
  for (const invalid of [
    '$Missing/x',
    '$Name = /a\n$Name = /b',
    '#copy',
    '!#unknown/out',
    '#copy = /a\n#copy = /b',
    'relative/path',
    '/a/../b',
    '/a/*',
    '/a/?',
    '/a/[bc]',
    'C:relative',
    '//server',
    '$Name =',
    '!',
    '"/unclosed',
    '#../bad = /a',
    '#copy = /a = /b',
  ]) {
    assert.throws(() => new PathspecEvaluator(`\n${invalid}`), /line [2-9]\d*:/, invalid)
  }
})

test('invalid candidate paths cannot escape selection boundaries', () => {
  const evaluator = new PathspecEvaluator('/data')
  assert.throws(() => evaluator.evaluate('/data/../secret'))
  assert.throws(() => evaluator.evaluate('data/file'))
})

test('scan roots retain independently exposed descendants beneath excluded ancestors', () => {
  const evaluator = new PathspecEvaluator('/home\n!/home/docs\n#project = /home/docs/foo\n!#project/cache\n#project/cache/keep')
  assert.deepEqual(evaluator.getScanRoots(), [
    { root: '/', path: 'home' },
    { root: '/', path: 'home/docs/foo' },
    { root: '/', path: 'home/docs/foo/cache/keep' },
  ])
  assert.deepEqual(evaluator.evaluate('/home/docs'), [])
  assert.deepEqual(evaluator.evaluate('/home/docs/foo/cache'), [])
  assert.deepEqual(evaluator.evaluate('/home/docs/foo/cache/keep/a'), [{ kind: 'alias', path: 'project/cache/keep/a' }])
})

test('scan roots deduplicate aliases and omit fully excluded sources', () => {
  const evaluator = new PathspecEvaluator('#one = C:/data\n#two = C:/data\nC:/excluded\n!C:/excluded')
  assert.deepEqual(evaluator.getScanRoots(), [{ root: 'C:/', path: 'data' }])
  assert.deepEqual(new PathspecEvaluator('/data\n!/data').getScanRoots(), [])
  assert.deepEqual(new PathspecEvaluator('$Data = /data').getScanRoots(), [])
})

test('exposing an excluded folder itself through an alias does not reopen its physical route', () => {
  const evaluator = new PathspecEvaluator('/home\n!/home/docs\n#docs = /home/docs')
  assert.deepEqual(evaluator.evaluate('/home/docs/a'), [{ kind: 'alias', path: 'docs/a' }])
})

test('deep re-inclusion restores shared descendants through every alias without restoring siblings', () => {
  const evaluator = new PathspecEvaluator('#one = /data\n#two = /data\n!#one/cache\n#two/cache/keep')
  assert.deepEqual(evaluator.evaluate('/data/cache/keep/a'), [
    { kind: 'alias', path: 'one/cache/keep/a' },
    { kind: 'alias', path: 'two/cache/keep/a' },
  ])
  assert.deepEqual(evaluator.evaluate('/data/cache/other'), [])
})

test('physical re-inclusion also restores shared descendants exposed through aliases', () => {
  const evaluator = new PathspecEvaluator('#one = /data\n#two = /data\n!#one/cache\n/data/cache/keep')
  assert.deepEqual(evaluator.evaluate('/data/cache/keep/a'), [
    { kind: 'alias', path: 'one/cache/keep/a' },
    { kind: 'alias', path: 'two/cache/keep/a' },
    { kind: 'physical', root: '/', path: 'data/cache/keep/a' },
  ])
  assert.deepEqual(evaluator.evaluate('/data/cache/other'), [])
})

test('re-inclusion through a broader alias also reaches aliases rooted inside it', () => {
  const evaluator = new PathspecEvaluator('#one = /data\n#two = /data/sub\n!#one/sub/cache\n#one/sub/cache/keep')
  assert.deepEqual(evaluator.evaluate('/data/sub/cache/keep/a'), [
    { kind: 'alias', path: 'one/sub/cache/keep/a' },
    { kind: 'alias', path: 'two/cache/keep/a' },
  ])
  assert.deepEqual(evaluator.evaluate('/data/sub/cache/other'), [])
})

test('filesystem binding recompiles shared rules without changing destination spelling or the original', () => {
  const original = new PathspecEvaluator('/data\n/mirror\n!/mirror/cache\n/mirror/cache/keep')
  const bound = original.bindSources(original.getSourcePaths().map(source => ({
    source,
    resolved: { ...source, path: source.path.replace(/^mirror(?=\/|$)/, 'data') },
  })))
  assert.deepEqual(bound.evaluate('/data/cache/other'), [])
  assert.deepEqual(bound.evaluate('/data/cache/keep/a'), [
    { kind: 'physical', root: '/', path: 'data/cache/keep/a' },
    { kind: 'physical', root: '/', path: 'mirror/cache/keep/a' },
  ])
  assert.notDeepEqual(original.evaluate('/data/cache/other'), [])
  assert.throws(() => original.bindSources([]))
})

test('binding enumerates exclusions and alias suffixes, not unused variables', () => {
  const evaluator = new PathspecEvaluator('$Unused = /unused\n#copy = /mirror\n!#copy/cache')
  assert.deepEqual(evaluator.getSourcePaths(), [
    { root: '/', path: 'mirror' },
    { root: '/', path: 'mirror/cache' },
  ])
})

test('followed content inherits rule order but later resolved rules still apply', () => {
  const evaluator = new PathspecEvaluator('/selected\n!/outside/cache\n/outside/cache/keep')
  const context = evaluator.enter({ root: '/', path: 'selected/link' })
  assert.equal(context.selected, true)
  assert.equal(evaluator.enter({ root: '/', path: 'outside/file' }, context).selected, true)
  assert.equal(evaluator.enter({ root: '/', path: 'outside/cache' }, context).selected, false)
  assert.equal(evaluator.enter({ root: '/', path: 'outside/cache/keep' }, context).selected, true)
})

test('structured discovered paths keep literal wildcard characters and cannot traverse parents', () => {
  const evaluator = new PathspecEvaluator('/data')
  assert.deepEqual(evaluator.evaluate({ root: '/', path: 'data/[draft].txt' }), [
    { kind: 'physical', root: '/', path: 'data/[draft].txt' },
  ])
  assert.throws(() => evaluator.evaluate({ root: '/', path: 'data/../secret' }))
})

test('deep re-inclusion across an external link preserves the alias-relative suffix', () => {
  const original = new PathspecEvaluator('#one = /selected\n#two = /selected\n!#one/link/cache\n#two/link/cache/keep')
  const bound = original.bindSources(original.getSourcePaths().map(source => ({
    source,
    resolved: { ...source, path: source.path.replace(/^selected\/link(?=\/|$)/, 'outside') },
  })))
  assert.deepEqual(bound.evaluate('/outside/cache/keep/a'), [
    { kind: 'alias', path: 'one/link/cache/keep/a' },
    { kind: 'alias', path: 'two/link/cache/keep/a' },
  ])
})
