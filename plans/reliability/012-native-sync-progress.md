# Native automatic synchronization makes progress

Priority: P1. Status: remaining investigation; no diagnosed root cause yet.

## Evidence and scope

The [September 15 cutover preflight](../../migrations/006-accepted-state-links/live-cutover.md)
found a durable Mac Native head at generation 50, based on accepted update 1856,
with no prepared attempt or daemon pending request. The UI showed local changes
but retained detail text from the previous successful auto-merge. Manual Sync Now
submitted the exact saved candidate as 1857 and cleared it. The phone was at 1855
and also caught up after manual refresh. Do not assume these share a cause.
Private control snapshots and exact-version comparisons are in the backup directory
recorded in the cutover report. Do not put authored content or credentials in tests.

## Remaining work

1. Trace post-merge local admission, trailing publication, watcher refresh and
   lifecycle/network transitions in UpdateCoordinator/UpdateMachine. Identify why
   the saved head stopped progressing automatically; reconstruct with a minimal
   synthetic interleaving rather than asserting a cause from the symptom.
2. Reproduce the phone's clean-but-stale watcher separately, including sleep/wake.
3. Fix confirmed causes and add focused progress/restart tests. Preserve original
   request identity and authored basis for any transmitted work; never clear a head
   merely because bytes match, or present an older merge as the current edit's result.
4. Verify automatic server acceptance and peer convergence without Sync Now, through
   subsequent edits and a disconnect/reconnect. Keep all cutover recovery evidence.
