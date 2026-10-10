# Tests

TypeScript tests live here rather than inside `packages/`; Swift tests live in
each package's own `Tests/` directory under `swift/Packages/`. Every
Bun test file is named `*.test.ts`.

| Directory | What it holds | Runs with |
|---|---|---|
| `unit/` | Fast tests of one package or module, with subdirectories for `overstoryd/`, `overstoryd-merge/`, and `protocol-updates/` and flat files named by topic | `bun run test:unit` |
| `integration/` | Tests that start a real daemon, host, or merge worker on loopback | `bun run test:integration` |
| `protocol/` | `conformance.ts`, the cross-language gate: it checks the `docs/overstory-spec/conformance/` vectors in TypeScript, spawns the Swift package suites, and runs disposable live daemon and host scenarios | `bun run test:protocol` |
| `performance/` | Benchmarks that are not part of the product suite | `bun run test:performance` |
| `fixtures/` | Reference-implementation fixtures: daemon control responses, the host's exact merge algorithm, and an authored workspace ([README](fixtures/README.md)) | used by the suites above |
| `helpers/` | Shared setup, including `data-home-guard.ts`, which `bunfig.toml` preloads so no test can touch the real `~/.story` | preloaded |

`bun run test` is the maintained product suite: `unit/` and `integration/`
with four parallel workers. `bun run test:affected` runs only the files whose
import closure reaches a changed file, plus the gates the change touches; see
[DEVELOPMENT.md](../DEVELOPMENT.md#verification). Migrations under `packages/overstoryd/migrations/` are excluded from
default discovery and run with `bun run test:migration <dir>`. Postgres
integration is opt-in through `OVERSTORYD_TEST_POSTGRES_DSN`; see
[DEVELOPMENT.md](../DEVELOPMENT.md).

Portable, language-neutral vectors live in [`docs/overstory-spec/conformance/`](../docs/overstory-spec/conformance/README.md),
not here.
