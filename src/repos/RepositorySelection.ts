import type { PhysicalPath } from '../config/PathspecEvaluator.ts'
import { RepositoryMount } from '../config/pathspec-syntax.ts'
import type { RepositoryRecord, ScanRecord } from '../filesystem/Scanner.ts'

export interface RepositoryInfo {
  readonly source: PhysicalPath
  readonly gitDirectory: PhysicalPath
  readonly commonDirectory: PhysicalPath
  readonly bare: boolean
  readonly objectFormat: 'sha1' | 'sha256'
  readonly origin: string | null
  readonly worktrees: readonly RepositoryWorktree[]
}

export interface RepositoryWorktree {
  readonly id: string
  readonly source: PhysicalPath
}

export interface NamedRepository {
  readonly name: string
  readonly repository: RepositoryInfo
}

export type RepositoryDecision =
  | { readonly selected: true }
  | { readonly selected: false; readonly namedCopies: readonly string[] }

export interface RepositoryGroup {
  readonly name: string
  readonly anchor: RepositoryRecord
}

export interface RepositoryNames {
  readonly groups: ReadonlyMap<string, RepositoryGroup>
  readonly mounts: ReadonlyMap<string, string>
}

export namespace RepositoryInfo {
  export function key(repository: RepositoryInfo): string {
    return repository.commonDirectory.root + repository.commonDirectory.path
  }
}

export default class RepositorySelection {
  constructor(readonly named: readonly NamedRepository[]) {}

  decide(repository: RepositoryInfo): RepositoryDecision {
    if (this.named.some(named => RepositoryInfo.key(named.repository) === RepositoryInfo.key(repository))) {
      return { selected: true }
    }
    const namedCopies = repository.origin === null ? [] : this.named
      .filter(named => named.repository.origin === repository.origin)
      .map(named => named.name)
    return namedCopies.length ? { selected: false, namedCopies } : { selected: true }
  }

  resolve(
    repositories: readonly RepositoryRecord[],
    automatic: readonly Extract<ScanRecord, { type: 'worktree-root' }>[],
  ): RepositoryNames {
    const candidates = new Map<string, RepositoryRecord[]>()
    for (const repository of repositories) {
      const key = RepositoryInfo.key(repository)
      const views = candidates.get(key) ?? []
      views.push(repository)
      candidates.set(key, views)
    }
    const groups = new Map<string, RepositoryGroup>()
    const mounts = new Map<string, string>()
    const occupied = new Map<string, string>()
    const assign = (id: string, name: string) => {
      const previous = occupied.get(name.toLowerCase())
      if (previous && previous !== id) throw new Error(`repository name collision: explicitly name ${name}`)
      occupied.set(name.toLowerCase(), id)
      mounts.set(id, name)
    }
    for (const [common, views] of candidates) {
      const declaration = this.named.find(mount => RepositoryInfo.key(mount.repository) === common)
      const ordered = [...views].sort((a, b) => {
        const primary = (repository: RepositoryRecord) => repository.workingTree !== null &&
          repository.gitDirectory.root + repository.gitDirectory.path === common
        const priority = Number(primary(b)) - Number(primary(a))
        const first = a.source.root + a.source.path
        const second = b.source.root + b.source.path
        return priority || (first < second ? -1 : first > second ? 1 : 0)
      })
      const anchor = declaration ? views.find(repository =>
        repository.source.root === declaration.repository.source.root &&
        repository.source.path === declaration.repository.source.path) : ordered[0]
      if (!anchor) throw new Error('declared repository has no selected root')
      const parts = (anchor.source.root + anchor.source.path).split('/').filter(Boolean)
      const name = RepositoryMount.name(declaration?.name ??
        (parts.at(-1) === '.git' ? parts.at(-2) ?? '' : parts.at(-1) ?? ''))
      groups.set(common, { name, anchor })
      for (const repository of views) {
        const registered = anchor.worktrees.find(worktree =>
          worktree.source.root === repository.source.root && worktree.source.path === repository.source.path)
        const mount = repository.id === anchor.id ? name :
          registered ? `${name}+${registered.id}` :
            RepositoryMount.name((repository.source.root + repository.source.path).split('/').filter(Boolean).at(-1) ?? '')
        assign(repository.id, mount)
      }
    }
    for (const root of automatic) {
      if (mounts.has(root.id)) continue
      const owner = groups.get(root.commonDirectory.root + root.commonDirectory.path)
      if (!owner) throw new Error('automatic worktree has no captured repository owner')
      assign(root.id, `${owner.name}+${root.worktree}`)
    }
    return { groups, mounts }
  }
}
