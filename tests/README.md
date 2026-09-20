# Tests

TypeScript tests live here rather than inside `packages/`; Swift tests live in
each package's own `Tests/` directory under `canopy-swift/Packages/`. Every
Bun test file is named `*.test.ts`.

| Directory | What it holds | Runs with |
|---|---|---|
| `unit/` | Fast tests of one package or module, with subdirectories for `canopyd/`, `canopyd-merge/`, and `protocol-updates/` and flat files named by topic | `bun run test:unit` |
| `integration/` | Tests that start a real daemon, host, or merge worker on loopback | `bun run test:integration` |
| `protocol/` | `conformance.ts`, the cross-language gate: it checks the `conformance/` vectors in TypeScript, spawns the Swift package suites, and runs disposable live daemon and host scenarios | `bun run test:protocol` |
| `performance/` | Benchmarks that are not part of the product suite | `bun run test:performance` |
| `fixtures/` | Reference-implementation fixtures: daemon control responses, the host's exact merge algorithm, and an authored workspace ([README](fixtures/README.md)) | used by the suites above |
| `helpers/` | Shared setup, including `data-home-guard.ts`, which `bunfig.toml` preloads so no test can touch the real `~/.arbor` | preloaded |

`bun run test` is the maintained product suite: `unit/` and `integration/`
with four parallel workers. Migrations under `migrations/` are excluded from
default discovery and run with `bun run test:migration <dir>`. Postgres
integration is opt-in through `ARBOR_TEST_POSTGRES_DSN`; see
[DEVELOPMENT.md](../DEVELOPMENT.md).

Portable, language-neutral vectors live in [`conformance/`](../conformance/README.md),
not here.
