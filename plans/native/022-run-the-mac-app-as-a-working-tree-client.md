# Plan 022: Run the Mac app as a working-tree client

> **Executor instructions**: Make every editor a direct Canopy client of the same update machine, and make the arborsync daemon the placed folder's client plus three loopback services: bootstrap, credential, and a content-addressed object cache backed by the disk files. Nobody edits through the daemon. This plan (Plan A) covers the daemon services and the Canopy object-route widening, the Swift split into WorkingTree and ObjectStore, the Mac switch with a shared daemon credential and adoption of the daemon's pending request, the CLI's configuration edit on disk, and the deletion of the daemon's editor path. The web editor is unavailable from Phase 7 until Plan B rebuilds it on the working tree. Clean breaks over compatibility shims; nothing live flips without Joe's go-ahead.
>
> **Drift check**: `git diff --stat 32799e8..HEAD -- packages/arborsync packages/canopy packages/canopy-client packages/stores packages/fs packages/wire packages/cli packages/arborsync-client native/Packages native/ArborApp spec docs conformance tests tools`

## Status

- **Priority**: P1 — the current native synchronization work
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: completed Reliability 005 (client synchronization state machines) and completed Native 021 (file patches)
- **Category**: reliability/architecture
- **Planned at**: Arbor `32799e8`, 2026-09-09
- **Follow-ons**: Plan B (web editor on the working tree; TS `@arbor/working-tree` and `@arbor/object-store`) and Plan C (disk editors for non-tree folders) are written after this plan's soak.

## Why this matters

The Mac app and the web editor edit *through* the daemon: the app's admission machine, then the daemon's editor-admission freeze, then the daemon's own synchronization machine, then Canopy, then a request-digest fence back to the editor. iOS runs the Swift working-tree core directly against Canopy. That is three differently shaped machines across platforms, and the double hop is where native flakiness lives.

The governing principle: it is not about one client or the other, it is about having simple state machines that always work and are well understood, everywhere.

## Design

- **Every editor is a working-tree client.** The Mac app, iOS, and later the web editor run the same update machine, checked by the same `conformance/client-state-machines.json`.
- **The daemon is the folder's client.** It watches Canopy, materializes accepted roots, pushes disk-originated changes, and reviews disk-originated conflicts. For other clients on the machine it serves `GET /v1/bootstrap`, `GET /v1/credential`, and `GET /v1/objects/{hash}`.
- **The object index is the object store.** A per-workspace SQLite table keyed on the full stat tuple (size, mtime, ctime, inode, device) maps paths and directories to hashes; serving by hash is one query. The index is an optimization: uncached walks run at start, after watcher gaps, and periodically; every served object is hash-verified. Canopy's object route widens to any retained accepted root so fetch-through covers older bases.
- **WorkingTree and ObjectStore.** Node records hold a content reference (inline or hash). A state-store seam (disk on iOS, memory on the Mac) and an object-store seam (own unaccepted overlay, then platform: disk on iOS, the daemon on the Mac, Canopy last). Markdown source stays inline; directory objects are always materialized. The overlay is a cache; resubmission reads envelopes only from the durable attempt or head.
- **Shared credential and adoption.** The app uses the daemon's device credential over loopback. When the daemon has a pending request, the app adopts that exact request as its first in-flight attempt; Canopy trims accepted elements by credential-scoped digest, so both may submit it. A daemon conflict opens the tree read-only with the existing review UI.
- **Visits** are app-side: the same client, read-only, anonymous for public trees.
- **Names**, identical in Swift and TypeScript: `WorkingTree`, `WorkingTreeProvider`, `WorkingTreeStateStore`, `UpdateMachine`, `UpdateCoordinator`, `UpdateControl`/`UpdateAttempt`/`UpdateHead` (package `ArborWorkingTree`, later `@arbor/working-tree`); `ObjectStore`, `ObjectOverlay`, `LayeredObjectStore`, `DirectoryObjectStore`, `DaemonObjectStore`, `CanopyObjectStore` (package `ArborObjectStore`, later `@arbor/object-store`); `CanopyClient` keeps transport, credentials, pairing, placement, and `CanopyWatchRunner`. "Replica" and client-side "sync" disappear. Fixture keys become `working-tree-updates` and `document-admission`; the admission machine keeps one transport.

## Phases

Each phase is testable alone. Docs, specs, and `status.md` land in the same change as the code they describe.

Phase status: **0–7 DONE (Plan A implemented).** 5 is done in code (Mac `openPlacedTree`, `NativePlacementStore` on macOS, app-side `VisitedTreeStore` and `openRemoteLocator`, configuration YAML edited on disk through the Swift twin of `editAccountConfigurationFile`, `restartArborSync` reconnects and re-opens, hosted smoke harness at `native/scripts/hosted-smoke.ts`, format marker `4`). 7 deleted the daemon's editor routes (`/v1/node|children|search|backlinks|recovery|file|mutations|documents/admit|assets|imports|sessions`), editor admission, the search index, system trees, and daemon visits; the Swift `ArborSyncWorkspaceProvider`, `ArborSyncDocumentSession`, `AdmissionWatchGate`, the editor half of `ArborSyncRESTClient` and its `Protocol.swift` node types, the supervisor's workspace mode, and `NodeModelConformanceTests`; the filesystem role (`setRole`, `discardMirrorHead`, `role`) from `UpdateMachine`, `reduceUpdate`, and the fixture; the `canopy` admission transport, the digest fence, and `admissionBasis` from `DocumentAdmissionMachine`, `reduceAdmission`, `WorkspaceDocumentSnapshot`, and the fixture (`arborsync-document-admission` → `document-admission`); `tests/protocol/conformance.ts` now exports a control-mode daemon with one placed tree. **Still pending, see "Live gates" below: the live Mac switch, the iPhone re-place, and the soak.**

0. **Plan bookkeeping.** This file; index and rescope entries in `plans/README.md` (Smaller project 009 and Speed 001 superseded pending Phase 7; Reliability 004 and 006 and Security 001 rescoped; Smaller project 003 priority raised; web items waiting on Plan B).
1. **Daemon and Canopy, additive.** Watch-queue fix in `tree-sync.ts` so a foreign-accepted replay materializes promptly; Canopy object route serves any retained root; the `objects` index table with stat-tuple validity and periodic revalidation; one `snapshotDirectory` returning lazy byte loaders; `object-cache.ts`; the three routes. Test that the daemon's resubmission of a fully-trimmed chain is a replay, not a merge. Specs: `spec/01` §1 and `spec/05` object-route scope.
2. **Swift WorkingTree and ObjectStore.** Rename commit first, then `ContentRef`, `WorkingTreeStateStore`, the `ArborObjectStore` package, sparse snapshot emission and sparse graph validation, the overlay GC invariant. Specs: `spec/01` §1.1 sparse install; replica wording in `spec/01` and `spec/04` §7.
3. **UpdateCoordinator.** Sparse candidates, `adoptInFlight`, durable `UpdateHead`, recovery that pulls current for a re-seeded tree, submission hold, adopted-prefix conflict ownership, `CanopyWatchRunner`; TS reducer rename to `reduceUpdate`. Specs: `spec/09` retitled with the sparse-install and adoption entries, durable objects with heads and requests, rules 1, 3, 8, 10; fixture key rename and two adopted-prefix scenarios; `wire-update-intent.json` envelope-independence vector.
4. **Swift loopback client.** `bootstrap`, `credential`, `object`; `ArborSyncCredentialProvider`; `DaemonObjectStore`; control-mode supervisor. Spec: `spec/04` §5 shared device credential on one installation.
5. **Mac app switch and visits.** `openPlacedTree`, `NativePlacementStore` on macOS, app-side `VisitedTreeStore`, configuration YAML written on disk, format marker 4. **Gate: Joe's go-ahead for the live Mac switch and the iOS re-place (sync the phone first).** Spec: `spec/04` §4 working trees versus borrowed object stores. Verification of this phase: `swift test` for `ArborWorkingTree`, `CanopyClient`, `ArborSyncClient`, `ArborKit`; `ArborAppTests` on macOS (the test host cannot launch while another Arbor instance is running); `bun native/scripts/hosted-smoke.ts` for the end-to-end smoke against a local Canopy and the bundled control daemon.
6. **CLI configuration YAML on disk.** `editAccountConfigurationFile` in `@arbor/stores`; `arbor open` reports that the web editor returns in Plan B.
7. **Delete the editor path everywhere.** Daemon node/mutation/admission/asset/import/session routes, editor admission, search index, system trees, daemon visits; the filesystem role from both reducers; the fenced `canopy` admission transport; the Swift `ArborSyncWorkspaceProvider`; tests, fixtures, and the lab probes. Specs: `spec/09` role and rule 2 removed, rule 4 reworded, §3 rewritten; `spec/01` §3 refreshed; fixture keys renamed. Plans: superseded entries move to `_done/`.

Then a soak of a couple of weeks on the Mac before Plan B.

## Live gates (pending Joe)

Nothing live has flipped. Two migrations wait for an explicit go-ahead, then the soak starts:

1. **Mac switch launch.** Launch the built app against the real `~/.arbor` data home and the persistent control daemon; the placed trees open through `/v1/bootstrap` and edits publish through the app's own `UpdateCoordinator`. The end-to-end checks in "Verification" below are run at that point against the live installation.
2. **iPhone re-place on marker 4.** The working-tree state format changed and there is no decoder for the old one; the format marker wipes local state on mismatch and re-downloads from Canopy, which discards any iPhone edits Canopy has not accepted. **Open the app on the phone and let it finish syncing before installing the new build.**
3. **Soak.** A couple of weeks on the Mac before Plan B (web editor on the working tree) starts.

## Verification

```sh
bun run typecheck
bun run test
bun run test:sync-merge
bun run test:protocol
swift test --package-path native/Packages/ArborWorkingTree
swift test --package-path native/Packages/ArborObjectStore
swift test --package-path native/Packages/CanopyClient
swift test --package-path native/Packages/ArborSyncClient
swift test --package-path native/Packages/ArborKit
swift test --package-path native/Packages/ArborWire
bun run build
git diff --check
```

End-to-end with a local `canopyd`, `arborsync --control`, and one placed tree:

- Edit a page in the app: the folder updates within about a second and Canopy has exactly one new update.
- Edit the file on disk: the app updates within about two seconds with no duplicate blocks.
- Kill the app within 200 ms of an edit and relaunch: the edit reaches the folder; Canopy has no update whose candidate equals the pre-edit root.
- Dirty daemon: with Canopy stopped, edit on disk, launch the app, edit in the app, start Canopy. One app request carries the daemon chain plus the app edit; Canopy accepts once; the daemon's later resubmission is a replay; the daemon's state loses `pending`; the folder matches.
- Force a daemon conflict: the app opens read-only with the review sheet; resolving re-opens writable.
- Visit a public tree by URL with no account: read-only pages; images load through `/v1/objects?origin=`.
- Kill the daemon while the app is open: the app keeps editing; on restart the folder catches up without a double apply.
- Open an image page: bytes are fetched on demand and no other file bytes are held.
- iOS after the go-ahead: re-place on marker 4; the state file has no inline bytes; an offline edit becomes one request on reconnect; `LiveNativePeerTests` pass.
- CLI: `arbor place` with Canopy stopped edits `trees.yaml` on disk and shows pending; starting Canopy pushes it.
- After deletion: `/v1/node` returns 405; `bun run lab:hcloud test` passes with the rewritten probes.

## Verification evidence (Phase 7, 2026-09-09, uncommitted working tree)

Commands run and their results:

- `bun run typecheck` — clean (`tsc --noEmit`, no diagnostics).
- `bun test` — 370 pass, 1 fail: `tests/integration/child-provider.test.ts` "expanded exposes the shared snapshot and child-page contract" (`"One"` vs `"one"`), the known title-casing flake; it fails the same way alone and is unrelated to this change.
- `bun test tests/unit/client-state-machines.test.ts` — 4 pass, 447 expectations: both TypeScript reducers execute every scenario of the renamed fixture (12 `document-admission`, 20 `working-tree-updates`).
- `bun run test:protocol` — green on the reduced fixture set: `tests/unit/protocol.test.ts` 13 pass; `ArborSyncClient` 8 XCTest cases with none skipped (the live control-daemon test bootstrapped the placed tree, fetched the credential, and read the root object through `/v1/objects`) plus 14 swift-testing cases; `ArborKit` 15; `ArborWire` 24; `CanopyClient` 8.
- `swift test --package-path native/Packages/ArborWorkingTree` — 54 tests in 9 suites pass (fixture runner asserts ≥ 20 update scenarios).
- `swift test --package-path native/Packages/ArborObjectStore` — 3 tests pass.
- `swift test --package-path native/Packages/ArborKit` — 15 tests pass (admission fixture runner on `document-admission`).
- `swift test --package-path native/Packages/ArborSyncClient` — 8 XCTest (1 skipped without a harness) + 14 swift-testing pass.
- `swift test --package-path native/Packages/ArborWire` and `CanopyClient` — pass (run through `test:protocol` above).
- ArborQuagmire tests — 38 tests pass (`** TEST SUCCEEDED **`), run through `xcodebuild -scheme ArborQuagmireTests test` with a temporary XcodeGen scheme (`package: ArborQuagmire/ArborQuagmireTests`) and `project.yml` pointed at `/Users/joe/src/quagmire`, then `project.yml` restored byte-for-byte, regenerated, and `Package.resolved` checked out. Standalone `swift test` in the package does not resolve a path override for Quagmire, so the Xcode route is the one that works.
- `xcodebuild -project Arbor.xcodeproj -scheme Arbor -destination 'platform=macOS' build` (with `project.yml` temporarily pointed at `/Users/joe/src/quagmire`, then restored byte-for-byte, regenerated, `Package.resolved` checked out) — `** BUILD SUCCEEDED **`; the app compiles against the trimmed `ArborSyncClient` (no deprecated `start(workspace:)`/`restart()` call sites remained).
- `git diff --check` — clean.
- Not run: `ArborAppTests` (needs the hosted smoke harness and a stopped Arbor instance; Joe's Arbor was left running) and `bun run build` (the render bundle is unmounted until Plan B).

## Done criteria

- The Mac app opens placed trees through `/v1/bootstrap`, edits through its own `UpdateCoordinator` against Canopy with the daemon's credential, and never calls a daemon editor route.
- The daemon has no editor path; its REST surface is status, trees, accounts, sync, pairing, conflicts, bootstrap, credential, objects, and events.
- iOS and the Mac run the same `ArborWorkingTree` and `ArborObjectStore` packages; the only platform differences are the state store and the platform object store.
- Both reducers pass the renamed fixture with the adoption scenarios and without the filesystem role.
- Specs, docs, `status.md`, and the plan index describe the shipped state, and the superseded plans are in `_done/`.
