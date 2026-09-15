# Native automatic synchronization makes progress

Priority: P1. Status: two reproduced progress failures fixed in a worktree; live verification remains.

## Evidence and scope

The [September 15 cutover preflight](../../migrations/006-accepted-state-links/live-cutover.md)
found a durable Mac Native head at generation 50, based on accepted update 1856,
with no prepared attempt or daemon pending request. The UI showed local changes
but retained detail text from the previous successful auto-merge. Manual Sync Now
submitted the exact saved candidate as 1857 and cleared it. Joe clarified that the phone was suspended and does not sync in the background;
its manual foreground refresh was expected and is outside this investigation.
Private control snapshots and exact-version comparisons are in the backup directory
recorded in the cutover report. Do not put authored content or credentials in tests.

## Remaining work

The [investigation and regression evidence](../../docs/native-sync-progress.md)
records no-work preparation and preparation-error failures. These reproduce the
symptom but do not prove the exact timing of the original incident.

1. Install the tested native fix and verify automatic server acceptance and peer
   convergence without Sync Now through subsequent edits, merges and reconnect.
2. If the stall recurs, capture the in-memory machine phase and preparation error
   before retrying. Diagnose remaining causes with synthetic interleavings.
3. Preserve the original request identity and authored basis for transmitted work;
   keep all cutover recovery evidence. Archive this plan after live validation.
