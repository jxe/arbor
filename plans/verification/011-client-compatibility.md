# Verify compatibility across snapshot and operation-aware clients

Split from **Reliability 011 / Sync 011**. This document owns verification only;
[Filesystem 011](../filesystem/011-independent-writes-after-rejection.md) owns the scheduler change.

Status: VERIFICATION BACKLOG; priority selection is open. Establish which compatibility
requirements already have executable evidence and close the remaining gaps. This is not a
request to implement accepted conflicts again. If a check finds missing behavior, record it
against the owning implementation plan rather than hiding a feature project in this checklist.
Live installation and observation gates remain in [release and soak](release-and-soak.md).

## Completed foundation

The [accepted-state cutover](../../migrations/006-accepted-state-links/live-cutover.md),
[Native source cutover](../../docs/native-source-cutover.md) and
[schema-12 authority integration](../../docs/merge-authority-integration.md) record the completed
contract, installed source clients and deployed eight-operation authority. They are not future
implementation steps. Source-range inspection and Native review have subsequent source evidence;
installation/deployment must follow their own recorded gates.

## Compatibility invariant and remaining evidence

Canopy owns alternatives, attribution and resolution on every write path, including snapshots.
Clients retain exact authored bases, immutable requests, unresolved signals and newer local edits.
Accepted ambiguity must not create a local sync hold. Ordinary saves and equal bytes never imply
resolution. Never fall back to a server that discards accepted alternatives.

- Reconcile [accepted-ambiguity scenarios](../../conformance/accepted-ambiguity.json) with the
  actual TS/Swift and live-server tests. They remain semantic requirements until each has an
  executable evidence pointer; do not claim the JSON alone is a conformance gate.
- Keep a baseline snapshot-client build in the release compatibility matrix. Verify it against
  unresolved text, structural and opaque/binary choices: ordinary editing, hidden-alternative
  preservation, restart, same-root watch changes, pending requests and newer local work.
- Verify unknown optional read fields, decision kinds and action labels do not break ordinary
  sync. Unfamiliar review actions must remain unavailable, not acquire invented semantics.
- Preserve whole-batch unsupported-semantics preflight, including an unsupported suffix.
  Definitive rejection retains authored work; uncertain acceptance requires exact retry.
  Never strip operations or resolution declarations from a durable request. Explicit reauthoring
  of definitively rejected work receives fresh identity.
- Complete the inspection evidence matrix: state-bound page tokens, stale pages, metadata-only
  batch continuity, off-page dependencies, historical receipts and alternative-scoped object
  authorization. Do not turn a fixed decision-count cap into an acceptance policy. Map existing
  passing cases before adding tests; inspection failure must not stop ordinary synchronization.
- Validate format-specific projection/actions before enabling new non-text controls. Action
  labels describe review capabilities, not operation codes. Native presentation belongs to 010.
- Verify a rollback policy that stops creating new decisions while retaining, serving and
  resolving existing ones. Preserve historical receipts and rule results.
- Check that old-format experiments are explicitly marked historical or have current
  compatibility evidence. Porting an experiment requires separately selected implementation work.

Server support must be implemented, deployed and verified before a client emits its operation
forms. Record reference/value and resolution semantics, not just recognized operation names.
Later capabilities improve within the existing contract; no capability handshake, version ladder
or another coordinated client cutover is implied. Storage changes retain their own rehearsal.

## Completion

Map each requirement above to an existing or added focused test and its result. Run the
applicable [development gates](../../DEVELOPMENT.md). Record missing behavior as an explicit
implementation follow-up with an owner; do not mark a failing requirement verified merely
because that follow-up exists. Archive this checklist when all selected compatibility gates
have passing evidence or an explicitly accepted scope decision.

[Filesystem 011](../filesystem/011-independent-writes-after-rejection.md) separately owns
scheduling independent work after rejection. Capture, server policy and Native review remain
in [Native 008](../native/008-complete-native-move-copy-undo-capture.md),
[Canopy 009](../canopy/009-canopy-provenance-merges.md) and
[Native 010](../native/010-client-conflict-review.md).
