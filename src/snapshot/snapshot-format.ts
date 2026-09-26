import { PhysicalPath } from '../config/PathspecEvaluator.ts'
import type { ScanRecord } from '../filesystem/Scanner.ts'
import { Metadata } from '../filesystem/scanning-utils.ts'
import type { RepositoryInfo } from '../repos/RepositorySelection.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string'
}

function relativePath(value: unknown): value is string {
  return text(value) && !value.startsWith('/') && !value.includes('\0') &&
    (value === '' || value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
}

export interface ObjectReference {
  readonly repository: string
  readonly oid: string
}

export namespace ObjectReference {
  export function is(value: unknown): value is ObjectReference {
    return record(value) && text(value.repository) && /^[a-zA-Z0-9_-]+$/.test(value.repository) &&
      text(value.oid) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.oid)
  }

  export function oid(value: string, format: 'sha1' | 'sha256'): string {
    const result = value.replace(/\r?\n$/, '')
    if (!(format === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(result)) {
      throw new Error(`invalid ${format} object ID`)
    }
    return result
  }
}

export interface RepositoryIdentity {
  readonly id: string
  readonly name: string
  readonly commonDirectory: PhysicalPath
  readonly source: PhysicalPath
  readonly objectFormat: 'sha1' | 'sha256'
}

export namespace RepositoryIdentity {
  export function is(value: unknown): value is RepositoryIdentity {
    return record(value) && text(value.id) && value.id !== 'main' && /^[a-zA-Z0-9_-]+$/.test(value.id) &&
      text(value.name) && value.name.length > 0 && PhysicalPath.is(value.source) && PhysicalPath.is(value.commonDirectory) &&
      (value.objectFormat === 'sha1' || value.objectFormat === 'sha256')
  }
}

export interface AdministrativeEntry {
  readonly path: string
  readonly kind: 'file' | 'directory'
  readonly metadata: Metadata
  readonly oid?: string
  readonly target?: string
  readonly resolvedMetadata?: Metadata
}

export namespace AdministrativeEntry {
  export function is(value: unknown): value is AdministrativeEntry {
    return record(value) && relativePath(value.path) && Metadata.is(value.metadata) &&
      (value.resolvedMetadata === undefined || Metadata.is(value.resolvedMetadata)) &&
      (value.target === undefined || text(value.target)) &&
      (value.kind === 'directory' || (value.kind === 'file' &&
        ObjectReference.is({ repository: 'main', oid: value.oid })))
  }
}

export interface CapturedRepository {
  readonly identity: RepositoryIdentity
  readonly source: Omit<RepositoryInfo, 'origin'>
  readonly objects: readonly string[]
  readonly administrative: readonly AdministrativeEntry[]
  readonly nested: readonly { path: string; repository: string }[]
  readonly adminCommit: string
}

export namespace CapturedRepository {
  export function is(value: unknown): value is CapturedRepository {
    if (!record(value) || !RepositoryIdentity.is(value.identity) || !record(value.source)) return false
    const source = value.source
    const format = value.identity.objectFormat
    const oid = (value: unknown) => text(value) && (format === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(value)
    return PhysicalPath.is(source.source) && PhysicalPath.is(source.gitDirectory) &&
      PhysicalPath.is(source.commonDirectory) && typeof source.bare === 'boolean' &&
      source.objectFormat === format && Array.isArray(source.worktrees) &&
      source.worktrees.every(worktree => record(worktree) && text(worktree.id) && worktree.id.length > 0 &&
        !/[/\0]/.test(worktree.id) && PhysicalPath.is(worktree.source)) &&
      Array.isArray(value.administrative) && value.administrative.every(AdministrativeEntry.is) &&
      value.administrative.every(entry => entry.kind !== 'file' || oid(entry.oid)) &&
      Array.isArray(value.objects) && value.objects.every(oid) && oid(value.adminCommit) &&
      Array.isArray(value.nested) && value.nested.every(entry => record(entry) && relativePath(entry.path) &&
        text(entry.repository) && /^[a-zA-Z0-9_-]+$/.test(entry.repository))
  }
}

export interface CapturedEntry {
  readonly id: string
  readonly source: PhysicalPath
  readonly kind: 'file' | 'directory'
  readonly metadata: Metadata
  readonly objects: readonly ObjectReference[]
}

export interface SnapshotManifest {
  readonly version: 1
  readonly pathspec: string
  readonly entries: readonly CapturedEntry[]
  readonly roots: readonly Extract<ScanRecord, { type: 'root' }>[]
  readonly links: readonly Extract<ScanRecord, { type: 'link' }>[]
  readonly mounts: readonly SnapshotMount[]
  readonly repositories: readonly CapturedRepository[]
  readonly catalog: readonly RepositoryIdentity[]
  readonly skipped: readonly Extract<ScanRecord, { type: 'skipped' }>[]
}

export interface SnapshotMount {
  readonly name: string
  readonly entry: string
  readonly repository: string
  readonly commit: string
}

export namespace SnapshotManifest {
  export function parse(input: string): SnapshotManifest {
    const value: unknown = JSON.parse(input)
    if (!record(value) || value.version !== 1 || !text(value.pathspec) ||
      !['entries', 'roots', 'links', 'mounts', 'repositories', 'catalog', 'skipped'].every(key => Array.isArray(value[key]))) {
      throw new Error('invalid snapshot metadata')
    }
    const entries = value.entries as unknown[]
    const roots = value.roots as unknown[]
    const links = value.links as unknown[]
    const mounts = value.mounts as unknown[]
    const repositories = value.repositories as unknown[]
    if (!entries.every(entry => record(entry) && text(entry.id) && entry.id.length > 0 && PhysicalPath.is(entry.source) &&
      (entry.kind === 'file' || entry.kind === 'directory') && Metadata.is(entry.metadata) &&
      Array.isArray(entry.objects) && entry.objects.every(ObjectReference.is)) ||
      !roots.every(root => record(root) && root.type === 'root' && text(root.id) && record(root.destination) &&
        ['physical', 'alias', 'repository'].includes(String(root.destination.kind)) &&
        relativePath(root.destination.path) && (root.destination.kind !== 'physical' || PhysicalPath.is(root.destination)) &&
        (root.symbolic === undefined || (record(root.symbolic) && text(root.symbolic.target) &&
          typeof root.symbolic.materialised === 'boolean'))) ||
      !links.every(link => record(link) && link.type === 'link' && text(link.id) && text(link.parent) && text(link.name) &&
        link.name.length > 0 && !/[/\0]/.test(link.name) && link.name !== '.' && link.name !== '..' &&
        ['entry', 'hardlink', 'symbolic'].includes(String(link.relationship)) &&
        (link.target === undefined || text(link.target)) &&
        (link.materialised === undefined || typeof link.materialised === 'boolean')) ||
      !mounts.every(mount => record(mount) && relativePath(mount.name) && mount.name.length > 0 &&
        !mount.name.includes('/') && text(mount.entry) &&
        ObjectReference.is({ repository: mount.repository, oid: mount.commit })) ||
      !repositories.every(CapturedRepository.is) ||
      !(value.catalog as unknown[]).every(RepositoryIdentity.is) ||
      !(value.skipped as unknown[]).every(skip => record(skip) && skip.type === 'skipped' && PhysicalPath.is(skip.source) &&
        Array.isArray(skip.namedCopies) && skip.namedCopies.every(text))) {
      throw new Error('invalid snapshot records')
    }
    const ids = new Set(entries.map(entry => (entry as Record<string, unknown>).id))
    if (ids.size !== entries.length ||
      !roots.every(root => ids.has((root as Record<string, unknown>).id)) ||
      !links.every(link => ids.has((link as Record<string, unknown>).id) && ids.has((link as Record<string, unknown>).parent)) ||
      !mounts.every(mount => ids.has((mount as Record<string, unknown>).entry))) {
      throw new Error('invalid snapshot graph references')
    }
    const manifest = value as unknown as SnapshotManifest
    const entryById = new Map(manifest.entries.map(entry => [entry.id, entry]))
    if (manifest.links.some(link => entryById.get(link.parent)?.kind !== 'directory') ||
      manifest.mounts.some(mount => entryById.get(mount.entry)?.kind !== 'directory')) {
      throw new Error('invalid snapshot directory references')
    }
    const formats = new Map(manifest.repositories.map(repository => [repository.identity.id, repository.identity.objectFormat]))
    if (formats.size !== manifest.repositories.length ||
      new Set(manifest.catalog.map(identity => identity.id)).size !== manifest.catalog.length) {
      throw new Error('duplicate snapshot repository identity')
    }
    for (const reference of [
      ...manifest.entries.flatMap(entry => entry.objects),
      ...manifest.mounts.map(mount => ({ repository: mount.repository, oid: mount.commit })),
    ]) {
      const format = reference.repository === 'main' ? 'sha1' : formats.get(reference.repository)
      if (!format) throw new Error('unresolved snapshot object store')
      ObjectReference.oid(reference.oid, format)
    }
    if (manifest.entries.some(entry => entry.kind === 'file' && !entry.objects.length) ||
      manifest.repositories.some(repository => repository.nested.some(nested => !formats.has(nested.repository)))) {
      throw new Error('incomplete captured snapshot data')
    }
    return manifest
  }

  export function contentKey(manifest: SnapshotManifest): string {
    const { repositories, mounts, ...rest } = manifest
    const contents = {
      ...rest,
      repositories: repositories.map(({ adminCommit: _commit, ...repository }) => repository),
      mounts: mounts.map(({ commit: _commit, ...mount }) => mount),
    }
    const normalise = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(normalise)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalise(value[key])]))
      return value
    }
    return JSON.stringify(normalise(contents))
  }
}
