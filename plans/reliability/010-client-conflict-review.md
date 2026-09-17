# Reliability 010: Native accepted-conflict review

Status: READY for Phase 1. Priority: P1. Build the first usable review before the
later contextual editor work. Canopy accepted alternatives and guarded resolution
are the foundation; richer merge rules, additional source operations and
[finer-grained storage](../canopy-storage/002-composable-conflict-fragments.md)
are not prerequisites. Recheck deployed and installed status before execution.

## Outcome and ownership

An accepted tree with unresolved choices remains editable and continues syncing.
A person can discover those choices, compare preserved alternatives, and submit
an explicit resolution through Canopy. Review is optional work within the tree,
not a failed-save dialog or a synchronization hold.

This plan owns Native review, including the remaining contextual work previously
specified in [004](004-contextual-canopy-conflict-resolution.md). Its old
rejected-candidate workflow is not the implementation model. Preserve relevant
source-fidelity and crash-safety scenarios, not its retired client conflict machine.
[008](008-enable-source-operations.md) owns operation support and client emission;
[009](009-canopy-provenance-merges.md) owns better server reconciliation.
[011](011-compatible-accepted-ambiguity.md) owns compatible adoption. Filesystem
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

## Phase 1: Complete review without inline editor integration

### Discovery and presentation

- Add a quiet tree-level “3 unresolved choices” indicator and a navigable list,
  grouped by affected page or directory. Add page badges where the affected page
  is known. Keep accepted sync status distinct from review status; do not imply
  that publication has paused. Counts come from authoritative decisions, not
  a boolean or a guessed count of affected files.
- Open a review panel beside the document on macOS and a full-screen review sheet
  on iPhone. No forced modal on receipt of an accepted conflict.
- Show all alternatives, mark the currently projected one, and highlight exact
  differences. Support more than two alternatives. Use “Version A/B” or verified
  author/action descriptions; avoid device-relative “mine/theirs” labels.
- Show whole-file and directory scope honestly. Do not synthesize source hunks
  from a whole-entry choice and present them as independently resolvable.
- Provide raw-source access, preserving whitespace, line endings and Markdown
  fidelity. Long content must remain usable. Binary review exposes available
  metadata and safe previews/openable copies. Directory/root review summarizes
  affected paths, renames, deletions and metadata, without a synthetic root filename.

### Choices and submission

- Offer “Use this version” for supported alternatives. “Edit result…” opens a
  separate durable text draft. Show the exact proposed content and placement
  changes before “Apply and resolve”; drafting does not replace the live document.
- Offer “Keep both” or automatic combination only when Canopy supplies a supported,
  format-appropriate action. Never hard-code duplication as universally safe for
  Markdown, code, keyed data or binary files. Manual composition remains an explicit
  user-authored result, not a claim that a rule proved it safe.
- Group coupled choices and explain their combined effect. Submit their operations
  and complete guarded resolution declarations as one atomic candidate.
- Bind review to accepted state identity, decision identity and the complete
  alternative sets, not just file hashes or the projection root. Read hidden
  alternatives through the authorized Canopy material paths.
- Ordinary editing can change the projection or an alternative without resolving
  it. Only an explicit guarded declaration resolves the reviewed choice.
- Persist the exact draft, references, guards and outgoing intent before submission.
  Install ordinary accepted results through the existing coordinator. Clear pending
  submission evidence only after the accepted transition is durable. A resulting
  accepted tree may still contain other or newer choices.
- Preserve later local edits and pending intent when applying the resolution result.
  Do not build a second merge engine over the local queue. If a draft cannot yet be
  validly expressed, retain it and explain that specific limitation while ordinary
  synchronization continues.

### Refresh, recovery and accessibility

- If relevant alternatives or their guards change, retain the draft, show “This
  choice has changed,” refresh evidence and require review before resubmission.
  An unrelated update must not discard the draft or silently retarget its guards.
- Preserve drafts across network failure, process exit and restart, including
  uncertain submission outcomes; use existing replay/acceptance identity handling
  rather than inventing a second retry protocol. Another device's resolution must
  not silently delete a local draft.
- Offline users can retain their draft; do not claim resolution before acceptance.
  Fresh complete offline inspection and durable review caching are deferred.
- Keep normal document typing, focus, selection and scroll intact during review
  refresh. Include keyboard navigation, screen-reader labels, non-color status
  cues, dynamic type and small-screen layouts from the first release.

### Phase 1 acceptance gate

Use deterministic fixtures plus real Canopy integration for:

- Multiple independent choices, more than two alternatives and long exact source.
- Hidden-alternative edits, identical projection bytes with changed accepted state,
  and another client resolving while a local review draft exists.
- Binary, delete/edit, file/directory, rename and whole-root choices; coupled choices
  resolve atomically and incomplete guards do not discard alternatives.
- New ordinary edits and remote catch-up while review remains open; publication
  continues and newer local intent survives the resolution transition.
- Stale resolution, transport failure and restart at each durability boundary,
  including an accepted response lost before the client records it.
- Explicit choice, manual draft, cancellation and draft recovery without ordinary
  document edits accidentally resolving a decision.

Run focused shared-client and Native tests, applicable protocol/conformance gates,
and the relevant [development gates](../../DEVELOPMENT.md). Manually verify macOS
and iPhone presentation, keyboard/focus, VoiceOver, large text, normal publication
and restart. Distinguish built/tested from installed/verified. Follow the documented
Quagmire local development and release workflow if shared editor changes are needed.
Record evidence in docs and status; remove completed tasks from this active plan.

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
- Support fine-grained choices when Canopy actually exposes independent decisions.
  Keep coupled decisions grouped even when their markers appear far apart.
- Explain verified actions such as moves, copies, deletion and hidden-alternative
  edits. Keep uncertain correspondence and unknown authors explicit.
- Offer rule-provided combination previews and richer format-specific controls as
  capabilities arrive. UI improvements must remain compatible with ordinary accepted
  states and existing clients; they must not require a coordinated cutover.
- Verify duplicate paragraphs, moved ranges, split/combined blocks, tables, links,
  fences, selection/IME composition, keyboard navigation and scroll stability in
  both platforms. Extend Quagmire accessories only for concrete needed surfaces.

## Deferred conveniences

Durable inspection caching, complete offline review, bulk resolution, elaborate
provenance visualization and post-acceptance causal undo are not first-release
requirements. Local draft editing may be undone before submission; do not simulate
causal undo afterward by restoring an old whole-tree snapshot. Merge binary design
and operation expansion remain separate work, not prerequisites for this UI.
