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
