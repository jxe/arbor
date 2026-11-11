# Native 006: Place trees sparsely on iOS

**Why and when:** when size hurts: a tree too big to place on the iPhone in one download.

Historical identifier: **Reliability 006**, formerly "Preview and resume initial
working-tree bootstrap". Rewritten 2026-09-24 against the specification's sparse
install ([tree protocol §1.1](../../docs/overstory-spec/1.2-tree-protocol.md#11-current-tree-accepted-snapshots-and-watch)).
The earlier design (HTTP `Range` resume of one whole snapshot bundle, a staging
replica, a read-only preview, a bootstrap state machine) is in git history. A sparse
placement removes the problem it was built around: one large body that must arrive
whole.

## Status

- **Effort:** M
- **Risk:** MEDIUM. It changes which objects an iOS working tree holds locally,
  and so what is available offline.
- **State:** PLANNED
- **Depends on:** nothing. No server or wire change.

## What exists

- **The spec allows it.** A snapshot may be installed sparsely: directories and
  Markdown present, every other file referenced by hash, provided every hash is
  resolvable on demand and the spine validates.
- **The engine already loads lazily.** Since Clients 003 a `TreeSession` opens a tree
  with a prefetch setting: `openedPages` holds the root and loads each directory, with
  its Markdown bodies, through the object sources on first use
  (`WorkingTree.ensureLoaded`), checked against its hash; installs read
  `WorkingTree.acceptedGraph`. iPhone trees open as a Replica (`prefetch:
  .everything`, on disk), which still places from one whole snapshot
  (`TreeSession.openOrPlaceReplica` calls `transport.snapshot`, buffered whole before
  anything is installed). On a slow connection that looks stuck, and a timeout starts
  over.

## Work

1. **Progress from the walk.** `WorkingTree.acceptedGraph` reports progress (objects
   and bytes fetched, directories still to visit).
2. **Sparse placement.** A Replica places by pinning the descriptor and installing
   `acceptedGraph` (or opening lazily and running `loadEverything` in the
   background), recording the pinned update and cursor as today. Keep
   `transport.snapshot` as the fallback when an object read is unavailable, as
   catch-up does.
3. **Resume by keeping what arrived.** Write each verified object into the new
   working tree's object store as it arrives, before the install, so an
   interrupted placement resumes by walking again and fetching only what is
   missing. The working tree is not marked placed (no `materialized/tree.json`,
   no format marker) until the install succeeds, so `TreeSession.openOrPlaceReplica`
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

- Focused `OverstoryWorkingTree` and `OverstoryClient` tests: a placed tree's heads
  equal the pinned descriptor; non-Markdown files are absent and open through the
  platform store; an interruption at each object resumes without refetching stored
  objects; an overstoryd that advances during placement is caught up by the ordinary
  update machine afterwards; a corrupt object fails placement and leaves no placed
  tree.
- `swift test --package-path swift/Packages/OverstoryWorkingTree` and
  `swift/Packages/OverstoryClient`, `swift/scripts/test-story-editor-local.sh`, and
  an iOS build through `swift/Story.local.xcworkspace`.
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
