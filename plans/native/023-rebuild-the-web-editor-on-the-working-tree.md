# Plan 023: Rebuild the web editor on the working tree

> **Executor instructions**: Give TypeScript the same two halves Swift has, `@arbor/working-tree` and `@arbor/object-store`, browser-safe and passing the same conformance fixture, and rebuild Arbor web on them so the browser is a direct Canopy client exactly like the Mac app. The daemon's editor path is already gone (Native 022 Phase 7); do not bring any of it back. Start only after the Native 022 soak on the Mac.
>
> **Drift check**: `git diff --stat c134a85..HEAD -- packages/canopy-client packages/wire packages/wire-projection packages/render packages/arborsync-client packages/arborsync packages/core conformance tests`

## Status

- **Priority**: P1 — restores the web editor
- **Effort**: L
- **Risk**: MEDIUM
- **Depends on**: Native 022 (implemented; soak pending)
- **Category**: parity/architecture
- **Planned at**: Arbor `c134a85`, 2026-09-09

## Why this matters

Native 022 deleted the daemon's node, mutation, and admission routes, so Arbor web currently serves a placeholder page. The editor's coordinator was already transport-agnostic; what the browser lacks is an in-memory tree, an object store, and a runner for the update machine. Building those as the TypeScript twins of `ArborWorkingTree` and `ArborObjectStore` gives one client shape in both languages and one conformance fixture that pins both.

## Design

- **`@arbor/object-store`** (depends only on `@arbor/wire`): `ObjectStore { bytes(hash) }`, `ObjectOverlay`, `LayeredObjectStore`, `DaemonObjectStore` over `/v1/objects`, `CanopyObjectStore` over the Wire object route, `MemoryOverlay.retain(roots)`.
- **`@arbor/working-tree`** (browser-safe, no `node:` imports): a state of `{ tree, root, accepted?, generation, pending?, index: byPath {hash, kind, size, pageID?, mtime?}, byPageID }` built from the bootstrap spine plus Markdown sources, bytes only in the overlay or object store; content-addressed writes that rewrite the spine to a new root; `WireProjection` for node semantics so both cores agree on wire bytes by construction; a `WorkingTreeStateStore` port with memory and IndexedDB implementations; `UpdateMachine` (moved from `@arbor/canopy-client`, re-exported for the daemon) and `UpdateCoordinator` mirroring the Swift one: durable attempt and head, `adoptInFlight`, `syncImmediately`, `syncOnce`, `observe`, `recoverWatchGap`, minimal conflict handling.
- **`@arbor/canopy-client`** keeps the wire transport and account helpers; the node-bound parts (`sync-state.ts`, `tree-sync.ts`, `account-*.ts`) move behind a `./node` subpath export.
- **`WireClient`** takes a token or an async token provider and an `onUnauthorized` hook. **`WireProjection`** takes an injectable collection-file decoder and drops `@arbor/stores`. **`CanopyWatchRunner`** over `WireClient.watch`. A client text index for search and backlinks. One writable working tree per tree per browser profile via `navigator.locks`; other tabs read-only.
- **Arbor web** (`packages/render`): `makeApi(tree)` backed by a `WorkingTreeSession` (node, children, search, backlinks, write, mutate, asset, import, session-local trash; node views fed by the working-tree change stream); the admission machine runs with its one transport against the session. Home lists placed trees from `/v1/trees` and accounts from `/v1/accounts`, plus app-side visits; a URL inside a placed tree's OS path opens that tree's session; remote locators open read-only sessions through an anonymous or same-origin-credentialed Wire client. Editor asset sources are rewritten to `/v1/objects/{hash}?tree=`. Configuration edits operate on the configuration tree's own working-tree session. The daemon mounts the render bundle again and `arbor open` drops its notice.

## Steps

1. `@arbor/object-store` with layered lookup, hash verification, and retention tests.
2. `@arbor/working-tree` state and writes; assert a write's root equals `snapshotDirectory` of the same files; envelopes ⊆ overlay.
3. State-store contract tests (memory and `fake-indexeddb`).
4. Move `UpdateMachine` and add `UpdateCoordinator`; mirror the Swift `UpdateCoordinatorTests` scenario names in `tests/unit/working-tree/update-coordinator.test.ts`; two TypeScript working trees converge through `serveCanopy`.
5. `WireClient` token provider, `WireProjection` decoder injection, `CanopyWatchRunner`, text index.
6. Arbor web onto the session; `tests/e2e/server.ts` runs `serveCanopy` plus a control daemon with a placed fixture; a browser end-to-end suite asserts on the folder on disk and Canopy descriptors rather than daemon routes.
7. Re-mount the bundle; restore `build:web` and `test:e2e`; update `docs/arborsync-api.md`, `docs/client.md`, `docs/reference-implementation.md`, `status.md`.

## Verification

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
bun run test:e2e
git diff --check
```

End-to-end with a local Canopy, `arborsync --control`, and one placed tree: edit a page in the browser and see the folder update within a second; edit on disk and see the page update; close the tab mid-edit and reopen to see the head or attempt replay once; a second tab opens read-only.

## Done criteria

- Arbor web edits through its own `UpdateCoordinator` against Canopy and never calls a daemon editor route.
- `@arbor/working-tree` and `ArborWorkingTree` pass the same `conformance/client-state-machines.json`.
- Known gaps recorded in `status.md`: collection-file rows in the browser (Smaller project 003) and accepted history (Smaller project 007).
