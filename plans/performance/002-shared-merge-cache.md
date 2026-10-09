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
4. Retire the whole-JSON checkpoint format (`<tree>/<entry digest>.json`).
   - Today the sidecar still reads it and, when the database is unavailable, still
     writes it (`SavedStates.read`/`write`, `encodeRetainedState`,
     `decodeRetainedState`).
   - **Precondition:** on the deployed host, every tree's retained checkpoints are
     native rows in `records-v2.sqlite`, and no `.json` file remains under
     `merge-cache/`. A native write removes its own JSON duplicate; retention
     removes the rest. Record when that held.
   - **Change:**
     - Delete the JSON read path and the JSON write fallback. A store that cannot
       open is treated as an empty cache (replay), as a missing cache already is.
     - Have `savedStatesIn` delete any leftover `<tree>/` JSON directories on
       startup.
     - Remove `encodeRetainedState`/`decodeRetainedState` once tests and
       `benchmark-cache.ts` no longer need them as an input format. The benchmark
       can take saves from `tests/performance/storage/merge-cache-fixture.ts`
       re-emitted as native stores.
   - **Risk:** a host that still has only JSON checkpoints replays from each
     chain's start once. That is slow (the 4,200-entry rebuild), so do not ship
     the removal before the precondition is recorded.
