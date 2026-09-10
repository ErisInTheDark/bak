# bak

Git-native filesystem backup utility, under development. This first slice implements literal pathspec selection and a configurable test runner. No backup, push, restore or mount commands exist yet.

## development

Requires Node.js 22.22.1+ and pnpm 11.22.0.

````sh
pnpm install
pnpm test
pnpm typecheck
````

Dependency build scripts for esbuild are disabled. tsx uses the installed platform binary.

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

Runner regression tests create isolated fixtures under the OS temporary directory and remove only their own fixtures. Tests and typechecking otherwise emit no build output.

## path selection

See [pathspec syntax and semantics](docs/pathspec.md). The default-exported `PathspecEvaluator` compiles rules once, owns shared source selection and exposes destination and scan-root queries without filesystem access.

````ts
import PathspecEvaluator from './src/config/PathspecEvaluator.ts'

const evaluator = new PathspecEvaluator(text)
const roots = evaluator.getScanRoots()
const destinations = evaluator.evaluate('C:/data/file.txt')
````

Future slices must settle scanning, final backup-tree path encoding/collisions, wildcard semantics, git capture, repository preservation and remote storage before exposing backup commands.

Planned ownership: `scanning-utils.ts` handles filesystem mechanics; `Scanner.ts` handles traversal and repository detection. Scan results stream entries, repository records and problems with an explicit completion outcome; consumers can collect them. Commit must remain unavailable until the entire selected snapshot can be produced, including successful capture after scanning.
