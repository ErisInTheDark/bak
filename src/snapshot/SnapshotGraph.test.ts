import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScanRecord } from '../filesystem/Scanner.ts'
import SnapshotGraph from './SnapshotGraph.ts'

function entry(id: string): Extract<ScanRecord, { type: 'entry' }> {
  return {
    type: 'entry', id, source: { root: '/', path: id }, kind: 'file',
    metadata: { device: '1', inode: id, links: '1', mode: 0o100644, size: '1', mtimeNs: '1', ctimeNs: '1' },
  }
}

const complete: ScanRecord = { type: 'completion', complete: true, cancelled: false, problems: 0, entries: 2, repositories: 0 }

test('snapshot graph refuses incomplete scans and unresolved references', () => {
  assert.throws(() => SnapshotGraph.collect([entry('a')]), /incomplete/)
  assert.throws(() => SnapshotGraph.collect([
    { type: 'root', id: 'missing', destination: { kind: 'alias', path: 'file' } }, complete,
  ]), /unresolved/)
  assert.throws(() => SnapshotGraph.collect([entry('unreachable'), complete]), /unreachable/)
})

test('snapshot graph rejects destination collisions but deduplicates the same selected content', () => {
  const root = { type: 'root', id: 'a', destination: { kind: 'alias', path: 'file' } } as const
  const shared = new SnapshotGraph(SnapshotGraph.collect([entry('a'), root, root, complete]))
  assert.doesNotThrow(() => shared.project(new Map()))
  const conflicting = new SnapshotGraph(SnapshotGraph.collect([
    entry('a'), entry('b'), root, { ...root, id: 'b' }, complete,
  ]))
  assert.throws(() => conflicting.project(new Map()), /collision/)
})

test('a filesystem-root exposure cannot occupy the reserved metadata namespace', () => {
  const graph = new SnapshotGraph(SnapshotGraph.collect([
    { ...entry('root'), kind: 'directory' },
    entry('file'),
    { type: 'root', id: 'root', destination: { kind: 'physical', root: '/', path: '' } },
    { type: 'link', parent: 'root', name: '.bak-meta', id: 'file', relationship: 'entry' },
    complete,
  ]))
  assert.throws(() => graph.project(new Map()), /collision/)
})
