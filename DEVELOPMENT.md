# Developing Arbor

This document describes how to work on the reference implementation. It is not a contribution or licensing policy.

## Requirements and setup

The TypeScript workspace uses Bun 1.3.14. Browser tests use Playwright Chromium, and the cross-language client tests require Swift 6 on macOS.

```sh
bun install
bunx playwright install chromium
bun run build:web
```

`bun install` exposes checkout-local scripts as `bun run arbor`, `bun run arborsync`, and `bun run canopyd`. `bun link` additionally exposes the `arbor`, `arborsync`, and `canopyd` binaries in the shell; the README quickstart uses that form.

## Repository map

- `packages/` — the TypeScript logical model, providers, stores, Wire implementation, Canopy, Arbor Sync, CLI, editor, renderer, and data runtime.
- `native/` — the Swift clients, synchronization packages, and native Arbor application.
- `spec.md` and `spec/` — portable normative contracts and conformance vocabulary.
- `conformance/` — language-neutral protocol fixtures.
- `tests/` — Bun unit, integration, protocol, performance, and browser tests.
- `examples/supplies/` — the executable-document reference corpus and private SQLite fixture.
- `docs/` — usage and reference-implementation documentation.
- `plans/` — remaining work and completed implementation evidence.
- `deploy/` and `migrations/` — current operator procedures and temporary cutover tooling.

Package boundaries and runtime ownership are described in [the reference implementation](docs/reference-implementation.md). Documentation ownership is summarized in [docs/README.md](docs/README.md).

## Verification

Run the maintained automated gates from the repository root:

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
bun run test:e2e
bun run test:performance
swift test --package-path native/Packages/ArborClient
git diff --check
```

`bun run test` is the maintained parallel product suite and deliberately scopes
itself to `tests/unit` and `tests/integration`. Bare `bun test` uses the same
product boundary: `bunfig.toml` excludes all migration tests from default
discovery. Run the migration-specific suite during its rehearsal with
`bun run test:migration migrations/NNN-<name>` as described in
[the migration procedure](migrations/README.md).

`bun run test:protocol` checks the language-neutral fixtures, reference REST
fixtures, and disposable live Arbor Sync/Canopy behavior against the Swift
clients. Standalone `swift test` checks decoding; live-server cases skip when
their test URLs are absent. Postgres integration is opt-in:

```sh
ARBOR_TEST_POSTGRES_DSN='postgresql://user:password@127.0.0.1:5432/postgres' \
  bun test tests/integration/postgres.test.ts
```

The Postgres test creates and drops a uniquely named `arbor_test_*` schema. It does not use an existing application schema.

## Disposable browser smoke test

Use fresh directories rather than the checked-in fixture or your real Arbor data home:

```sh
test_root="$(mktemp -d)"
test_state="$(mktemp -d)"
cp -R tests/fixtures/workspace/. "$test_root/"
ARBOR_DATA_HOME="$test_state" bun run arborsync "$test_root" --port 4317
```

Open `http://127.0.0.1:4317`. Check local navigation, extensionless Markdown URLs, child-link ordering, properties, exact-source edits, undo/redo, external file reconciliation, responsive navigation, recovery, and read-only collection rows. For remote presentation, open a public canonical URL through `arbor open` and directly in a regular browser; HTML and `Accept: text/markdown` should describe the same complete operational document without exposing private representation files.

For an objective browser layout report, evaluate [`tools/browser/editor-audit.js`](tools/browser/editor-audit.js) in the built-in browser as `(${source})()`. In writable contexts it also installs `window.__arborEditorAudit` with report, overlay, theme, and cleanup helpers.
