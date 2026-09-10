export interface PhysicalPath {
  readonly root: string
  readonly path: string
}

export type Destination =
  | { readonly kind: 'physical'; readonly root: string; readonly path: string }
  | { readonly kind: 'alias'; readonly path: string }

interface SelectionRule {
  source: PhysicalPath
  include: boolean
  scope: keyof typeof selectionScopes
}

interface Exposure {
  source: PhysicalPath
  destination: Destination
}

interface Program {
  rules: SelectionRule[]
  exposures: Exposure[]
}

interface Compilation {
  variables: Map<string, PhysicalPath>
  aliases: Map<string, PhysicalPath>
  program: Program
  destinationsAt(source: PhysicalPath): Destination[]
}

type Statement = readonly [left: string, right?: string]

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
  return destinations.filter((destination, index) => destinations.findIndex(other =>
    other.kind === destination.kind &&
    other.path === destination.path &&
    (other.kind !== 'physical' || destination.kind !== 'physical' || other.root === destination.root)
  ) === index)
}

// Only unquoted "# " and "=" are grammar, so quoted paths retain both.
function statement(line: string): string[] {
  const parts: string[] = []
  let start = 0
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted
    if (quoted) continue
    if (line[index] === '#' && line[index + 1] === ' ') {
      line = line.slice(0, index)
      break
    }
    if (line[index] === '=') {
      parts.push(line.slice(start, index).trim())
      start = index + 1
    }
  }
  if (quoted) throw new Error('unterminated quoted path')
  parts.push(line.slice(start).trim())
  if (parts.length > 2) throw new Error('expected at most one assignment')
  return parts
}

function value(text: string): string {
  if (!text) throw new Error('expected a path')
  if (text.startsWith('"') && text.endsWith('"') && !text.slice(1, -1).includes('"')) {
    const result = text.slice(1, -1)
    if (!result) throw new Error('expected a nonempty path')
    return result
  }
  if (text.includes('"')) throw new Error('quote the complete path')
  return text
}

function source(expression: string, variables: ReadonlyMap<string, PhysicalPath>): PhysicalPath {
  const expanded = value(expression)
  if (!expanded.startsWith('$')) return physical(expanded)
  const reference = /^\$([a-zA-Z_]\w*)(?:[/\\](.*))?$/.exec(expanded)
  if (!reference) throw new Error('invalid variable reference')
  const base = variables.get(reference[1]!)
  if (!base) throw new Error(`unknown variable $${reference[1]}`)
  return { root: base.root, path: append(base.path, components((reference[2] ?? '').replaceAll('\\', '/'))) }
}

function aliasMapping(destination: string, aliases: ReadonlyMap<string, PhysicalPath>) {
  const mapping = [...aliases.entries()]
    .filter(([name]) => within(destination, name))
    .sort(([a], [b]) => b.length - a.length)[0]
  if (!mapping) throw new Error(`unknown alias #${destination}`)
  const [name, origin] = mapping
  const suffix = relative(destination, name)
  return {
    anchor: origin,
    source: { root: origin.root, path: append(origin.path, suffix) },
  }
}

const statementHandlers: readonly StatementHandler[] = [
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
    matches: ([left, right]) => right !== undefined && left.startsWith('#'),
    compile: ([left, right], context) => {
      const destination = alias(value(left.slice(1)))
      const origin = source(right!, context.variables)
      const previous = context.aliases.get(destination)
      if (previous && (previous.root !== origin.root || previous.path !== origin.path)) {
        throw new Error(`alias #${destination} already maps to another source`)
      }
      context.aliases.set(destination, origin)
      // A new root exposes its contents, not its incoming edge in other trees.
      context.program.rules.push({ source: origin, include: true, scope: 'contents' })
      context.program.exposures.push({ source: origin, destination: { kind: 'alias', path: destination } })
    },
  },
  {
    matches: ([, right]) => right === undefined,
    compile: ([left], context) => {
      const include = !left.startsWith('!')
      const expression = include ? left : left.slice(1).trim()
      const destination = expression.startsWith('#') ? alias(value(expression.slice(1))) : undefined
      const mapping = destination === undefined ? undefined : aliasMapping(destination, context.aliases)
      const origin = mapping?.source ?? source(expression, context.variables)
      // Explicit re-inclusion below a blocked child must stay shared across the
      // currently visible parent views, but must not revive hidden parent routes.
      const anchor = mapping?.anchor ?? context.program.exposures
        .filter(exposure => exposure.source.root === origin.root && within(origin.path, exposure.source.path))
        .sort((a, b) => b.source.path.length - a.source.path.length)[0]?.source
      const sharedRoots = include && anchor ? uniquePaths([
        anchor,
        ...context.program.exposures
          .map(exposure => exposure.source)
          .filter(root =>
            root.root === origin.root && within(root.path, anchor.path) && within(origin.path, root.path),
          ),
      ]) : []
      const shared = uniqueDestinations(sharedRoots.flatMap(root =>
        context.destinationsAt(root).map(destination => ({
          ...destination,
          path: append(destination.path, relative(origin.path, root.path)),
        })),
      ))
      context.program.rules.push({ source: origin, include, scope: 'subtree' })
      if (include) {
        const explicit: Destination = destination === undefined
          ? { kind: 'physical', ...origin }
          : { kind: 'alias', path: destination }
        context.program.exposures.push(
          ...uniqueDestinations([...shared, explicit]).map(destination => ({ source: origin, destination })),
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

  constructor(text: string) {
    const context: Compilation = {
      variables: new Map(),
      aliases: new Map(),
      program: this.#program,
      destinationsAt: source => this.evaluate(source.root + source.path),
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      try {
        const [left = '', right] = statement(line)
        if (!left && right === undefined) continue
        const parsed: Statement = right === undefined ? [left] : [left, right]
        const handler = statementHandlers.find(handler => handler.matches(parsed))
        if (!handler) throw new Error('only variables and aliases can be assigned')
        handler.compile(parsed, context)
      } catch (error) {
        if (!(error instanceof Error)) throw error
        throw new Error(`line ${index + 1}: ${error.message}`, { cause: error })
      }
    }
  }

  #selected(candidate: PhysicalPath): boolean {
    return this.#program.rules.reduce((selected, rule) =>
      candidate.root === rule.source.root && selectionScopes[rule.scope](candidate.path, rule.source.path)
        ? rule.include
        : selected,
    false)
  }

  evaluate(physicalPath: string): Destination[] {
    const candidate = physical(physicalPath)
    const destinations: Destination[] = []
    for (const exposure of this.#program.exposures) {
      if (candidate.root !== exposure.source.root || !within(candidate.path, exposure.source.path)) continue
      const suffix = relative(candidate.path, exposure.source.path)
      const segments = suffix.split('/').filter(Boolean)
      const route = segments.map((_, index) => append(exposure.source.path, segments.slice(0, index + 1).join('/')))
      // A separate exposure can start below an excluded ancestor, but cannot
      // reopen that ancestor for another route to the same shared contents.
      if (!route.every(path => this.#selected({ root: candidate.root, path }))) continue
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
}
