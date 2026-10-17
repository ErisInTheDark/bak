import { PathspecStatement, RepositoryMount } from './pathspec-syntax.ts'
import RemoteLocation from './RemoteLocation.ts'

export interface PhysicalPath {
  readonly root: string
  readonly path: string
}

export namespace PhysicalPath {
  export function is(value: unknown): value is PhysicalPath {
    if (!value || typeof value !== 'object' || !('root' in value) || !('path' in value) ||
      typeof value.root !== 'string' || typeof value.path !== 'string') return false
    try {
      candidate({ root: value.root, path: value.path })
      return true
    } catch {
      return false
    }
  }

  export function contains(parent: PhysicalPath, child: PhysicalPath): boolean {
    return parent.root === child.root && within(child.path, parent.path)
  }
}

export type Destination =
  | { readonly kind: 'physical'; readonly root: string; readonly path: string }
  | { readonly kind: 'alias'; readonly path: string }
  | { readonly kind: 'repository'; readonly path: string }

export interface SourceBinding {
  readonly source: PhysicalPath
  readonly resolved: PhysicalPath
}

export interface SelectionContext {
  readonly selected: boolean
  readonly order: number
}

interface SelectionRule {
  source: PhysicalPath
  include: boolean
  scope: keyof typeof selectionScopes
}

export interface Exposure {
  readonly source: PhysicalPath
  readonly origin: PhysicalPath
  readonly destination: Destination
}

interface Program {
  rules: SelectionRule[]
  exposures: Exposure[]
}

interface Compilation {
  variables: Map<string, PhysicalPath>
  aliases: Map<string, PhysicalPath>
  repositories: Map<string, PhysicalPath>
  repositoryBindings: readonly RepositoryMount[] | undefined
  mounts: RepositoryMount[]
  defer(): void
  program: Program
  destinationsAt(source: PhysicalPath): Destination[]
  resolve(source: PhysicalPath): PhysicalPath
  settings: Settings
}

const settingParsers = {
  remote: RemoteLocation.parse,
} as const satisfies Record<string, (value: string) => unknown>

type SettingName = keyof typeof settingParsers
type Settings = { -readonly [Name in SettingName]?: ReturnType<typeof settingParsers[Name]> } & {
  readonly environment: Map<string, string>
}

/** Selects the store command that resolves secrets, so it stays owned by the checkout `.env`. */
const reservedEnvironmentNames = new Set(['WB_STORES'])

type Statement = PathspecStatement

interface StatementHandler {
  matches(statement: Statement): boolean
  compile(statement: Statement, context: Compilation): void
}

function components(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('path contains a control character')
  if (/[*?[\]{}]/.test(value)) throw new Error('wildcards are not supported yet')
  const parts = value.split('/')
  if (parts.includes('..')) throw new Error('parent traversal is not allowed')
  return parts.filter(part => part !== '' && part !== '.').join('/')
}

function physical(value: string): PhysicalPath {
  const path = value.replaceAll('\\', '/')
  const drive = /^([a-zA-Z]:)\/+/.exec(path)
  if (drive) {
    return { root: `${drive[1]}/`, path: components(path.slice(drive[0].length)) }
  }
  if (path.startsWith('//')) {
    const unc = /^\/\/([^/]+)\/([^/]+)(?:\/+|$)/.exec(path)
    if (!unc || !components(unc[1]!) || !components(unc[2]!)) {
      throw new Error('UNC paths require a server and share')
    }
    return { root: `//${unc[1]}/${unc[2]}/`, path: components(path.slice(unc[0].length)) }
  }
  if (!path.startsWith('/')) throw new Error('physical paths must be absolute')
  return { root: '/', path: components(path.slice(1)) }
}

function candidate(value: string | PhysicalPath): PhysicalPath {
  if (typeof value === 'string') return physical(value)
  const root = physical(value.root)
  if (root.path || root.root !== value.root || value.path.includes('\0') ||
    value.path.split('/').some(part => part === '..' || part === '.' || (!part && value.path !== ''))) {
    throw new Error('invalid structured physical path')
  }
  return { ...value }
}

function alias(value: string): string {
  const path = value.replaceAll('\\', '/')
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new Error('aliases must be relative backup paths')
  }
  const result = components(path)
  if (!result) throw new Error('alias cannot be empty')
  return result
}

function within(path: string, parent: string): boolean {
  return parent === '' || path === parent || path.startsWith(`${parent}/`)
}

const selectionScopes = {
  subtree: within,
  contents: (path: string, parent: string) => path !== parent && within(path, parent),
}

function relative(path: string, parent: string): string {
  return parent === '' ? path : path.slice(parent.length).replace(/^\//, '')
}

function append(parent: string, suffix: string): string {
  return [parent, suffix].filter(Boolean).join('/')
}

function uniquePaths(paths: PhysicalPath[]): PhysicalPath[] {
  return paths.filter((path, index) =>
    paths.findIndex(other => other.root === path.root && other.path === path.path) === index,
  )
}

function uniqueDestinations(destinations: Destination[]): Destination[] {
  return destinations.filter((destination, index) =>
    destinations.findIndex(other => sameDestination(other, destination)) === index,
  )
}

function sameDestination(first: Destination, second: Destination): boolean {
  return first.kind === second.kind && first.path === second.path &&
    (first.kind !== 'physical' || second.kind !== 'physical' || first.root === second.root)
}

const value = PathspecStatement.value

function source(expression: string, variables: ReadonlyMap<string, PhysicalPath>): PhysicalPath {
  const expanded = value(expression)
  if (!expanded.startsWith('$')) return physical(expanded)
  const reference = /^\$([a-zA-Z_]\w*)(?:[/\\](.*))?$/.exec(expanded)
  if (!reference) throw new Error('invalid variable reference')
  const base = variables.get(reference[1]!)
  if (!base) throw new Error(`unknown variable $${reference[1]}`)
  return { root: base.root, path: append(base.path, components((reference[2] ?? '').replaceAll('\\', '/'))) }
}

function exposureMapping(destination: string, mappings: ReadonlyMap<string, PhysicalPath>, label: string) {
  const mapping = [...mappings.entries()]
    .filter(([name]) => within(destination, name))
    .sort(([a], [b]) => b.length - a.length)[0]
  if (!mapping) throw new Error(`unknown ${label}${destination}`)
  const [name, origin] = mapping
  const suffix = relative(destination, name)
  return {
    anchor: origin,
    source: { root: origin.root, path: append(origin.path, suffix) },
  }
}

const statementHandlers: readonly StatementHandler[] = [
  {
    matches: ([left]) => left.startsWith('@env.'),
    compile: ([left, right], context) => {
      if (right === undefined) throw new Error(`setting ${left} needs = value`)
      const name = left.slice('@env.'.length)
      if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`invalid environment variable name ${name}`)
      if (reservedEnvironmentNames.has(name)) throw new Error(`${name} cannot be overridden from a backup folder`)
      if (context.settings.environment.has(name)) throw new Error(`setting ${left} is already defined`)
      context.settings.environment.set(name, value(right))
    },
  },
  {
    matches: ([left]) => left.startsWith('@'),
    compile: ([left, right], context) => {
      if (right === undefined) throw new Error(`setting ${left} needs = value`)
      const name = left.slice(1)
      if (!Object.hasOwn(settingParsers, name)) throw new Error(`unknown setting ${left}`)
      const setting = name as SettingName
      if (context.settings[setting] !== undefined) throw new Error(`setting ${left} is already defined`)
      context.settings[setting] = settingParsers[setting](value(right))
    },
  },
  {
    matches: ([left, right]) => right !== undefined && left.startsWith('$'),
    compile: ([left, right], context) => {
      if (!/^\$[a-zA-Z_]\w*$/.test(left)) throw new Error('invalid variable name')
      const name = left.slice(1)
      if (context.variables.has(name)) throw new Error(`variable ${left} is already defined`)
      context.variables.set(name, source(right!, context.variables))
    },
  },
  {
    matches: ([left, right]) => right !== undefined && left.startsWith('repo:/'),
    compile: ([left, right], context) => {
      const name = RepositoryMount.name(value(left.slice('repo:/'.length)))
      const lexical = source(right!, context.variables)
      if (context.repositories.has(name)) throw new Error(`repository mount ${name} is already defined`)
      context.mounts.push({ name, source: lexical })
      const mounts = [
        { name, source: lexical },
        ...(context.repositoryBindings ?? []).filter(binding => binding.name.startsWith(`${name}+`)),
      ]
      for (const mount of mounts) {
        if (context.repositories.has(mount.name)) throw new Error(`repository mount ${mount.name} is already defined`)
        context.repositories.set(mount.name, mount.source)
        const resolved = context.resolve(mount.source)
        context.program.rules.push({ source: resolved, include: true, scope: 'contents' })
        context.program.exposures.push({
          source: resolved, origin: mount.source, destination: { kind: 'repository', path: mount.name },
        })
      }
    },
  },
  {
    matches: ([left, right]) => right !== undefined && left.startsWith('#'),
    compile: ([left, right], context) => {
      const destination = alias(value(left.slice(1)))
      const lexical = source(right!, context.variables)
      const origin = context.resolve(lexical)
      const previous = context.aliases.get(destination)
      if (previous && (previous.root !== lexical.root || previous.path !== lexical.path)) {
        throw new Error(`alias #${destination} already maps to another source`)
      }
      context.aliases.set(destination, lexical)
      // A new root exposes its contents, not its incoming edge in other trees.
      context.program.rules.push({ source: origin, include: true, scope: 'contents' })
      context.program.exposures.push({ source: origin, origin: lexical, destination: { kind: 'alias', path: destination } })
    },
  },
  {
    matches: ([, right]) => right === undefined,
    compile: ([left], context) => {
      const include = !left.startsWith('!')
      const expression = include ? left : left.slice(1).trim()
      const repository = expression.startsWith('repo:/')
      const destination = repository
        ? alias(value(expression.slice('repo:/'.length)))
        : expression.startsWith('#') ? alias(value(expression.slice(1))) : undefined
      if (repository && destination?.split('/')[0]?.includes('+') && !context.repositoryBindings) {
        const base = destination.split('+')[0]!
        if (!context.repositories.has(base)) throw new Error(`unknown repository mount ${base}`)
        context.defer()
        return
      }
      const mapping = destination === undefined ? undefined :
        exposureMapping(destination, repository ? context.repositories : context.aliases, repository ? 'repository mount repo:/' : 'alias #')
      const lexical = mapping?.source ?? source(expression, context.variables)
      const origin = context.resolve(lexical)
      // Explicit re-inclusion below a blocked child must stay shared across the
      // currently visible parent views, but must not revive hidden parent routes.
      const contains = (parent: PhysicalPath, child: PhysicalPath) =>
        parent.root === child.root && within(child.path, parent.path)
      const anchor = mapping
        ? { source: context.resolve(mapping.anchor), origin: mapping.anchor }
        : context.program.exposures
          .filter(exposure => contains(exposure.source, origin) || contains(exposure.origin, lexical))
          .sort((a, b) => b.origin.path.length - a.origin.path.length)[0]
      const sharedRoots = include && anchor ? [anchor, ...context.program.exposures].filter(root =>
        (contains(anchor.source, root.source) && contains(root.source, origin)) ||
        (contains(anchor.origin, root.origin) && contains(root.origin, lexical)),
      ) : []
      const shared = uniqueDestinations(sharedRoots.flatMap(root => {
        // A junction can move the source outside its lexical parent. Destination
        // suffixes still include that junction component.
        const suffix = contains(root.source, origin)
          ? relative(origin.path, root.source.path)
          : relative(lexical.path, root.origin.path)
        return context.destinationsAt(root.source).map(destination => ({
          ...destination, path: append(destination.path, suffix),
        }))
      }))
      context.program.rules.push({ source: origin, include, scope: 'subtree' })
      if (include) {
        const explicit: Destination = destination === undefined
          ? { kind: 'physical', ...lexical }
          : { kind: repository ? 'repository' : 'alias', path: destination }
        context.program.exposures.push(
          ...uniqueDestinations([...shared, explicit]).map(destination => ({ source: origin, origin: lexical, destination })),
        )
      } else {
        context.program.exposures = context.program.exposures.filter(exposure =>
          exposure.source.root !== origin.root || !within(exposure.source.path, origin.path),
        )
      }
    },
  },
]

export default class PathspecEvaluator {
  readonly #program: Program = { rules: [], exposures: [] }
  readonly #sources: PhysicalPath[] = []
  readonly #text: string
  readonly #mounts: RepositoryMount[] = []
  readonly #settings: Settings = { environment: new Map() }
  readonly #repositoryBindings: readonly RepositoryMount[] | undefined
  #deferred = false

  constructor(text: string, bindings?: readonly SourceBinding[], repositoryBindings?: readonly RepositoryMount[]) {
    this.#text = text
    this.#repositoryBindings = repositoryBindings?.map(binding => ({
      name: binding.name, source: { ...binding.source },
    }))
    const context: Compilation = {
      variables: new Map(),
      aliases: new Map(),
      repositories: new Map(),
      repositoryBindings: this.#repositoryBindings,
      mounts: this.#mounts,
      settings: this.#settings,
      defer: () => { this.#deferred = true },
      program: this.#program,
      destinationsAt: source => this.#evaluate(source),
      resolve: source => {
        this.#sources.push(source)
        if (!bindings) return source
        const binding = bindings.find(binding =>
          binding.source.root === source.root && binding.source.path === source.path,
        )
        if (!binding) throw new Error(`missing source binding for ${source.root}${source.path}`)
        return candidate(binding.resolved)
      },
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      try {
        const [left = '', right] = PathspecStatement.parse(line)
        if (!left && right === undefined) continue
        const parsed: Statement = right === undefined ? [left] : [left, right]
        const handler = statementHandlers.find(handler => handler.matches(parsed))
        if (!handler) throw new Error('only variables, aliases, repository mounts and settings can be assigned')
        handler.compile(parsed, context)
      } catch (error) {
        if (!(error instanceof Error)) throw error
        throw new Error(`line ${index + 1}: ${error.message}`, { cause: error })
      }
    }
  }

  evaluate(physicalPath: string | PhysicalPath): Destination[] {
    if (this.#deferred) throw new Error('bind registered worktrees before evaluating dynamic paths')
    return this.#evaluate(physicalPath)
  }

  #evaluate(physicalPath: string | PhysicalPath): Destination[] {
    const path = candidate(physicalPath)
    const destinations: Destination[] = []
    for (const exposure of this.#program.exposures) {
      if (path.root !== exposure.source.root || !within(path.path, exposure.source.path)) continue
      const suffix = relative(path.path, exposure.source.path)
      const segments = suffix.split('/').filter(Boolean)
      const route = segments.map((_, index) => append(exposure.source.path, segments.slice(0, index + 1).join('/')))
      // A separate exposure can start below an excluded ancestor, but cannot
      // reopen that ancestor for another route to the same shared contents.
      if (!route.every(part => this.enter({ root: path.root, path: part }).selected)) continue
      const destination: Destination = {
        ...exposure.destination,
        path: append(exposure.destination.path, suffix),
      }
      destinations.push(destination)
    }
    return uniqueDestinations(destinations)
  }

  getScanRoots(): PhysicalPath[] {
    return uniquePaths(this.#program.exposures.map(exposure => ({ ...exposure.source })))
  }

  getSourcePaths(): PhysicalPath[] {
    return uniquePaths(this.#sources).map(source => ({ ...source }))
  }

  getExposures(): Exposure[] {
    return this.#program.exposures.filter((exposure, index, exposures) =>
      exposures.findIndex(other =>
        other.source.root === exposure.source.root && other.source.path === exposure.source.path &&
        sameDestination(other.destination, exposure.destination),
      ) === index,
    ).map(exposure => ({
      source: { ...exposure.source }, origin: { ...exposure.origin }, destination: { ...exposure.destination },
    }))
  }

  bindSources(bindings: readonly SourceBinding[]): PathspecEvaluator {
    return new PathspecEvaluator(this.#text, bindings, this.#repositoryBindings)
  }

  getRemote(): RemoteLocation | undefined {
    return this.#settings.remote
  }

  /** `@env.NAME` overrides, layered over the checkout `.env` when loading remote credentials. */
  getEnvironment(): Record<string, string> {
    return Object.fromEntries(this.#settings.environment)
  }

  getRepositoryMounts(): RepositoryMount[] {
    return this.#mounts.map(mount => ({ name: mount.name, source: { ...mount.source } }))
  }

  bindRepositories(bindings: readonly RepositoryMount[]): PathspecEvaluator {
    return new PathspecEvaluator(this.#text, undefined, bindings)
  }

  enter(path: PhysicalPath, inherited: SelectionContext = { selected: false, order: -1 }): SelectionContext {
    const source = candidate(path)
    return this.#program.rules.reduce((context, rule, order) =>
      order >= context.order && source.root === rule.source.root &&
        selectionScopes[rule.scope](source.path, rule.source.path)
        ? { selected: rule.include, order }
        : context,
    inherited)
  }

  contents(path: PhysicalPath, inherited: SelectionContext = { selected: false, order: -1 }): SelectionContext {
    const source = candidate(path)
    return this.#program.rules.reduce((context, rule, order) =>
      order >= context.order && source.root === rule.source.root && within(source.path, rule.source.path)
        ? { selected: rule.include, order }
        : context,
    inherited)
  }

  equivalentContexts(first: SelectionContext, second: SelectionContext): boolean {
    if (first.selected !== second.selected) return false
    if (first.order === second.order) return true
    // Literal subtree rules partition paths at these boundaries. Compare both
    // the boundary and its contents, including rules reached through later links.
    return this.#program.rules.every(rule =>
      this.enter(rule.source, first).selected === this.enter(rule.source, second).selected &&
      this.contents(rule.source, first).selected === this.contents(rule.source, second).selected,
    )
  }
}
