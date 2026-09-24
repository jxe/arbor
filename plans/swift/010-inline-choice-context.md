# Native 010: Show accepted choices in their editor context

Historical identifier: **Reliability 010**, formerly "Native accepted-conflict
review". Cut down 2026-09-24: the review UI is built (see the end of this plan), and
the broader wish list moved to the [catalog](../catalog.md#native-clients). What
remains is the hands-on release gate and three editor-context gaps.

Status: IMPLEMENTED, NOT INSTALLED. Priority: P1 for the gate, P2 for the rest.

## Ownership

The Swift working-tree client owns pinned inspection, durable drafts, guarded
submission and accepted transitions; a submitted draft is an ordinary change-log
record carrying `resolves` (Clients 001). Native owns presentation and navigation.
EditorBridge and Quagmire own source selection, rendering and accessories, not
conflict policy. [008](../soon/008-complete-native-move-copy-undo-capture.md) owns operation
capture; [canopyd 014](../soon/014-merge-moved-text.md) owns server
reconciliation; [Web 025](../canopy-web/025-arbor-web.md) Phase 9 owns the TypeScript
review controller. Held folders (refused changes) are a different surface, owned by
[012](012-show-held-folders.md).

Before starting, read [UpdateCoordinator](../../swift/Packages/CanopyWorkingTree/Sources/CanopyWorkingTree/UpdateCoordinator.swift),
`UpdateCoordinator+Review.swift`, `CanopyConflictReview.swift`,
`CanopyDocumentBinding.blocks(overlapping:inSource:)` and the
[live change-log tests](../../swift/Packages/CanopyWorkingTree/Tests/CanopyWorkingTreeTests/LiveChangeLogTests.swift).
`swift/scripts/conflict-lab.ts` reproduces each case against a local canopyd.

## 1. Hands-on release gate (Joe)

The [Native hands-on gate](../verification/release-and-soak.md#native-release-and-hands-on-review)
on macOS and iPhone: layout, typing, focus, selection, scrolling, keyboard routing,
VoiceOver, large text, IME, and installed review-draft recovery. Builds and tests do
not pass it. Fix what it finds before the items below.

## 2. Show each alternative in its sentence or block

The inline card (`CanopyInlineChoice`) shows only the retained fragment. Show each
alternative within its surrounding sentence or block, keeping exact raw-source
access, so a reader can judge it without opening the page panel.

## 3. Tint the affected blocks

Anchor the margin marker at the first affected block and tint every affected block.
This needs a highlight on Quagmire's `EditorAccessory` API: a Quagmire release,
pinned by both manifests at the same exact version, tested with
`swift/scripts/test-canopy-editor-local.sh`.

## 4. Place choices retained in their own context

Choices retained in their own context report base coordinates, so they cannot be
placed and fall back to the page panel. Relocate them through piece origins when the
mapping validates against the named object; otherwise keep them in the panel. Never
guess a location or mutate the document to insert a marker.

Each item: deterministic fixtures plus a conflict-lab case on real canopyd,
covering duplicate paragraphs, moved ranges, split and combined blocks, tables,
links and fences; then the focused Swift suites, macOS and iOS builds, and a
hands-on check. Record evidence in `status.md` and delete the item here.

## Implemented behavior to preserve

- Sidebar choice list, page markers, exact-source comparison and composition,
  durable grouped drafts, recursive path and metadata previews, source-range and
  grouped structural resolution, and inline cards with one Keep per alternative
  for source-range choices canopyd places in the current file.
- `blocks(overlapping:inSource:)` maps a range only through a ledger whose source
  hashes to the named object; anything else, and every non-range choice, stays in
  the page panel.
- The host requires exact accepted-state guards, so any accepted-state change
  requires review of the latest evidence, even when projected bytes are equal or
  the update is unrelated. Relaxing this needs a host and client policy together.
- Sources beyond 4,000 combined lines skip line diffing and show raw source.
- Alternative material is read through the ordinary `object(tree, hash)` route. A
  newer local draft is not removed by an older accepted submission; retirement
  compares a byte-preserving draft hash.
- Review state lives in `sync/conflict-review.json` (schema 2, reads 1). The UI
  depends on Quagmire 0.8.0's `EditorAccessory` API.
- Local draft edits can be undone before submission; there is no causal undo after
  acceptance, and none is simulated by restoring an old snapshot.
