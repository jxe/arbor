# Performance 002: Verify the shared merge cache rollout

**Why and when:** Joe requested shared and compressed cache storage on 2026-10-07,
and on 2026-10-09 requested implementation after the iPhone's queued update became
stuck in repeated server history rebuilds. The implementation and local evidence
are recorded in [shared merge checkpoints](../../docs/architecture/canopyd/merge-cache.md)
and [status](../../status.md). Joe intends to push the candidate himself.

## Remaining work

1. After Joe pushes, confirm the deployed host is running the tested revision and
   packaged sidecar. This is private cache storage; no accepted-data migration or
   client installation is required.
2. With the iPhone open, inspect its original retained request's retry and host
   response. Verify acceptance and incoming convergence, and review any retained
   conflict choice through the existing UI. Do not discard, rewrite or regenerate
   the queued request.
3. Verify the native database is used, old expanded snapshots are superseded,
   and repeated history rebuilds do not cycle. Record live timing and checkpoint
   size separately from local-copy measurements. Record the deployed revision and
   physical-phone result in status, then delete this plan.
4. Retire the earlier formats once nothing deployed holds them. Removing a
   reader early costs a full replay from each chain's start (the 4,200-entry
   rebuild), so record each precondition before the change ships.
   - **Whole-JSON saves (`<tree>/<entry digest>.json`).** Read by
     `SavedStates.read`, and written by the fallback in `Sidecar.save` when the
     database cannot open (`encodeRetainedState`, `decodeRetainedState`).
     - *Precondition:* none remains on the host. Observed on a read-only copy at
       2026-10-09 13:43Z: `merge-cache/tr_owozr6aegt5z7x6qyllvzljl5u/` is empty
       and the cache is `records-v1.sqlite`.
     - *Change:*
       - delete the JSON read path and the write fallback; a database that
         cannot open becomes an empty cache, as a missing cache already is;
       - have `savedStatesIn` delete leftover `<tree>/` directories;
       - drop the two functions once tests and `benchmark-cache.ts` take native
         stores as input.
     - *Status:* the precondition holds, so this can be done in the same push as
       the v2 store.
   - **`records-v1.sqlite`.** Read by `LegacyCheckpointStore` in
     `checkpoint-store.ts` until its checkpoints are removed, then deleted.
     - *Precondition:* after v2 is deployed, the host's cache directory has no
       `records-v1.sqlite`. Normal retention replaces each tree's two
       checkpoints after about 64 replayed entries, or as soon as a basis is
       saved.
     - *Change:* delete `LegacyCheckpointStore` and its test.
