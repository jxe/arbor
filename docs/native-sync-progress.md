# Native publication progress investigation

September 15, 2026 investigation; status reconciled September 18. The fix is installed
as part of the later [Native source cutover](native-source-cutover.md). Extended
merge/reconnect observation remains in the [release checklist](../plans/verification/release-and-soak.md#observation-and-soak-closeout).

Cutover preflight preserved a durable Mac Native head with no prepared request,
while its status detail still described a previous successful merge. Sync Now
accepted the exact intended bytes. Joe clarified that the phone's refresh was
expected after background suspension; it is not part of this bug.

## Reproduced failure paths

Two coordinator regressions fail before the fix and pass after it:

- A publication pass finds the working tree already acknowledged, so there is
  nothing to submit. Previously it returned without finishing the machine's
  preparation state. A subsequent edit inherited `preparing: true` without a
  publication task and never submitted. The no-work exit now refreshes the
  confirmed machine basis, finishes preparation and cancels obsolete timers.
  It guards against admissions arriving while the working-tree read is suspended.
- Request preparation fails before persistence. Previously that happened outside
  the submission error handler; the background task suppressed the error and left
  preparation active with old status text. Preparation now uses the same failure
  handling as submission. The test preserves the unsent head, reports the failure,
  and confirms reconnect submits its exact candidate successfully.

The first test explicitly acknowledges the working tree before the publication
pass. This establishes the scheduling failure, not a reconstructed trace of the
original incident. The original in-memory machine state and preparation error are
not available, so neither path is claimed as the proven historical cause.

The fix does not clear a pending request, rewrite its digest, discard a saved head,
or alter Wire semantics. Future operation execution must retain the same progress
and durability guarantees.

## Verification and remaining live check

Both targeted regressions demonstrated failures before their corresponding fixes.
All 60 working-tree tests pass, including ambiguous retry, retained successors,
coalescing, restart and fault recovery. The full protocol gate and macOS app build also pass. Repository link/anchor
checks introduce no new broken references, and `git diff --check` passes.

Keep the incident backups. After installing the fix, verify ordinary automatic
Mac edit publication and subsequent edits after merge/reconnect without Sync Now.
If the incident repeats, capture the machine phase and actual preparation error
before a manual retry. The [release checklist](../plans/verification/release-and-soak.md#observation-and-soak-closeout)
now owns that remaining observation; Reliability 012 (completed plan, deleted; see git history)
preserves the historical plan. Phone background syncing is outside scope.

## September 16 durability follow-up

The [editor recovery changes](native-editor-recovery.md) add an independent local
source history, make save acknowledgment wait for durable native head retention,
and enable the Mac's network-path monitor. They also retain admission/sync phase
evidence and protect a keystroke racing an older save acknowledgment. These
address independently verified failure paths; the reported lost offline text
has not been recovered and its exact historical cause remains unproven.
