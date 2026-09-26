# literal pathspec selection

Rules run top to bottom. Inclusion selects shared source contents and exposes a root; `!` excludes shared source contents. An independently exposed root can start beneath an excluded parent without reopening that parent.

````text
C:/Users/Username # include the user directory
$Documents = C:/Users/Username/Documents
!$Documents
#projects/foo = $Documents/foo
!#projects/foo/out
!#projects/foo/.git
````

Results:

| source below `C:/Users/Username` | destination |
|---|---|
| `Desktop/a.txt` | physical path |
| `Documents/other.txt` | excluded |
| `Documents/foo/src/a.ts` | alias `projects/foo/src/a.ts` |
| `Documents/foo/out/a.js` | excluded |
| `Documents/foo/.git/config` | excluded |

## syntax

- Blank lines do nothing. Unquoted `# ` starts a comment, including inline comments. Bare `#` is not a comment.
- `$Name = path` defines a physical-path variable without selecting it. Names use ASCII letters/underscore followed by letters, digits or underscores. Definitions must precede references; redefinition fails.
- `$Name/subpath` expands a variable. Definitions can reference earlier variables.
- `path` includes a physical subtree and exposes its physical destination. `!path` excludes that source subtree across exposures.
- `#destination = path` includes shared source contents and exposes a logical alias. It does not re-include the source folder's incoming path in another exposure. Repeating the same mapping re-includes it; changing an existing alias's source fails.
- `!#destination/subpath` resolves to a physical source exclusion. It affects every exposure of that source, not just the named alias.
- `#destination/subpath` re-includes shared source contents and exposes that alias subtree. The longest matching declared alias resolves nested names.
- All alias references, including exclusions, require a prior declaration.
- Explicit subtree re-inclusion restores that subtree across currently visible shared parent views, whether written through a physical path or an alias. Entirely removed root exposures stay removed unless explicitly exposed again.
- Multiple destinations are allowed. Identical destinations are deduplicated.

## repository mounts

````text
$Work = C:/work
$Work
repo:/widget-work = $Work/widget
repo:/widget-test = D:/experiments/widget
!repo:/widget-work+feature/node_modules
````

`repo:/name = source` selects a repository and names its canonical snapshot mount. The base mount uses the literal source checkout, including when that source is a linked worktree. It never substitutes the main checkout.

Other registered linked worktrees appear automatically as `repo:/name+<registered-id>`, even outside ordinary source roots. The base checkout is not duplicated under its own dynamic path. Worktree IDs come from Git registration, not current branch names. Dynamic inclusions/exclusions require a preceding repository declaration; the scanner supplies their filesystem bindings.

Base names are portable single folder components; `+` is reserved for worktree paths. Invalid names and multiple explicit base declarations for one common Git directory fail. Use ordinary aliases for additional exposures of that repository.

Unnamed repositories use their source folder name when unambiguous. Name collisions require explicit declarations; discovery order never chooses a winner. Canonical mounts appear under reserved snapshot `repos/`; top-level `.bak-meta/` is also reserved.

If a project has active named mounts, separate unnamed clones with exactly the same configured `remote.origin.url` are skipped as whole subtrees. Skips are reported. Independently mounted nested repositories can remain selected. Different URLs, shared upstreams and absent origins do not match. URL spelling is not normalised or rewritten; multiple origin URLs fail as ambiguous. Linked worktrees sharing Git storage are not separate clones.

Excluding `.git` retains ordinary-file treatment for an unnamed working directory. A named mount must retain repository treatment. Explicit administrative-file exclusions are honoured during capture. Exclusions inside Git object storage that prevent full repository preservation fail rather than being bypassed.

Referenced Git storage inherits its repository's effective selection context. A later repository mount can select a nested repository whose storage lies beneath an earlier excluded parent; later exclusions still apply.

Changing the source location for an existing stored name requires `commit --relocate repo:/name`. This acknowledges identity continuity; it does not move source files or modify old snapshots.

## shared contents, separate exposure

````text
#one = C:/data
#two = C:/data
!#one/out
````

`out` is excluded from both aliases. A later `#two/out` restores it through both still-exposed parent roots. Excluding `.git` likewise applies to both; aliases cannot select different repository/folder versions of the same source.

An exclusion at or above an exposed root removes that exposure. Below a remaining root, each source-path component must be selected. A blocked ancestor prevents traversal through that exposure. A separate root below the blocked ancestor bypasses it, not its own descendant exclusions.

In the opening example, the physical exposure starts at `C:/Users/Username`; the excluded `Documents` component blocks that route. The alias exposure starts directly at `Documents/foo`, so its contents appear only under `projects/foo`. Later alias declarations can re-include shared descendants without reopening the excluded physical ancestor.

The same applies when aliasing `Documents` itself: the alias exposes its contents, but does not reopen the excluded `Documents` path under the user-directory exposure.

Deep re-inclusion, such as `#two/cache/keep` after excluding `cache`, creates descendant roots across the currently visible shared parent views. Aliases rooted inside that parent also receive the shared subtree. Unselected siblings remain excluded; the blocked parent need not be scanned. Physical re-inclusion uses the nearest currently exposed source ancestor as its sharing context.

## quoting

Double-quote an entire path value to preserve surrounding spaces, `# ` or `=`. Alias names can be quoted after `#`.

````text
$Data = "C:\my # data\x=y "
#"my copy" = $Data
````

Backslashes remain literal in quotes, then normalise to `/` as path separators. Quotes cannot be embedded or escaped. Assignment uses one unquoted `=`. Empty values, malformed statements and unknown variables fail with source line numbers.

## paths and outputs

Accept absolute drive paths (`C:/data`), UNC paths (`//server/share/data`) and POSIX paths (`/home/user`). Relative physical roots and incomplete UNC roots fail. Aliases must be nonempty relative paths.

Standalone matching is lexical and case-sensitive on complete components: `/foo` does not match `/foobar`. Separators normalise, `.` and redundant separators are removed, and `..` is rejected rather than resolved. Path spelling otherwise remains unchanged. Leading `//` denotes UNC, not POSIX.

`evaluate(physicalPath)` returns:

````ts
type Destination =
  | { kind: 'physical'; root: string; path: string }
  | { kind: 'alias'; path: string }
  | { kind: 'repository'; path: string }
````

Physical roots retain their identity (`C:/`, `//server/share/`, `/`); `path` is root-relative. Aliases carry backup-relative paths. Repository destinations carry mount-relative paths. Snapshot projection maps physical paths directly (`C:/data` to `C/data`, UNC `//server/share` to `server/share`, POSIX `/home` to `home`) and rejects collisions.

## evaluator API

````ts
import PathspecEvaluator from '../src/config/PathspecEvaluator.ts'

const evaluator = new PathspecEvaluator(text)
const destinations = evaluator.evaluate('C:/data/file.txt')
const roots = evaluator.getScanRoots()
````

The constructor compiles text once using an ordered statement-handler registry. Compiled exposure and shared-selection rules remain private. `evaluate` validates candidates and returns deduplicated destinations in exposure-declaration order without changing selection state.

`getScanRoots()` returns unique effective inclusion-source paths as `{ root, path }`. It omits fully excluded sources and includes independently re-included descendants beneath blocked ancestors. Roots can overlap; the scanner deduplicates traversal.

`getExposures()` returns `{ source, origin, destination }` records. `source` identifies selected content; `origin` retains the original source spelling, including a junction route. A shared source can have several exposures.

`getSourcePaths()` includes all rule-source paths, including exclusions and expanded alias suffixes, but not unused variables. `bindSources([{ source, resolved }])` recompiles into a new evaluator using complete scanner-supplied bindings. Original destination spelling and the original evaluator remain unchanged. No evaluator method performs filesystem access or exposes mutable compiled state.

`getRepositoryMounts()` returns explicit `{ name, source }` declarations. `bindRepositories([{ name: 'widget+feature', source }])` supplies registered worktree roots and recompiles dynamic rules. Public evaluation with unresolved dynamic rules fails rather than using a partial selection.

The scanner resolves configured paths before traversal. For example, if `D:/mirror` is a junction to `C:/data`, `!D:/mirror/cache` also excludes `C:/data/cache`. Deep re-inclusion retains the original destination suffix even when a link leaves its lexical parent directory.

Traversal uses `enter(path, inheritedContext)` for entry selection and `contents(path, inheritedContext)` for descendant selection. Contexts retain the winning rule's order so following an external link does not restart rule ordering. `equivalentContexts` compares selection behaviour at all literal-rule boundaries, including strict-root versus descendant selection.

`evaluate` also accepts structured `{ root, path }` candidates for discovered filenames. Their characters are literal; brackets and similar filename characters do not become pattern syntax. Parent traversal and malformed structured paths still fail.

## boundaries

Literal subtrees only. Wildcard characters `*`, `?`, `[`, `]`, `{`, `}` are rejected in pathspec expressions, including in quotes. This is not a full git pathspec or gitignore implementation.

The evaluator itself does not access files, discover links/repositories or check cross-source destination collisions. Filesystem bindings are supplied by the scanner. `.git` has no implicit evaluator behaviour beyond shared selection. Alias destinations do not distinguish repositories from ordinary folders.

See [scanning](scanning.md) for discovery and [snapshots](snapshots.md) for capture, destination collisions, publication and readback. Filesystem restoration remains unimplemented.
