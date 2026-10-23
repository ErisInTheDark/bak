# local snapshots

`SnapshotStore` owns capture and publication. `SnapshotReader` lists/reads stored snapshots without accessing sources. Core data is plain interfaces/objects; classes coordinate operations.

````ts
import SnapshotStore from '../src/snapshot/SnapshotStore.ts'
import SnapshotReader from '../src/snapshot/SnapshotReader.ts'

const store = new SnapshotStore(backupRoot)
await store.init()
const result = await store.commit({
  pathspec,
  message: 'local backup',
  identity: { name: 'user', email: 'user@example.invalid' },
  signal,
})
const reader = new SnapshotReader(backupRoot)
const bytes = await reader.read(result.commit, 'repo:/widget/file.txt')
````

`reader.stream(snapshot, path, writable, signal)` avoids buffering file contents; `read` intentionally returns a complete buffer. Signals are optional. `streamTarget` reads an already resolved target without resolving a moving ref again.

## storage and paths

````text
backup/
  .bakspec
  .bak/
    main.git
    repos/<stable-id>.git
````

Main snapshots contain selected physical/alias paths, canonical `repos/<name>` mounts and `.bak-meta/manifest.json`. Repository mounts and source exposures reference the same captured working state. Compatible object formats use gitlinks; mismatches use typed repository pointers. Readback resolves either form through metadata.

`repos/` and `.bak-meta/` are reserved top-level destinations. Conflicting mappings fail; compatible structural ancestors and identical-content mappings merge. Empty directories, links and hardlink relationships are retained in the graph. They do not depend on source paths at readback time.

Mounts are logical snapshot locations in this slice. No live junction projection or historical filesystem mount is created.

Each independent clone has its own internal ID. Linked worktrees share an object store but keep distinct working snapshots. IDs are separate from friendly names and scan-local device/inode IDs. The published catalog retains identities across temporarily unselected snapshots.

Changing an existing name's source location requires explicit acknowledgement:

````text
repo:/widget = D:/moved/widget
````

````sh
bak --root C:/backup commit --relocate repo:/widget -m "moved widget"
````

Old and new locations cannot both claim that identity. Relocation does not change object format, move files or rewrite earlier snapshots.

## capture

Capture collects graph metadata in memory; file and pack bytes stream. Memory grows with entries and Git object inventories, not file payload size.

Files are opened by resolved source, checked against discovery, streamed raw into Git and checked again. Git filters are not applied. A final discovery pass detects observed changes to selection, entries and worktree registrations. Git administrative state and object inventories are also rechecked.

Repositories retain locally available objects, including alternates and unreachable objects. Only missing destination objects are transferred. Kept packs retain objects not reachable from synthetic working commits. Refs, reflogs, indexes, configuration, hooks and administrative state are stored as data, never activated as backup configuration. Administrative repository boundaries are captured recursively.

Selected administrative-file exclusions apply. Object-storage exclusions that prevent complete preservation fail. Missing required objects fail without fetching; existing shallow boundaries are retained rather than claiming unavailable history. Origins used for runtime grouping are not duplicated into persistent derived metadata.

Working snapshots include dirty, untracked and selected ignored files. Bare/administrative-only selections preserve repository data without inventing a working tree. Administrative snapshots and their object IDs are available through `reader.manifest`; this is not a filesystem restore API.

## publication and failures

1. Load previous published ref/catalog.
2. Resolve selection and validate the complete graph.
3. Capture objects, administrative state and working trees.
4. Recheck sources.
5. Write immutable candidates and retention refs.
6. Compare-and-swap `refs/heads/snapshots` against the original ref.

Only the final main ref publishes a snapshot. A stale writer cannot overwrite a successor. Cancellation stops streams/processes; no automatic retries run. If the publication acknowledgement is lost, read the ref once to distinguish a committed outcome from failure, without retrying the write.

Failed captures can leave unpublished objects/retention refs. No implicit cleanup, eviction or GC runs. Unpushed local storage may grow as needed. Unchanged captured state returns the existing commit.

Backup storage cannot be selected, including through links. Source files, indexes and refs are never written by capture. Reading may have filesystem-managed access-time effects.

## fidelity and security limits

- Not an atomic filesystem snapshot; before/after checks cannot detect every concurrent change.
- Preserves bytes, mode, size, modification/change timestamps, empty directories and recorded link relationships.
- No Windows ACL/alternate-stream or Linux extended-attribute capture.
- No materialisation or destructive restore command. Remote push/clone are described in [remote backups](remote.md).
- Local Git objects are unencrypted; remote copies are encrypted. Selected config/hooks/other files may contain secrets; protect backup storage.
- Windows validated locally; Linux execution remains unverified.

Do not treat this development slice as a full-fidelity replacement for platform backup tooling.

## validation

Run `pnpm test` and `pnpm typecheck`. Tests use owned temporary fixtures only. Coverage includes repository selection, worktree expansion, byte preservation, source-independent readback, administrative exclusions, reflog retention, mixed formats, relocation, cancellation and competing publication.
