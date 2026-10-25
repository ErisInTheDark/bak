# snapshots

`SnapshotStore` owns capture and publication. `ContentStaging` moves one capture's contents into remote content packs. `SnapshotReader` lists/reads stored snapshots without accessing sources. Core data is plain interfaces/objects; classes coordinate operations.

````ts
import RemotePacks from '../src/remote/RemotePacks.ts'
import SnapshotStore from '../src/snapshot/SnapshotStore.ts'
import SnapshotReader from '../src/snapshot/SnapshotReader.ts'

const content = new RemotePacks(backupRoot, encryptedObjectStore, 'b2://bucket/prefix')
const store = new SnapshotStore(backupRoot)
await store.init()
const result = await store.commit({
  pathspec,
  message: 'nightly',
  identity: { name: 'user', email: 'user@example.invalid' },
  content,
  signal,
})
const reader = new SnapshotReader(backupRoot, content)
const bytes = await reader.read(result.commit, 'repo:/widget/file.txt')
````

Manifests read offline. File contents need the reader's `RemotePacks`; remote objects are fetched whole, then written. Signals are optional. `streamTarget` reads an already resolved target without resolving a moving ref again.

## storage and paths

````text
backup/
  .bakspec
  .bak/
    main.git
    repos/<stable-id>.git
````

Local stores hold only bak's own objects: trees, commits, manifests and repository records (format version 2). Captured file contents, repository administrative files and repository objects live only in remote content packs (see [remote backups](remote.md)); trees reference them without local copies. Storage from the earlier local-contents format is refused; initialise a new folder.

Main snapshots contain selected physical/alias paths, canonical `repos/<name>` mounts, `.bak-meta/manifest.json` and `.bak-meta/packs.json`. Repository mounts and source exposures reference the same captured working state. Compatible object formats use gitlinks; mismatches use typed repository pointers. Readback resolves either form through metadata.

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

Files are opened by resolved source, checked against discovery, streamed raw into a staging repository and checked again; staged contents upload in bounded packs. Git filters are not applied. A final discovery pass detects observed changes to selection, entries and worktree registrations. Git administrative state and object inventories are also rechecked.

Repositories retain locally available objects, including alternates and unreachable objects. Objects not already in the remote are packed from the source and uploaded; nothing is copied into local storage. Working commits name the source `HEAD` as parent, which lives remotely. Refs, reflogs, indexes, configuration, hooks and administrative state are stored as data, never activated as backup configuration. Administrative repository boundaries are captured recursively.

Selected administrative-file exclusions apply. Object-storage exclusions that prevent complete preservation fail. Missing required objects fail without fetching; existing shallow boundaries are retained rather than claiming unavailable history. Origins used for runtime grouping are not duplicated into persistent derived metadata.

Working snapshots include dirty, untracked and selected ignored files. Bare/administrative-only selections preserve repository data without inventing a working tree. Administrative snapshots and their object IDs are available through `reader.manifest`; this is not a filesystem restore API.

## publication and failures

1. Load previous published ref/catalog/pack list.
2. Resolve selection and validate the complete graph.
3. Capture objects, administrative state and working trees, uploading contents.
4. Recheck sources.
5. Upload remaining staged contents and require every captured object to be remote.
6. Write immutable candidates and retention refs.
7. Compare-and-swap `refs/heads/snapshots` against the original ref.

Only the final main ref publishes a snapshot. A stale writer cannot overwrite a successor. Cancellation stops streams/processes; no automatic retries run. If the publication acknowledgement is lost, read the ref once to distinguish a committed outcome from failure, without retrying the write.

Failed captures can leave unpublished local records/retention refs and unreferenced remote packs, which the rerun reuses. No implicit cleanup or GC runs. Staging is deleted after every capture. Unchanged captured state returns the existing commit.

Backup storage cannot be selected, including through links. Source files, indexes and refs are never written by capture. Reading may have filesystem-managed access-time effects.

## fidelity and security limits

- Not an atomic filesystem snapshot; before/after checks cannot detect every concurrent change.
- Preserves bytes, mode, size, modification/change timestamps, empty directories and recorded link relationships.
- No Windows ACL/alternate-stream or Linux extended-attribute capture.
- No materialisation or destructive restore command. Remote storage, push, clone and fsck are described in [remote backups](remote.md).
- Local records (paths, metadata, manifests) are unencrypted; all remote objects are encrypted. Protect backup storage.
- Windows validated locally; Linux execution remains unverified.

Do not treat this development slice as a full-fidelity replacement for platform backup tooling.

## validation

Run `pnpm test` and `pnpm typecheck`. Tests use owned temporary fixtures and in-memory remotes only. Coverage includes repository selection, worktree expansion, byte preservation, source-independent readback, contents absent from local storage, bounded staging, administrative exclusions, reflog retention, mixed formats, relocation, cancellation and competing publication.
