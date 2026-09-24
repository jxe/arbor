# Native 010: Native accepted-conflict review

Historical identifier: **Reliability 010**. The filename number is preserved; this plan now belongs to native.

Status: IN PROGRESS. Priority: P1. Native grouped review and generic editor accessories are
implemented and integrated with main; they are not installed or manually
verified. The implemented behavior is listed at the end of this plan.
The remaining Phase 1 work below precedes finer contextual editor work.

## Outcome and ownership

An accepted tree with unresolved choices remains editable and continues syncing.
A person can discover those choices, compare preserved alternatives, and submit
an explicit resolution through canopyd. Review is optional work within the tree,
not a failed-save dialog or a synchronization hold.

This plan owns Native review, including the remaining contextual work previously
specified in 004 (completed plan, deleted; see git history). Its old
rejected-candidate workflow is not the implementation model. Preserve relevant
source-fidelity and crash-safety scenarios, not its retired client conflict machine.
[008](008-complete-native-move-copy-undo-capture.md) owns operation support and client emission;
[canopyd 014](../canopyd/014-merge-moved-text.md) owns better server reconciliation.
[011](../verification/011-client-compatibility.md) owns compatible adoption. Filesystem
review remains separate from the Native working tree.

Before implementation inspect git status, current source and tests, especially
[UpdateCoordinator](../../swift/Packages/CanopyWorkingTree/Sources/CanopyWorkingTree/UpdateCoordinator.swift),
[accepted inspection types](../../packages/protocol/src/updates/accepted-contract.ts),
[authored operations and resolution declarations](../../packages/protocol/src/updates/authored-contract.ts),
and the [live change-log tests](../../swift/Packages/CanopyWorkingTree/Tests/CanopyWorkingTreeTests/LiveChangeLogTests.swift).
Use the conflict inspection contract in [the reference implementation](../../docs/architecture/protocol/README.md#conflict-inspection)
and the admission invariants in [client state machines](../../docs/implementing-editors/document-admission.md#7-admission-invariants-and-trace-compaction) for implementation
history, not as a substitute for checking current code.

The shared client owns pinned inspection, durable drafts, guarded submission and
accepted transitions. Native owns presentation and navigation. EditorBridge and
Quagmire own source selection, rendering and accessories, not conflict policy or
another merge engine. Put correctness checks in client APIs and state transitions,
so a view cannot accidentally bypass them. Mirror shared policy changes in Swift,
TypeScript, conformance fixtures and the client state-machine specification.
[Clients 001](../clients/001-reconcile-client-state-machines.md) makes a submitted draft an ordinary
change-log record carrying `resolves`, which replaces the coordinator's separate review pass and
review attempt; drafts and review UI stay here.

## Phase 1: Remaining work

The implemented sidebar list, page markers, exact-source comparison/composition,
draft persistence, source-range resolution, grouped structural resolution and generic Quagmire accessories are documented in the
list at the end of this plan. Keep their supported scope and
conservative accepted-state freshness checks explicit while completing this phase.

- Complete the [Native hands-on release gate](../verification/release-and-soak.md#native-release-and-hands-on-review)
  for macOS/iPhone interaction and installed draft recovery. Builds alone do not pass it.
- Add safe binary previews/export and richer directory browsing beyond the exact
  recursive path/metadata preview. Add format-specific collection reconstruction. Keep
  explicit unavailable states for unsupported renderers or missing material.
- Add richer long-source comparison and verify whitespace-only and line-ending
  differences visually. Current bounded changed-line highlighting falls back to
  raw source for very large comparisons.
- Make unrelated accepted updates less disruptive only through an explicit,
  compatible freshness policy. Current canopyd guards require the current accepted
  state; preserve drafts and require renewed review rather than silently retargeting.
- Expand fault injection across review persistence, submission, installation and
  retirement, including authorization changes and cancellation. Existing live
  tests cover lost accepted responses, restart and newer editor/draft work.
- Complete cross-language shared review policy when the TypeScript editor-host
  integration is built. Both Overstory clients already read authorized alternatives;
  the durable review controller currently lives in the Swift working-tree client.

Use deterministic fixtures and real canopyd integration for the remaining scopes.
Run focused shared-client/Native tests, applicable protocol/conformance checks,
and the relevant [development gates](../../DEVELOPMENT.md). Distinguish
built/tested from installed/verified. Record completed evidence in the checkpoint
and status, and remove completed executor work from this active plan.

## Phase 2: Contextual review in the editor

Source-range choices that canopyd places in the current file now appear
beside their blocks: a margin marker and an inline card per choice
(`ArborInlineChoice`), resolved with one Keep per alternative through the same
draft, preview guard and submission. `ArborDocumentBinding.blocks(overlapping:inSource:)`
maps the range only through a ledger whose source hashes to the named object;
anything else, and every non-range choice, stays in the page panel.
`swift/scripts/conflict-lab.ts` reproduces each case against a local canopyd.

Remaining:

- Show each alternative within its surrounding sentence or block; the card
  shows only the retained fragment.
- Tint the affected blocks (needs a Quagmire accessory highlight) and anchor
  the marker at the first affected block.
- Choices retained in their own context report base coordinates and cannot be
  placed; relocate them through piece origins or keep them in the panel.
- Show alternatives beside relevant paragraphs, list items, table cells, frontmatter
  or fenced code with enough surrounding context. Preserve exact raw-source access.
- Map authoritative source ranges through editor refreshes; validate the mapping
  before presenting a location. Fall back to page/directory review when placement
  is uncertain, rather than guessing or mutating the document to insert markers.
- Keep coupled decisions grouped even when their markers appear far apart; the
  inline card resolves unchosen group members with what they show now.
- Explain verified actions such as moves, copies, deletion and hidden-alternative
  edits. Keep uncertain correspondence and unknown authors explicit.
- Offer rule-provided combination previews and richer format-specific controls as
  capabilities arrive. UI improvements must remain compatible with ordinary accepted
  states and existing clients; they must not require a coordinated cutover.
- Verify duplicate paragraphs, moved ranges, split/combined blocks, tables, links,
  fences, selection/IME composition, keyboard navigation and scroll stability in
  both platforms. The generic document/block accessory API is implemented; extend
  its anchors only when authoritative source mapping requires another concrete surface.

## Deferred conveniences

Durable inspection caching, complete offline review, bulk resolution, elaborate
provenance visualization and post-acceptance causal undo are not first-release
requirements. Local draft editing may be undone before submission; do not simulate
causal undo afterward by restoring an old whole-tree snapshot. Merge binary design
and operation expansion remain separate work, not prerequisites for this UI.

## Implemented behavior to preserve

- The host requires exact accepted-state guards, so any accepted-state change
  requires explicit review of the latest evidence, even when projected bytes
  are equal or the update is unrelated. Relaxing this needs a compatible host
  and client policy together.
- Sources beyond 4,000 combined lines bypass line diffing and are shown as raw
  source. Byte ranges are never presented as guessed paragraph locations until
  a validated source-to-block mapping exists.
- Alternative material is read through the ordinary `object(tree, hash)`
  route. A newer local draft is not removed by an older accepted submission;
  retirement compares a byte-preserving draft hash.
- The review state lives in `sync/conflict-review.json` (schema 2, reads 1).
  The UI depends on Quagmire 0.8.0's `EditorAccessory` API.

Known gaps: interactive focus, selection, scroll, VoiceOver, large text, and
IME remain a manual gate on both platforms; binary rendering and export and
format-specific reconstruction are outside the surface; there is no
TypeScript review controller.
