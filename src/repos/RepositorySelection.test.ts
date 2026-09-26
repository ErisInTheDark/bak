import assert from 'node:assert/strict'
import { test } from 'node:test'
import RepositorySelection, { type RepositoryInfo } from './RepositorySelection.ts'

function repository(path: string, origin: string | null): RepositoryInfo {
  return {
    source: { root: '/', path },
    gitDirectory: { root: '/', path: `${path}/.git` },
    commonDirectory: { root: '/', path: `${path}/.git` },
    bare: false, objectFormat: 'sha1', origin, worktrees: [],
  }
}

test('named copies suppress only separate clones with exactly matching origins', () => {
  const named = repository('named', 'ssh://host/project')
  const selection = new RepositorySelection([{ name: 'chosen', repository: named }])
  assert.deepEqual(selection.decide(repository('duplicate', named.origin)), {
    selected: false, namedCopies: ['chosen'],
  })
  assert.deepEqual(selection.decide(repository('different-spelling', 'https://host/project')), { selected: true })
  assert.deepEqual(selection.decide(repository('no-remote', null)), { selected: true })
  assert.deepEqual(selection.decide(named), { selected: true })
})

test('linked worktrees retain selection through shared storage identity', () => {
  const named = repository('named', 'ssh://host/project')
  const worktree = { ...repository('feature', named.origin), commonDirectory: named.commonDirectory }
  assert.deepEqual(new RepositorySelection([{ name: 'chosen', repository: named }]).decide(worktree), { selected: true })
})

test('repository names require explicit disambiguation rather than discovery-order suffixes', () => {
  const a = repository('work/widget', null)
  const b = repository('experiments/widget', null)
  const first = { ...a, type: 'repository' as const, id: 'a', workingTree: a.source }
  const second = { ...b, type: 'repository' as const, id: 'b', workingTree: b.source }
  assert.throws(() => new RepositorySelection([]).resolve([first, second], []), /collision/)
  const named = new RepositorySelection([
    { name: 'widget-work', repository: a }, { name: 'widget-test', repository: b },
  ]).resolve([second, first], [])
  assert.equal(named.mounts.get('a'), 'widget-work')
  assert.equal(named.mounts.get('b'), 'widget-test')
})

test('explicit linked-worktree names stay anchored to their literal source', () => {
  const base = repository('feature', null)
  const sibling = { ...repository('bugfix', null), commonDirectory: base.commonDirectory }
  const worktrees = [{ id: 'feature', source: base.source }, { id: 'bugfix', source: sibling.source }]
  const feature = { ...base, type: 'repository' as const, id: 'feature', workingTree: base.source, worktrees }
  const bugfix = { ...sibling, type: 'repository' as const, id: 'bugfix', workingTree: sibling.source, worktrees }
  const named = new RepositorySelection([{ name: 'widget', repository: feature }]).resolve([bugfix, feature], [])
  assert.equal(named.mounts.get('feature'), 'widget')
  assert.equal(named.mounts.get('bugfix'), 'widget+bugfix')
})
