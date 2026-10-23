# bak

Git-native filesystem backup utility, under development. Creates local snapshots of selected files, repositories and linked worktrees. Includes a configurable runner over `node:test`.

## local snapshots

Register this checkout's CLI once with `vp install -g .`. In any backup folder:

````sh
bak init
# edit .bakspec to select source paths
bak commit -m "first backup"
bak log
bak show HEAD repo:/widget/src/index.ts
````

`bak init` creates `.bak` storage and a comment-only `.bakspec` without overwriting an existing spec. Run it once in each backup folder before committing. By default commands use the current folder; `--root C:/backups/personal` selects a different folder. Existing backups using `bak.pathspec` need a one-time manual rename to `.bakspec` before their next commit; the stored history remains in `.bak`. Remote storage can be connected and checked, but snapshots are not pushed or fetched yet.

Commit captures the entire pathspec; there is no staging command. Configure Git `user.name`/`user.email`, or pass `--author "Name <email>"`. `show <snapshot>` lists the snapshot root; supplying a file path streams its bytes.

Snapshots retain their objects locally without automatic eviction. No push/fetch, restore command, live projection or mounted historical view exists yet. Remote objects are encrypted, but local Git objects in `.bak` are not. Protect the backup directory appropriately.

See [snapshot contracts and limits](docs/snapshots.md) before relying on this development version. Source-change checks are not an atomic filesystem snapshot, and platform metadata coverage is limited.

## remote storage

Remote storage uses Backblaze B2, the only supported backend. B2 application keys are shared: copy `.env.example` to `.env` in this bak checkout, next to `package.json`. Values may reference Workbench's secret store, configured for this checkout folder (settings > projects & folders > environment > store); without Workbench, `.env` loads like plain dotenv. Existing environment variables win over `.env`.

````dotenv
B2_APPLICATION_KEY_ID=${wb:B2_APPLICATION_KEY_ID}
B2_APPLICATION_KEY=${wb:B2_APPLICATION_KEY}
BAK_ENCRYPTION_PASSPHRASE=${wb:BAK_ENCRYPTION_PASSPHRASE}
````

Everything sent to B2 is encrypted client-side; there is no plaintext remote mode. The passphrase derives the key with scrypt using a fixed salt, so every machine can derive it from the passphrase alone. Use at least 16 characters, ideally 5+ random words or a password-manager string. **Losing the passphrase makes remote backups unreadable.**

Each backup folder chooses its destination in `.bakspec`. A prefix lets several folders share one bucket and one bucket-restricted key. See [settings](docs/pathspec.md#settings).

````text
@remote = b2://my-bak-bucket/personal
````

A folder can override any checkout `.env` value, for example to use a more specific key. References resolve from the checkout's store. Ambient environment variables win over `@env`, which wins over `.env`.

````text
@env.B2_APPLICATION_KEY_ID = ${wb:B2_APPLICATION_KEY_ID_1}
@env.B2_APPLICATION_KEY = ${wb:B2_APPLICATION_KEY_1}
````

````sh
bak remote check
````

`remote check` writes, reads, range-reads and deletes one encrypted `bak-probe/<uuid>` object, and prints the passphrase's key id. The key needs list buckets, read, write and delete file capabilities. Credentials load only for `remote` commands and never enter `process.env`, so Git subprocesses do not inherit them. Store lookups run from the checkout folder regardless of `--root` or the current directory.

`ObjectStore` is the storage boundary; `B2ObjectStore` implements it over the B2 native API. Objects are immutable: repeating identical bytes is a no-op, different bytes under an existing key reject. Uploads are single requests (B2 limit 5 GB). Conditional writes for ref publication are not implemented.

`EncryptedObjectStore` wraps the backend. Each object stores a 53-byte header (magic, format version, key id, salt, plaintext size) followed by AES-256-GCM chunks of 64 KiB, so ranged reads fetch only the header and covering chunks. Every chunk authenticates the header and object name; tampering, truncation, renamed objects and a different passphrase are rejected. The per-object salt is derived from the name and contents, so re-uploading identical bytes stays a no-op. Object names remain plaintext.

## development

Requires Node.js 22.22.1+ and pnpm 11.22.0. `vp` pins development to Node.js 26.9.0 and pnpm 11.22.0.

````sh
pnpm install
pnpm test
pnpm typecheck
````

Dependency build scripts for esbuild are disabled. tsx uses the installed platform binary. `@inthedark/wb` is excluded from pnpm's minimum release age.

Tests execute through `node:test`. The project-owned runner controls discovery, configuration, reporting and exit status, not test execution.

Edit [test.config.ts](test.config.ts) to configure discovery roots, file concurrency, verbose output and the test-name substring filter. Defaults run files sequentially with compact output.

````sh
pnpm test src/config/PathspecEvaluator.test.ts
pnpm test --filter "later inclusion"
pnpm test scripts --verbose
````

Positional files/directories replace configured roots. Paths resolve relative to the project root. Discovery selects `.test.ts` files recursively, does not follow symlinks, deduplicates paths and sorts them. Explicit missing paths fail.

`--filter` overrides the configured filter with a literal, case-sensitive test-name substring. `--verbose` enables passing-test names. Node's suite-name filtering semantics apply. No watch mode starts implicitly.

Compact output reports one totals line, with failing-test errors and locations. Test stdout/stderr and explicit diagnostics remain visible. Counts exclude synthetic passes for empty files. Skipped and TODO tests are reported separately. Failed file processes remain failures even when they cannot produce a test summary.

No test files, no executed tests (including all skipped/TODO or unmatched filters), test failures and runner/load errors produce exit code 1. A successful executed suite produces exit code 0.

Tests create isolated fixtures under the gitignored `.tmp/fixtures` and remove only their own fixtures. Git fixture commands cannot discover this checkout's repository. Scanner fixtures include Git repositories, commits, linked worktrees, junctions and hardlinks. Tests require system Git. Tests and typechecking emit no build output.

## path selection

See [pathspec syntax and semantics](docs/pathspec.md). The default-exported `PathspecEvaluator` compiles rules once, owns shared source selection and exposes destination and scan-root queries without filesystem access.

````ts
import PathspecEvaluator from './src/config/PathspecEvaluator.ts'

const evaluator = new PathspecEvaluator(text)
const roots = evaluator.getScanRoots()
const destinations = evaluator.evaluate('C:/data/file.txt')
````

## scanning

````ts
import Scanner from './src/filesystem/Scanner.ts'

const scanner = new Scanner(evaluator)
for await (const record of scanner.scan()) {
  // Consume root exposures, shared entries, links, repositories and problems.
  // Only a final complete completion record authorises using the whole scan.
}
````

`PathspecEvaluator` owns selection, `scanning-utils.ts` owns filesystem inspection, `GitProcess` owns subprocess mechanics, and `Scanner` owns traversal, sharing and repository discovery. See [scanner contracts](docs/scanning.md) for stream collection, link policy and failure handling.

A complete scan is not a captured snapshot. `SnapshotStore` gates publication on file/repository capture and final verification. Wildcard pathspec syntax and snapshot push/fetch remain unimplemented.
