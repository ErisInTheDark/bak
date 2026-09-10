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

Matching is lexical and case-sensitive on complete components: `/foo` does not match `/foobar`. Separators normalise, `.` and redundant separators are removed, and `..` is rejected rather than resolved. Path spelling otherwise remains unchanged. Leading `//` denotes UNC, not POSIX.

`evaluate(physicalPath)` returns:

````ts
type Destination =
  | { kind: 'physical'; root: string; path: string }
  | { kind: 'alias'; path: string }
````

Physical roots retain their identity (`C:/`, `//server/share/`, `/`); `path` is root-relative. Aliases carry backup-relative paths. No final git-tree encoding is implied.

## evaluator API

````ts
import PathspecEvaluator from '../src/config/PathspecEvaluator.ts'

const evaluator = new PathspecEvaluator(text)
const destinations = evaluator.evaluate('C:/data/file.txt')
const roots = evaluator.getScanRoots()
````

The constructor compiles text once using an ordered statement-handler registry. Compiled exposure and shared-selection rules remain private. `evaluate` validates candidates and returns deduplicated destinations in exposure-declaration order without changing selection state.

`getScanRoots()` returns unique effective inclusion-source paths as `{ root, path }`. It omits fully excluded sources and includes independently re-included descendants beneath blocked ancestors. Roots can overlap; a scanner must deduplicate traversal. Neither method touches the filesystem or exposes mutable compiled state.

## boundaries

Literal subtrees only. Wildcard characters `*`, `?`, `[`, `]`, `{`, `}` are rejected, including in quotes. This is not a full git pathspec or gitignore implementation.

No filesystem access, existence checks, link traversal, filesystem case/identity resolution, git discovery or cross-source destination collision checks. `.git` has no implicit behaviour beyond shared selection. Alias destinations do not distinguish repositories from ordinary folders.

Later scanning must honour selection when discovering repository boundaries. Final tree encoding and collision handling belong to snapshot construction. Junctions, source mutation, backup creation and restoration are outside this slice.
