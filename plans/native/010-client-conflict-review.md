# Native accepted-conflict review

Historical identifier: **Reliability 010**. The filename number is preserved; this plan now belongs to native.

Status: IN PROGRESS. Priority: P1. Native grouped review and generic editor accessories are
implemented and integrated with main; they are not installed or manually
verified. See the [implementation and verification checkpoint](../../docs/native-conflict-review.md).
The remaining Phase 1 work below precedes finer contextual editor work.

## Outcome and ownership

An accepted tree with unresolved choices remains editable and continues syncing.
A person can discover those choices, compare preserved alternatives, and submit
an explicit resolution through Canopy. Review is optional work within the tree,
not a failed-save dialog or a synchronization hold.

This plan owns Native review, including the remaining contextual work previously
specified in 004 (completed plan, deleted; see git history). Its old
rejected-candidate workflow is not the implementation model. Preserve relevant
source-fidelity and crash-safety scenarios, not its retired client conflict machine.
[008](008-complete-native-move-copy-undo-capture.md) owns operation support and client emission;
[009](../canopy/009-canopy-provenance-merges.md) owns better server reconciliation.
[011](../verification/011-client-compatibility.md) owns compatible adoption. Filesystem
review remains separate from the Native working tree.

Before implementation inspect git status, current source and tests, especially
[UpdateCoordinator](../../native/Packages/ArborWorkingTree/Sources/ArborWorkingTree/UpdateCoordinator.swift),
[accepted inspection types](../../packages/wire/src/updates/accepted-contract.ts),
[authored operations and resolution declarations](../../packages/wire/src/updates/authored-contract.ts),
and the [live source-admission tests](../../native/Packages/ArborWorkingTree/Tests/ArborWorkingTreeTests/LiveSourceAdmissionTests.swift).
Use the [deployed acceptance checkpoint](../../docs/accepted-entry-conflicts.md)
and [queue checkpoint](../../docs/source-admission-queue.md) for implementation
history, not as a substitute for checking current code.

The shared client owns pinned inspection, durable drafts, guarded submission and
accepted transitions. Native owns presentation and navigation. EditorBridge and
Quagmire own source selection, rendering and accessories, not conflict policy or
another merge engine. Put correctness checks in client APIs and state transitions,
so a view cannot accidentally bypass them. Mirror shared policy changes in Swift,
TypeScript, conformance fixtures and the client state-machine specification.

## Phase 1: Remaining work

The implemented sidebar list, page markers, exact-source comparison/composition,
draft persistence, source-range resolution, grouped structural resolution and generic Quagmire accessories are documented in the
[checkpoint](../../docs/native-conflict-review.md). Keep their supported scope and
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
  compatible freshness policy. Current Canopy guards require the current accepted
  state; preserve drafts and require renewed review rather than silently retargeting.
- Expand fault injection across review persistence, submission, installation and
  retirement, including authorization changes and cancellation. Existing live
  tests cover lost accepted responses, restart and newer editor/draft work.
- Complete cross-language shared review policy when the TypeScript editor-host
  integration is built. Both Wire clients already read authorized alternatives;
  the durable review controller currently lives in the Swift working-tree client.

Use deterministic fixtures and real Canopy integration for the remaining scopes.
Run focused shared-client/Native tests, applicable protocol/conformance checks,
and the relevant [development gates](../../DEVELOPMENT.md). Distinguish
built/tested from installed/verified. Record completed evidence in the checkpoint
and status, and remove completed executor work from this active plan.

## Phase 2: Contextual review in the editor — later

Ship Phase 1 independently. Add contextual affordances only where Canopy evidence
and the editor's exact source mapping support them.

- Place compact inline markers at affected source locations and navigate between
  them from the tree list. Reuse the same review model and submission path.
- Show alternatives beside relevant paragraphs, list items, table cells, frontmatter
  or fenced code with enough surrounding context. Preserve exact raw-source access.
- Map authoritative source ranges through editor refreshes; validate the mapping
  before presenting a location. Fall back to page/directory review when placement
  is uncertain, rather than guessing or mutating the document to insert markers.
- Attach independently resolvable source choices to their verified block locations.
  The range compiler and Canopy operations are implemented; contextual block mapping
  remains. Keep coupled decisions grouped even when markers appear far apart.
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
