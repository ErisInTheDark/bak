# remote backups

The remote is the backup's object storage. `bak commit` uploads captured file contents and repository objects as encrypted content packs; the backup folder keeps only bak's own trees, commits and records. `bak push` publishes them. All remote bytes pass through `EncryptedObjectStore`; see the README for credentials and the passphrase.

````sh
bak commit -m "nightly"
bak push
bak fsck
bak --root C:/restore-drill clone b2://my-bak-bucket/personal
bak --root C:/restore-drill show HEAD repo:/widget/package.json
````

## layout

Keys sit under the `@remote` prefix. Names are plaintext; contents are encrypted.

````text
HEAD                                       current state key; the only mutable object
states/<sha256>.json                       immutable state, named by its contents
stores/<store>/content/pack-<hash>.pack    captured contents, uploaded by commit
stores/<store>/content/pack-<hash>.idx
stores/<store>/metadata/pack-<hash>.pack   bak trees, commits and records, uploaded by push
stores/<store>/metadata/pack-<hash>.idx
````

`<store>` is `main` or a repository store id from `.bak/repos/<id>.git`. A state (version 2) records the snapshot commit, the previous state key, and per store its object format, metadata packs and refs. Each snapshot commit lists its remote and every content pack it and its history need in `.bak-meta/packs.json`, so the content pack list survives a deleted cache.

## commit

1. Load the previous snapshot's `packs.json`. A different `@remote` rejects; history cannot span remotes.
2. Per store, collect the object ids covered by those packs plus packs this folder uploaded during an interrupted commit that still exist remotely.
3. Files stream into a throwaway staging repository in `.bak/staging/<transaction>/`. Every 128 MiB of uncovered content is packed, uploaded and wiped. Repository objects are packed straight from the source repository in batches of about 128 MiB.
4. Every captured object must be covered before the snapshot commit is written with its new `packs.json`.

Local disk use stays near one pack. A failed commit leaves uploaded packs remotely; the rerun reuses them. New repository identities derive from their location so reruns find their packs.

## push

1. Read the published state. Its snapshot must exist locally and be an ancestor of `refs/heads/snapshots`; otherwise push rejects rather than hiding remote history.
2. Content packs added since the published snapshot must exist remotely.
3. Every local object not in published or previously uploaded metadata packs is packed and uploaded.
4. Write the new state, re-read `HEAD`, and abort if another writer changed it. Replace `HEAD` last.

A failure before step 4 completes leaves the previous remote snapshot fully usable. Reruns reuse uploaded packs. An unchanged push publishes nothing.

## uploads

Before sending, `EncryptedObjectStore` decrypts its own output and compares it to the plaintext, and every pack index must list every requested object. B2 hashes each upload server-side; `B2ObjectStore` requires the upload receipt's SHA-1 and length to match what was sent. `B2ObjectStore` alone retries: network failures and `408`/`429`/`5xx` back off (B2's `Retry-After`, else full-jitter exponential up to 30 s) for up to 6 attempts, with a fresh upload URL after each failed upload. Other `4xx` responses fail at once.

## reads and recovery

Pack indexes are cached in `.bak/cache/remote/<url hash>/`. The cache is disposable; missing indexes are downloaded again.

`show` reads one object with byte-range requests: the entry is located through the pack index, inflated, delta chains inside the pack are resolved, and the result must hash to the requested id. Each delta base costs another range request.

`clone [url]` targets `--root` (default: current folder), which must not contain `.bak`. Without a url it uses the folder's `.bakspec` `@remote`; an existing `.bakspec` also supplies `@env` overrides. Clone downloads the metadata packs (`git index-pack` verifies every object), recreates refs, downloads content pack indexes, and checks every object the latest manifest references is local or in a content pack. Without an existing `.bakspec`, it writes the snapshot's pathspec. A failed clone leaves a partial folder; delete it and retry.

`fsck` proves the published snapshot recoverable from the remote alone. It restores metadata into a scratch folder under `.bak/cache/`, checks manifest coverage, then downloads every content pack one at a time; `git index-pack` verifies every object and the rebuilt index must match the remote index. Run it after the first backup and periodically.

## limits

- One writer per remote prefix. B2 has no compare-and-swap; the `HEAD` re-read narrows but does not close races. Use separate prefixes for separate folders or machines.
- Commit, push, show, clone and fsck need the remote; log and manifest reads do not.
- Packs and single remote objects are encrypted and read whole in memory; a single file larger than about 1 GiB is slow, and B2 limits single uploads to 5 GB.
- Deltas only form within one upload batch. No remote garbage collection or repacking: failed commits and pushes leave unreferenced packs, and B2 keeps old `HEAD` versions.
- No filesystem restore, mount or bounded object cache yet.
