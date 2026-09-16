# Reliability 010: Complete contextual client conflict review

Status: READY for interaction design and fixture work; accepted-alternative controls depend on [008](008-enable-source-operations.md) and [009](009-canopy-provenance-merges.md). Priority: P1. [Reliability 004](004-contextual-canopy-conflict-resolution.md) retains the existing inline-placement and crash-hardening work; execute it as the first contextual UI slice, using the current working-tree owner and this protocol.

## Outcome

A person can understand what collided, where it came from, what remains safe to edit, and exactly what their choice will do. Review preserves live work, unresolved alternatives, and unattempted suffixes. The UI presents Canopy's evidence and does not implement an independent merge engine.

Inspect current `ArborWorkingTree` conflict/control/coordinator models, native conflict sheets, Quagmire's source ledger and accessory layout, and daemon-owned filesystem review separately. The native working tree owns app edits; the daemon owns the filesystem head it submitted. Do not resurrect daemon editor admission or import another working tree's pending request or conflict.

Follow [011](011-compatible-accepted-ambiguity.md) for staged activation and the
filesystem independent-work gate. A held edit must not cause a whole-tree sync pause;
review UI limitations must not block safe publication or remote catch-up.

## 1. Make the two states legible

- Distinguish an accepted tree with unresolved alternatives from a rejected candidate awaiting review. Accepted unresolved state stays editable and continues syncing. Rejection identifies the completed prefix, the single failed element, and the untouched suffix.
- Open at the affected source location with enough surrounding content to understand it. Keep a compact tree-level count and navigation between locations; avoid a forced whole-tree “keep mine” workflow.
- Show meaningful author/action provenance when verified: “moved this paragraph,” “edited this copy,” “removed this entry.” Unknown authors and uncertain correspondence must remain explicit. Collapse transport/backend details from the main flow.
- Separate source conflicts, entry/path choices, and unsupported binary/structural cases. Never offer a destructive choice whose operation has no supported contract.

## 2. Build review from authoritative evidence

- Bind every workspace to accepted update identity and complete alternative keys, not just the projected root. Load bounded conflict detail on demand. Durable inspection caching and offline review are deferred conveniences, not prerequisites; preserve user-authored drafts and their guards.
- Show alternatives in context, with source fidelity for tables, lists, frontmatter, fences, links, and raw Markdown. Provide raw-source access where a rich rendering hides relevant differences.
- Offer keep an alternative, combine when Canopy supplies a safe combination, and edit a reviewed result. Preview the exact result and any placement changes before submitting it.
- Editing one alternative is distinct from resolving it. Keep that distinction visible without requiring graph terminology. A matching file hash is never a completed resolution signal.
- Keep manual drafts durably and separately from the accepted projection. Undo local review choices before submission; after acceptance use supported causal undo rather than recreating an old snapshot and claiming equivalent intent.

## 3. Make acceptance and staleness safe

- Persist the choice, guarded `resolves` declarations and authored request before replacing live text. Coupled choices use one atomic candidate, not several request elements. Apply the accepted transition before clearing evidence. Resume unattempted suffixes in order with their original intent and explicit rebase guards.
- If the accepted state or alternative set changes, preserve the draft and explain the newer contribution. Refresh evidence and revalidate; never auto-submit the old resolution against a new state.
- Unrelated typing, cursor/selection, scroll position, and focus must survive refresh and review. A failed submission or unsupported operation leaves all work recoverable.
- Keep review ownership local: a client presents only conflicts from requests it authored. Another working tree's conflict remains in that working tree's review flow and never gates this client.

## 4. Deliver polished native behavior and verification

Use the same interaction vocabulary on macOS and iOS with platform-appropriate sheets and inline controls. Provide keyboard navigation, clear focus, screen-reader labels, non-color status cues, dynamic type, and safe small-screen layout. Avoid exposing implementation choices in ordinary labels.

Build deterministic fixtures for: multiple independent conflicts; long alternatives; duplicate paragraphs; rename/delete cases; hidden alternative edits; same-root metadata changes; stale review; offline/restart at every durable boundary; newer local edits during review; a failed element with a suffix; and independent clients with unrelated conflicts. Add tests for source-to-editor placement and required actions, then manually verify keyboard, selection, screen reader, macOS, and iOS behavior on the built artifact. Follow Quagmire's local test/release discipline. Record exact acceptance evidence and remaining unsupported categories before archiving this plan and completed 004 work.
