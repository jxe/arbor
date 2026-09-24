# Native 006: Place trees sparsely on iOS

Historical identifier: **Reliability 006**, formerly "Preview and resume initial
working-tree bootstrap". Rewritten 2026-09-24 against the specification's sparse
install ([tree operations §1.1](../../docs/overstory-spec/01-tree-operations.md#11-current-tree-accepted-snapshots-and-watch)).
The earlier design (HTTP `Range` resume of one whole snapshot bundle, a staging
replica, a read-only preview, a bootstrap state machine) is in git history. A sparse
placement removes the problem it was built around: one large body that must arrive
whole.

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** MEDIUM. It changes which objects an iOS working tree holds locally,
  and so what is available offline.
- **State:** PLANNED
- **Depends on:** nothing. No server or wire change.

## What exists

- **The spec allows it.** A snapshot may be installed sparsely: directories and
  Markdown present, every other file referenced by hash, provided every hash is
  resolvable on demand and the spine validates.
- **Catch-up already does it.** `UpdateCoordinator.sparseDirectoryGraph`
  (`swift/Packages/CanopyWorkingTree/Sources/CanopyWorkingTree/UpdateCoordinator.swift`)
  walks the spine from a root object by object, reuses local objects, fetches
  the rest through the tree-scoped object route, validates with
  `ProtocolObjectGraph.validate(_, mode: .sparseFiles)`, and installs it.
- **iOS resolves absent files already.** `CanopyAppModel` opens each working tree
  over `HostObjectStore`, which reads any object by hash from Canopy, and
  `LayeredObjectStore` puts local objects in front of it.
- **Only placement is whole.** `WorkingTreePlacementService.place`
  (`swift/Packages/OverstoryClient/Sources/OverstoryClient/WorkingTreePlacementService.swift`)
  still calls `transport.snapshot`, which buffers the complete bundle
  (`ProtocolClient.snapshot`, `URLSession.data(for:)`) before anything is
  installed. On a slow connection that looks stuck, and a timeout starts over.
  The Mac places through the daemon's loopback sparse bootstrap and is out of
  scope.

## Work

1. **One spine walker.** Move the spine walk out of `UpdateCoordinator` into a
   shared function in `CanopyWorkingTree` that takes a root, a local object
   lookup and a fetch, and reports progress (objects and bytes fetched, directories
   still to visit). Catch-up and placement both call it.
2. **Sparse placement.** `WorkingTreePlacementService.place` pins the descriptor,
   walks the spine from its root, and installs with `mode: .sparseFiles`, recording
   the pinned update and cursor as today. Keep `transport.snapshot` as the fallback
   when an object read is unavailable, as catch-up does.
3. **Resume by keeping what arrived.** Write each verified object into the new
   working tree's object store as it arrives, before the install, so an
   interrupted placement resumes by walking again and fetching only what is
   missing. The working tree is not marked placed (no `materialized/tree.json`,
   no format marker) until the install succeeds, so `openOrPlaceWorkingTree`
   retries placement rather than opening a half-placed tree.
4. **Fetch concurrency.** Fetch a directory's children with bounded concurrency
   (for example 8 at a time); one object per request over a slow link is otherwise
   latency-bound. Measure a large tree before and after.
5. **Progress.** Replace the single "Syncing" launch state with "Placing: N of M
   pages" from the walker's counts (M grows as directories are read, so show it as
   a count, not a percentage). VoiceOver announces stage changes, not every tick.
6. **Offline availability.** Decide and state what a sparse iOS tree promises
   offline. Recommended: Markdown and directories are always local; other files
   are fetched on first open and kept, and a file opened offline that was never
   fetched shows "Needs a connection" rather than an error. Optionally prefetch
   the remaining files in the background after placement, but a placement is
   complete without it.

## Verification

- Focused `CanopyWorkingTree` and `OverstoryClient` tests: a placed tree's heads
  equal the pinned descriptor; non-Markdown files are absent and open through the
  platform store; an interruption at each object resumes without refetching stored
  objects; a canopyd that advances during placement is caught up by the ordinary
  update machine afterwards; a corrupt object fails placement and leaves no placed
  tree.
- `swift test --package-path swift/Packages/CanopyWorkingTree` and
  `swift/Packages/OverstoryClient`, `swift/scripts/test-canopy-editor-local.sh`, and
  an iOS build through `swift/Canopy.local.xcworkspace`.
- Hands-on on iPhone with Network Link Conditioner: time to first usable page on
  the largest tree before and after, interrupt mid-placement and relaunch, and open
  an unfetched image offline.

## Out of scope

Server changes (byte ranges, bundle ETags, wider object-read authorization), a
read-only preview state, lazy fetching of Markdown, and the Mac's daemon bootstrap.

## STOP conditions

- The sparse install would accept a spine the full-snapshot path rejects.
- Placement would mark a tree placed before its spine validates.
- Offline behaviour for unfetched files cannot be made explicit in the UI.
