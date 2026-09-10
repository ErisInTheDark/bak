# scanning

`Scanner` combines a pure `PathspecEvaluator` with filesystem utilities. It performs read-only discovery, not content capture.

````ts
import PathspecEvaluator from '../src/config/PathspecEvaluator.ts'
import Scanner, { type ScanRecord } from '../src/filesystem/Scanner.ts'

const records: ScanRecord[] = []
const scanner = new Scanner(new PathspecEvaluator(text))
for await (const record of scanner.scan({ signal })) records.push(record)

const result = records.at(-1)
if (result?.type !== 'completion' || !result.complete) {
  throw new Error('the selected scan is not complete')
}
````

Collecting is optional. Consumers can process records incrementally. A completion record is part of the stream, not an async generator return value lost by `for await`.

## records

`ScanRecord` is a discriminated union exported by `Scanner.ts`.

| type | meaning |
| --- | --- |
| `root` | Destination exposure referencing an entry ID. A symbolic root retains its observed target and whether it must be materialised. |
| `entry` | File/directory content identity, canonical source path and inspection metadata. No file bytes. |
| `link` | Named edge from a directory to an entry ID. Relationship is ordinary membership, symbolic link or additional hardlink name. |
| `repository` | Entry's working-tree location, Git directory, common directory, bare status and object format. Administrative-only selections have no working tree. |
| `problem` | Source, operation, message and available error code. The run cannot finish complete. |
| `completion` | Complete/incomplete, cancelled flag and entry/repository/problem counts. |

References may precede entries. Several exposures/edges can reference one content identity. Root destinations are structured physical/alias paths, not encoded Git-tree paths.

IDs use filesystem device/inode identity within one scan. They are not persistent backup IDs. Metadata includes device/inode, link count, mode, size, modification time and change time; integer metadata uses decimal strings where needed. This is inspection evidence, not a complete restoration manifest.

Ordinary files stream without a retained file list. The scanner retains directory identities, configured file-root identities and linked-file identity metadata. Memory therefore grows with those relationships, selection rules and traversal depth, not file contents. Directory enumeration order is filesystem-defined.

## selection and links

Before emitting entries, resolve all configured rule paths, including exclusions, and recompile selection with those bindings. Missing rule suffixes resolve through existing ancestors. Missing selected sources produce problems; nonexistent exclusions alone do not.

Original destination spelling stays separate from resolved content identity. Junction spellings and aliases therefore share exclusions/re-inclusion without losing root exposure paths.

- A link to independently selected content preserves its relationship and references that content.
- A link to unselected content is followed under its selected route. Its `materialised: true` relationship means restore should expose ordinary content there, not recreate a dependency on an unselected external target. This also applies to a junction selected as the only source root.
- Multiply linked files share one content entry. A lone selected hardlink remains an ordinary selected file.
- Equivalent external traversal contexts share contents. If contexts would produce different selection behaviour, report a conflict and require excluding one route. Never choose a successful first-route-wins variant.
- Directory cycles, dangling/unreadable links, unsupported entry types and unusable filesystem identities produce problems.

Configured rule paths are resolved again before completion. Retargeting during traversal invalidates the run. This is not an atomic filesystem snapshot and cannot detect every possible concurrent mutation.

Pathspec syntax remains literal-only. Structured discovered names support literal wildcard characters. Native roots must match the host platform. Unsupported filename encoding or filesystem identity is a problem, not silent filename rewriting.

## repositories

The scanner owns repository detection; there is no detector plugin framework.

Selected `.git` directories/gitfiles are validated with system Git. Linked worktrees retain distinct Git directories and shared common storage. Working directories continue through selected dirty, untracked and nested-repository content. Git ignore rules do not replace backup selection.

Recognised administrative storage is not flattened into ordinary file entries. Bare repositories and directly selected Git directories produce administrative-only repository records. Selecting only a gitfile or an administrative subtree, including through a link, fails rather than pretending it is a complete repository; select its working-tree/repository root instead.

Excluding `.git` disables repository treatment for that working directory across its exposures. Malformed markers, unsupported Git responses and query failures produce problems. Independent working paths continue.

Queries run without a shell or inherited repository-location/configuration overrides. Global/system Git configuration is disabled; repository configuration remains available to Git's own metadata queries. No refs, index or source contents are modified.

Repository records describe discovery only. They do not claim objects, refs, reflogs, hooks, metadata or dirty contents have been captured.

## lifecycle and failures

Each invocation owns its traversal, identity table, counters and cancellation. No state survives into another scan. `return()` cancels an awaited Git query and closes traversal handles. An external abort signal uses the same cancellation path. No retries, polling or background scanning.

Individual inspection/enumeration/repository failures yield problems and permit independent work to continue. A source-binding failure retains an unresolved rule only for best-effort diagnostics; that run is already incomplete.

Normal exhaustion emits one completion record. Consumer early exit emits no success certificate. Cancellation either yields an incomplete cancelled completion when consumed or ends through iterator disposal.

Only a terminal complete result means discovery succeeded. File bytes and repository data still require capture and validation. Commit creation must require one complete selected snapshot, not merely a clean scan.

## validation

Run `pnpm test` and `pnpm typecheck`. Scanner tests create isolated temporary Git/filesystem fixtures and remove only those fixtures. They cover shared selection, link references/materialisation, repository boundaries, failure continuation and cancellation without timer races. Windows uses real junctions and hardlinks; the file-symbolic-link policy test injects resolved link metadata at the filesystem boundary.

The current validation host is Windows. Linux behaviour requires a separate run. No source backup or restore operation is exercised because those operations do not exist yet.
