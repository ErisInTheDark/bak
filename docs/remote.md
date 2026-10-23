# remote backups

`SnapshotRemote` publishes a backup folder's complete `.bak` storage to its `@remote` and recovers it. All remote bytes pass through `EncryptedObjectStore`; see the README for credentials and the passphrase.

````sh
bak push
bak --root C:/restore-drill clone b2://my-bak-bucket/personal
bak --root C:/restore-drill log
````

## layout

Keys sit under the `@remote` prefix. Names are plaintext; contents are encrypted.

````text
HEAD                                   current state key; the only mutable object
states/<sha256>.json                   immutable state, named by its contents
stores/<store>/packs/pack-<hash>.pack  immutable Git pack
stores/<store>/packs/pack-<hash>.idx   its Git pack index
````

`<store>` is `main` or a repository store id from `.bak/repos/<id>.git`. A state records the snapshot commit, the previous state key, and per store its object format, complete pack list and refs. Recovery needs only `HEAD`, one state and its packs.

## push

1. Read the published state. Its snapshot must exist locally and be an ancestor of `refs/heads/snapshots`; otherwise push rejects rather than hiding remote history.
2. List every object in every local store, including objects no ref reaches. Objects in published packs, or in packs this folder already uploaded during an interrupted push, are skipped.
3. Pack missing objects with `git pack-objects --max-pack-size=128m`, upload each pack and index immutably, and check their stored sizes.
4. Write the new state, re-read `HEAD`, and abort if another writer changed it. Replace `HEAD` last.

A failure before step 4 completes leaves the previous remote snapshot fully usable. Reruns reuse uploaded packs. An unchanged push publishes nothing.

Pack indexes are cached in `.bak/cache/remote/<url hash>/`. The cache is disposable; missing indexes are downloaded again.

## clone

`clone [url]` targets `--root` (default: current folder), which must not contain `.bak`. Without a url it uses the folder's `.bakspec` `@remote`; an existing `.bakspec` also supplies `@env` overrides.

Clone downloads every pack of the published state. `git index-pack` rebuilds each index locally and verifies every object hash; remote indexes are never trusted. It then recreates recorded refs, runs `git fsck --connectivity-only` per store, and checks every object the latest manifest references. Without an existing `.bakspec`, it writes the snapshot's pathspec. A failed clone leaves a partial folder; delete it and retry.

## limits

- One writer per remote prefix. B2 has no compare-and-swap; the `HEAD` re-read narrows but does not close races. Use separate prefixes for separate folders or machines.
- Packs are encrypted in memory, up to 128 MiB each; a single larger object makes a larger pack.
- No remote garbage collection. Interrupted pushes can leave unreferenced packs, and B2 keeps old `HEAD` versions.
- Clone downloads everything. No lazy reads, fetch into an existing folder, or filesystem restore yet.
