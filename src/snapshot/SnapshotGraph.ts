import type { RepositoryRecord, ScanRecord } from '../filesystem/Scanner.ts'
import type { Destination } from '../config/PathspecEvaluator.ts'
import type { GitTreeEntry } from '../git/GitProcess.ts'

export interface SnapshotGraphData {
  readonly entries: ReadonlyMap<string, Extract<ScanRecord, { type: 'entry' }>>
  readonly roots: readonly Extract<ScanRecord, { type: 'root' }>[]
  readonly children: ReadonlyMap<string, ReadonlyMap<string, Extract<ScanRecord, { type: 'link' }>>>
  readonly repositories: ReadonlyMap<string, RepositoryRecord>
  readonly mounts: readonly Extract<ScanRecord, { type: 'mount' }>[]
  readonly skipped: readonly Extract<ScanRecord, { type: 'skipped' }>[]
  readonly worktreeRoots: readonly Extract<ScanRecord, { type: 'worktree-root' }>[]
}

export type SnapshotTree =
  | { readonly kind: 'entry'; readonly id: string }
  | { readonly kind: 'directory'; readonly id?: string; readonly children: Map<string, SnapshotTree> }

export interface SnapshotTreeWriter {
  entry(id: string, store: string): Promise<Omit<GitTreeEntry, 'name'>>
  tree(entries: readonly GitTreeEntry[], store: string): Promise<string>
}

export namespace SnapshotGraphData {
  export function links(data: SnapshotGraphData): Extract<ScanRecord, { type: 'link' }>[] {
    return [...data.children.values()].flatMap(children => [...children.values()])
  }

  export function signature(data: SnapshotGraphData): string {
    const sets = [
      [...data.entries.values()], data.roots, links(data),
      [...data.repositories.values()], data.mounts, data.skipped, data.worktreeRoots,
    ]
    return JSON.stringify(sets.map(records => records.map(record => JSON.stringify(record)).sort()))
  }

}

export default class SnapshotGraph {
  constructor(readonly data: SnapshotGraphData) {}

  static path(destination: Destination): string {
    if (destination.kind === 'repository') return `repos/${destination.path}`
    if (destination.kind === 'alias') return destination.path
    const root = destination.root === '/' ? '' :
      destination.root.startsWith('//') ? destination.root.slice(2).replace(/\/$/, '') :
        destination.root.slice(0, -2)
    return [root, destination.path].filter(Boolean).join('/')
  }

  static collect(records: readonly ScanRecord[]): SnapshotGraphData {
    const completion = records.at(-1)
    const problems = records.filter(record => record.type === 'problem')
    if (completion?.type !== 'completion' || !completion.complete || problems.length) {
      throw new Error(`incomplete scan: ${problems.map(problem => problem.message).join('; ')}`)
    }
    const entries = new Map<string, Extract<ScanRecord, { type: 'entry' }>>()
    for (const record of records) {
      if (record.type !== 'entry') continue
      const previous = entries.get(record.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('inconsistent shared entry')
      entries.set(record.id, record)
    }
    const roots = records.filter(record => record.type === 'root')
    const links = records.filter(record => record.type === 'link')
    const repositories = new Map<string, RepositoryRecord>()
    for (const record of records) {
      if (record.type !== 'repository') continue
      const previous = repositories.get(record.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('inconsistent repository record')
      repositories.set(record.id, record)
    }
    const worktreeRoots = records.filter(record => record.type === 'worktree-root')
    for (const reference of [...roots, ...links, ...repositories.values(), ...worktreeRoots]) {
      if (!entries.has(reference.id)) throw new Error('unresolved snapshot entry reference')
    }
    const children = new Map<string, Map<string, typeof links[number]>>()
    for (const link of links) {
      if (entries.get(link.parent)?.kind !== 'directory') throw new Error('unresolved snapshot parent reference')
      if (!link.name || link.name === '.' || link.name === '..' || /[/\0]/.test(link.name)) {
        throw new Error('invalid snapshot directory entry')
      }
      const siblings = children.get(link.parent) ?? new Map<string, typeof link>()
      const previous = siblings.get(link.name)
      if (previous && (previous.id !== link.id || previous.relationship !== link.relationship ||
        previous.target !== link.target || previous.materialised !== link.materialised)) {
        throw new Error('conflicting snapshot directory relationships')
      }
      siblings.set(link.name, link)
      children.set(link.parent, siblings)
    }
    const reachable = new Set([...roots, ...worktreeRoots].map(root => root.id))
    for (const id of reachable) {
      for (const link of children.get(id)?.values() ?? []) reachable.add(link.id)
    }
    if (reachable.size !== entries.size) throw new Error('unreachable selected snapshot entries')
    return {
      entries, roots, children, repositories, worktreeRoots,
      mounts: records.filter(record => record.type === 'mount'),
      skipped: records.filter(record => record.type === 'skipped'),
    }
  }

  project(mounts: ReadonlyMap<string, string>): SnapshotTree {
    const tree: SnapshotTree = { kind: 'directory', children: new Map() }
    for (const [id, name] of mounts) this.#insert(tree, `repos/${name}`, this.source(id))
    for (const root of this.data.roots) {
      const path = SnapshotGraph.path(root.destination)
      const source = this.source(root.id)
      const reserved = ['repos', '.bak-meta']
      if (root.destination.kind !== 'repository' && (reserved.includes(path.split('/')[0]!) ||
        (!path && source.kind === 'directory' && reserved.some(name => source.children.has(name))))) {
        throw new Error(`destination collision with reserved snapshot path ${path}`)
      }
      this.#insert(tree, path, source)
    }
    return tree
  }

  source(id: string, repositoryRoot = false, ancestors: readonly string[] = []): SnapshotTree {
    const entry = this.data.entries.get(id)
    if (!entry) throw new Error('unresolved snapshot entry')
    if (ancestors.includes(id)) throw new Error('snapshot directory cycle')
    if (entry.kind === 'file' || (!repositoryRoot && this.data.repositories.has(id))) {
      return { kind: 'entry', id }
    }
    const children = new Map<string, SnapshotTree>()
    for (const link of this.data.children.get(id)?.values() ?? []) {
      const child = this.source(link.id, false, [...ancestors, id])
      const previous = children.get(link.name)
      children.set(link.name, previous ? this.#merge(previous, child) : child)
    }
    return { kind: 'directory', id, children }
  }

  async write(tree: SnapshotTree, store: string, writer: SnapshotTreeWriter): Promise<Omit<GitTreeEntry, 'name'>> {
    if (tree.kind === 'entry') return writer.entry(tree.id, store)
    const entries: GitTreeEntry[] = []
    for (const [name, child] of [...tree.children].sort(([a], [b]) => a.localeCompare(b))) {
      entries.push({ name, ...await this.write(child, store, writer) })
    }
    return { mode: '040000', type: 'tree', oid: await writer.tree(entries, store) }
  }

  #insert(root: Extract<SnapshotTree, { kind: 'directory' }>, path: string, value: SnapshotTree): void {
    const parts = path.split('/').filter(Boolean)
    if (!parts.length) {
      if (value.kind !== 'directory') throw new Error('snapshot root must be a directory')
      this.#merge(root, value)
      return
    }
    let directory = root
    for (const part of parts.slice(0, -1)) {
      if (part === '.' || part === '..' || part.includes('\0')) throw new Error('invalid snapshot destination')
      const existing = directory.children.get(part)
      if (existing?.kind === 'entry') throw new Error(`destination collision at ${path}`)
      const child = existing ?? { kind: 'directory' as const, children: new Map<string, SnapshotTree>() }
      directory.children.set(part, child)
      directory = child
    }
    const name = parts.at(-1)!
    if (name === '.' || name === '..' || name.includes('\0')) throw new Error('invalid snapshot destination')
    const previous = directory.children.get(name)
    directory.children.set(name, previous ? this.#merge(previous, value) : value)
  }

  #merge(first: SnapshotTree, second: SnapshotTree): SnapshotTree {
    if (first.kind === 'entry' || second.kind === 'entry') {
      if (first.kind === 'entry' && second.kind === 'entry' && first.id === second.id) return first
      throw new Error('snapshot destination collision')
    }
    if (first.id && second.id && first.id !== second.id) throw new Error('snapshot destination collision')
    for (const [name, child] of second.children) {
      const previous = first.children.get(name)
      first.children.set(name, previous ? this.#merge(previous, child) : child)
    }
    const id = first.id ?? second.id
    return id ? { ...first, id } : first
  }
}
