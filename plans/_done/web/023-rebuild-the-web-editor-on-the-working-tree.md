> **Superseded 2026-09-19** by [Web 025](../../web/025-arbor-web.md) and its [surface inventory](../../web/surfaces.md). Kept as the historical record; do not execute from this file.

# Rebuild the web editor on the working tree

Historical identifier: **Native 023**. The filename number is preserved; this plan now belongs to web.

> **Executor instructions**: Give TypeScript the same two halves Swift has, `@arbor/working-tree` and `@arbor/object-store`, browser-safe and passing the same conformance fixture, and rebuild Arbor web on them so the browser is a direct Canopy client exactly like the Mac app. Bootstrap only from the accepted Canopy root; never import or wait on the daemon's mutable head, pending request, conflict, or availability state. The daemon's editor path is already gone (Native 022 Phase 7); do not bring any of it back. Start only after the Native 022 soak on the Mac.
>
> **Drift check**: `git diff --stat c134a85..HEAD -- packages/canopy-client packages/wire packages/wire-projection packages/render packages/arborsync-client packages/arborsync packages/core conformance tests`

## Status

- **Priority**: P1 — restores the web editor
- **Effort**: L
- **Risk**: MEDIUM
- **Depends on**: historical Native 022 (implemented and live);
  [soak closeout](../verification/release-and-soak.md#observation-and-soak-closeout) remains pending
- **Category**: parity/architecture
- **Planned at**: Arbor `c134a85`, 2026-09-09
- **Endpoint-removal scope refreshed at**: Arbor `2d04384`, 2026-09-13. Run `git diff --stat 2d04384..HEAD -- packages/arborsync packages/arborsync-client packages/cli packages/render native/Packages/ArborSyncClient tests docs conformance` before executing the removal steps below. This refresh does not certify the older working-tree design against every intervening Wire change.

## Why this matters

Native 022 deleted the daemon's node, mutation, and admission routes, so Arbor web currently serves a placeholder page. The editor's coordinator was already transport-agnostic; what the browser lacks is an in-memory tree, an object store, and a runner for the update machine. Building those as the TypeScript twins of `ArborWorkingTree` and `ArborObjectStore` gives one client shape in both languages and one conformance fixture that pins both.

## Design

- **`@arbor/object-store`** (depends only on `@arbor/wire`): `ObjectStore { bytes(hash) }`, `ObjectOverlay`, `LayeredObjectStore`, `DaemonObjectStore` over `/v1/objects`, `CanopyObjectStore` over the Wire object route, `MemoryOverlay.retain(roots)`.
- **`@arbor/working-tree`** (browser-safe, no `node:` imports): a state of `{ tree, root, accepted?, generation, pending?, index: byPath {hash, kind, size, pageID?, mtime?}, byPageID }` built from the accepted-root bootstrap spine plus Markdown sources, bytes only in the overlay or object store; content-addressed writes that rewrite the spine to a new root; `WireProjection` for node semantics so both cores agree on wire bytes by construction; a `WorkingTreeStateStore` port with memory and IndexedDB implementations; `UpdateMachine` (moved from `@arbor/canopy-client`, re-exported for the daemon) and `UpdateCoordinator` mirroring the Swift one: client-owned durable attempt and head, `syncImmediately`, `syncOnce`, `observe`, `recoverWatchGap`, minimal conflict handling.
- **`@arbor/canopy-client`** keeps the wire transport and account helpers; the node-bound parts (`sync-state.ts`, `tree-sync.ts`, `account-*.ts`) move behind a `./node` subpath export.
- **`WireClient`** takes a token or an async token provider and an `onUnauthorized` hook. **`WireProjection`** takes an injectable collection-file decoder and drops `@arbor/stores`. **`CanopyWatchRunner`** over `WireClient.watch`. A client text index for search and backlinks. One writable working tree per tree per browser profile via `navigator.locks`; other tabs read-only.
- **Arbor web** (`packages/render`): `makeApi(tree)` backed by a `WorkingTreeSession` (node, children, search, backlinks, write, mutate, asset, import, session-local trash; node views fed by the working-tree change stream); the admission machine runs with its one transport against the session. Home may discover placements through `/v1/trees`, but opening uses `/v1/bootstrap` and only its accepted state plus placement/routing metadata; tree-list sync status never seeds or gates the browser working tree. Accounts come through `/v1/accounts`; app-side visits remain. A URL inside a placed tree's OS path opens that tree's session; remote locators open read-only sessions through an anonymous or same-origin-credentialed Wire client. Editor asset sources are rewritten to `/v1/objects/{hash}?tree=`. Configuration edits operate on the configuration tree's own working-tree session. The extracted browser handler mounts the render bundle and `arbor open` drops its notice. The sync object endpoint remains available.

## Steps

1. `@arbor/object-store` with layered lookup, hash verification, and retention tests.
2. `@arbor/working-tree` state and writes; assert a write's root equals `snapshotDirectory` of the same files; envelopes ⊆ overlay.
3. State-store contract tests (memory and `fake-indexeddb`).
4. Move `UpdateMachine` and add `UpdateCoordinator`; mirror the Swift `UpdateCoordinatorTests` scenario names in `tests/unit/working-tree/update-coordinator.test.ts`; two independent TypeScript working trees converge through `serveCanopy`, including while the daemon has unrelated pending work or a conflict.
5. `WireClient` token provider, `WireProjection` decoder injection, `CanopyWatchRunner`, text index.
6. Arbor web onto the session through the extracted browser handler; `tests/e2e/server.ts` runs `serveCanopy` plus a control daemon with a placed fixture; a browser end-to-end suite asserts on the folder on disk and Canopy descriptors rather than daemon routes.
7. Complete the endpoint removal and caller migration below before re-mounting the bundle. Restore `build:web` and `test:e2e`; update `docs/arborsync-api.md`, `docs/client.md`, `docs/reference-implementation.md`, `status.md`.

## Endpoint removal folded into Plan B

These are accepted scope decisions, not optional cleanup candidates. Remove callers and routes together; do not create compatibility aliases or replacement loopback endpoints for the removed operations. Keep [Smaller project 010](../_done/smaller-projects/010-trim-arborsync-routes.md) unchanged as historical evidence.

| Surface | Plan B decision |
|---|---|
| `POST /v1/me` | Remove browser identity creation and the endpoint. Identity creation remains native/CLI setup; `arbor me create` already uses `ProfileIdentityStore` directly. |
| `POST /v1/local/forget` | Remove the browser installation-disconnect action and the endpoint. Do not replace it with a browser-side destructive file edit. |
| `GET /v1/resolve` | Move the remaining CLI callers to shared library/direct Wire resolution and the browser to its working-tree/placement locator logic; delete the endpoint. |
| Filesystem-path byte serving | Remove arbitrary-path byte responses, `?raw`, `/render` file aliases, and Referer-based asset scoping after switching browser assets to the object store. Keep `/render/<path>` only as app navigation, not a file-reading API. Built application assets still need explicit static serving. |
| `POST /v1/bootstrap/accounts` | **Keep.** The browser can claim an account using an existing local profile identity; do not delete account claiming along with identity creation. |
| Bootstrap, credentials, objects, sync, placement movement, conflict review, account/tree reads, pairing, events | Keep their existing contracts unless another explicitly approved change requires otherwise. |

### Current ownership and migration steps

1. **Migrate setup UI before deleting account routes.** `packages/render/src/App.tsx` currently calls `createProfileIdentity`, `claimAccount`, and `forgetLocalAccount`. Remove identity creation and installation-disconnect controls, but retain `claimAccount` and the safe identity read in `GET /v1/accounts`. When identity is absent, explain that it must be created using native/CLI setup before claiming. In `packages/arborsync/src/account-http.ts` delete only the `/v1/me` and `/v1/local/forget` branches. Remove their now-unused `LocalAccountService` methods in `account-service.ts` and TypeScript/Swift REST wrappers. Preserve shared `ProfileIdentityStore` and account-bootstrap libraries: removal of their HTTP callers does not authorize deleting native/CLI functionality.
   **Verify:** `bun run typecheck` and `bun test tests/unit/local-handlers.test.ts tests/integration/server.test.ts` must pass with new negative route assertions; the restored browser end-to-end suite must retain successful account claiming with an existing identity.
2. **Replace locator callers without narrowing semantics.** `packages/cli/src/index.ts` still calls REST `resolve` in audience resolution and `statusCommand`; the old React remote-view flow also calls it. Native remote resolution already uses `ArborWireClient` directly. Extract shared Node-side resolution only where the CLI needs it; use existing stores/account selection and `WireClient` for remote locators. `ArborSyncDaemon.resolveLocator` in `packages/arborsync/src/service.ts` and `LocalFileService.resolveScope` in `local-files.ts` are the current behavior references. Preserve TreeID, normalized logical path, realpath/symlink handling, nested tree/mount boundaries, account-specific credentials, and errors for unknown or ambiguous owners. Browser local navigation uses the known placement plus its working-tree index; remote navigation uses Wire resolution. Do not invent an observation cursor in a direct resolver: daemon status/observation still comes from retained tree/event routes. Switch callers, then remove the `/v1/resolve` branch in `sync-http.ts`, both REST wrappers, and daemon-only resolver plumbing that has no remaining caller.
   **Verify:** `bun run typecheck`, `bun test tests/unit/cli.test.ts tests/integration/cli-sync.test.ts tests/integration/server.test.ts`, and `bun run test:protocol` must pass. Add focused direct-resolver tests for symlinks, unknown paths/TreeIDs, nested tree boundaries, and account-qualified remote locators; compare results with the old behavior before deleting it.
3. **Remove the second file-reading API after asset migration.** `packages/arborsync/src/browser-http.ts` currently dispatches non-versioned requests through `LocalFileService.fileSurface` and `fileSurfaceInScopeOf`; `Workspace.fileSurface` implements the bytes read. Resolve authored relative/tree-rooted asset links within the browser working tree without changing stored Markdown, obtain the selected hash through the object store, and render object/blob URLs. Newly uploaded, unaccepted bytes must resolve from the client overlay rather than assuming the daemon already has them. Then remove filesystem-path byte dispatch, raw overrides, Referer scoping, and dead service methods. Keep explicit built-bundle asset routes and app-shell navigation, and ensure a filesystem path or `?raw` cannot bypass them to read disk bytes. Do not change Canopy's public file-serving surface.
   **Verify:** `bun test tests/unit/local-handlers.test.ts tests/integration/server.test.ts` and `bun run test:e2e` must pass after replacing old file-serving assertions with no-disk-byte-leak checks and browser tests for relative assets, tree-rooted assets, pending uploads, navigation, and nested tree scope.
4. **Reconcile docs, fixtures, and retained routes.** Update TypeScript/Swift models and conformance/reference fixtures where shapes or exposed operations change. Add tests that the three removed versioned routes answer `405 unsupported-operation` without side effects, and that `/v1/bootstrap/accounts` remains served. Update the reference API documentation from `account-http.ts`, `sync-http.ts`, and `browser-http.ts`; remove current claims that the web creates identities, disconnects installations, or reads files through filesystem-path URLs. Run all gates below, including Swift REST tests.

### Boundaries and stop conditions

- This is route/caller deletion within Plan B, not a new daemon, filesystem mirror, socket protocol, or general resolver framework. Preserve the recent handler and filesystem-object-source ownership split.
- Do not remove `GET /v1/accounts` identity information, profile keys, account-claim setup, pairing, or native/CLI setup libraries merely because a browser action disappears.
- If direct CLI resolution cannot preserve tree-boundary or account-selection semantics without another protocol/design decision, stop and report that concrete gap; do not silently simplify the semantics or retain `/v1/resolve` as an undocumented shim.
- If an additional production caller of a removal target is discovered, inventory and migrate it in this plan before deleting the route. Do not broaden scope into unrelated client or Wire refactors.

## Editor-operation integration

Use the existing TypeScript source-admission session consumer in the browser editor host.
Connect real editor transactions to original source/basis capture, durable admission, exact
retry and receipt settlement; do not infer move/copy intent from matching final text. Preserve
newer browser work during remote updates and recovery, and prove offline/restart behavior
against disposable Canopy. Support only operation forms for which the browser has real capture
and the server has verified execution support. Browser command parity can follow incrementally.

This is the browser integration formerly listed in [Native 008](../native/008-complete-native-move-copy-undo-capture.md).
That plan now owns additional command capture rather than rebuilding this editor host.

## Verification

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
bun run test:e2e
swift test --package-path native/Packages/ArborSyncClient
git diff --check
```

End-to-end with a local Canopy, `arborsync --control`, and one placed tree: edit a page in the browser and see the folder update within a second; edit on disk and see the page update; close the tab mid-edit and reopen to see the browser's own head or attempt replay once; leave a daemon request pending or conflicted and verify the browser remains writable and publishes independently; a second tab in the same browser profile opens read-only because it shares that browser working-tree store.

## Done criteria

- Arbor web installs the accepted-root bootstrap, edits through its own `UpdateCoordinator` against Canopy, never imports daemon client state, and never calls a daemon editor route.
- `@arbor/working-tree` and `ArborWorkingTree` pass the same `conformance/client-state-machines.json`.
- Known gaps recorded in `status.md`: collection-file rows in the browser (Native 003) and accepted history (Canopy 007).
- `POST /v1/me`, `POST /v1/local/forget`, and `GET /v1/resolve` answer `405 unsupported-operation`; no production client calls them. Negative tests and historical evidence may name them.
- Browser identity creation and installation-disconnect actions are gone; claiming through `POST /v1/bootstrap/accounts` remains functional with an existing identity.
- Filesystem-path URLs and `?raw` never return placed-file bytes. App navigation and explicit built assets work; authored assets and pending uploads resolve through the working tree/object store without source normalization.
- All verification commands above pass, including direct-resolver regressions and Swift REST tests. Audit remaining references with `rg -n '/v1/(me|local/forget|resolve)|fileSurfaceInScopeOf|fileSurface|createProfileIdentity|forgetLocalAccount' packages native tests docs conformance` and classify each remaining match; shared native/CLI setup functions and negative tests are not automatically dead code.
