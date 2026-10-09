# Performance 003: Fast catch-up from an older authored basis

**Why and when:** Joe requested this on 2026-10-09 after the iPhone finally caught
up following the shared-cache deployment, but needed several minutes of server
history replay first. A returning device should merge its retained edits promptly,
including after a worker restart. Smaller cache files and eventual progress are
not sufficient: reduce how much history must be reconstructed and the cost of
reconstructing it when no useful checkpoint survives.

## Baseline and boundaries

Revision `c0a68ebf` stores shared compressed checkpoints and durably preserves
interrupted replay. The deployed host accepted the phone's original request as
update 8670 and its successor as 8671 on October 9; the phone reported current
with unresolved conflicts, and its durable attempt and hold were cleared. Joe
confirmed it caught up. The initial recovery took approximately five minutes,
reconstructing about 4,200 entries for an older authored basis. Ten-second replay
budgets, checkpoint work and client retry delays contributed to elapsed time.
Later ten-second attempts replayed roughly 90–150 entries, versus about 1,190
in an early attempt. The reason for that declining throughput needs profiling;
whole-state copying and growing history scans are candidates, not a diagnosis.

The shared-cache benchmark measured two production-copy checkpoints at 60.7 MiB
combined versus 707.6 MiB expanded JSON, with native cold restores of 1.55–1.66
seconds locally. This did not bound old-basis replay. See
[shared checkpoints](../../docs/architecture/canopyd/merge-cache.md) and
[implementation evidence](../../status.md#shared-merge-cache-and-iphone-replay-recovery--2026-10-09).

Preserve original request/change identities, exact bytes, attribution, operation
lineage, conflict alternatives and resolution semantics. Accepted history remains
the authority; checkpoints remain disposable derived state. Never replace a
missing historical state with today's snapshot, skip unproved history, prune
accepted history, or make an offline device reauthor its pending work. Raising
timeouts or cache limits alone does not satisfy this plan.

## Targets

Establish a reproducible host-class benchmark before implementation, with fixed
CPU/memory limits and separate filesystem-cold and process-cold runs. Initial
acceptance targets for the incident-sized workload are:

- Warm merge of the same returning-device request: p95 below 1 second.
- Restart with usable historical checkpoints: p95 below 5 seconds to answer;
  replay count is bounded by checkpoint coverage, rather than total tree age.
- Empty private cache over approximately 4,200 entries: at least 10 times less
  active reconstruction time than the measured baseline, and no more than
  30 seconds end to end under the same controlled retry schedule.
- At fixed document size and edit size, growing unrelated history from 1,000 to
  10,000 entries increases median replay work per ordinary edit by at most 2x.
- Worker availability includes post-response save/collection, not just evaluation.
  Record memory peaks, checkpoint bytes and other writers' latency alongside
  these targets. Keep the production cache budget as the initial memory setting;
  account for observed RSS as well as the engine's estimate.

These are goals to test, not claims about current behavior. If a target is not
achievable without a semantic change, document the measured limit and discuss
that tradeoff before changing the contract.

## Remaining work

1. **Complete host-class profiling and workload coverage.** Extend the
   [catch-up benchmark](../../tests/performance/benchmark-catch-up.ts) and
   [fixed-edit benchmark](../../tests/performance/benchmark-history-maps.ts)
   with fixed host CPU/memory limits, repeated distributions, filesystem-cold
   runs and the real client retry schedule. Existing local results and copied
   incident evidence are in [status](../../status.md#historical-catch-up-improvements--2026-10-09).
   Add cached-head/missing-basis scenarios, memory eviction and checkpoint-byte
   measurements. Do not commit private content. Include long offline intervals, nested historical bases,
   active conflicts, multiple trees and interleaved fast-forward acceptances.
   Measure ancestry lookup, object reads/bytes, restore and verification, state
   materialization/cloning, history scans, operation evaluation, projection,
   state recording/hashing, save and collection separately. Attribute repeated
   visits/allocations to history length and changed files. Include all retry
   responses and delays in end-to-end timing; report active CPU separately.

2. **Expand historical coverage within a byte budget.** Extend the current
   head/requested-basis retention with a measured policy covering other older
   accepted history. Compare geometrically spaced checkpoints, checkpoints near
   recently requested authored bases, and a small recent set.
   Select by incremental shared-record cost and restore cost, not expanded JSON
   size or manifest count alone. Pin in-flight head/basis/frontier dependencies;
   nested bases and concurrent trees must not evict one another's recovery work.
   Define eviction and collection together, including interrupted publication
   and stale pins. Test long-offline bases that fall between checkpoints and
   beyond the retained window; the fallback must remain correct and progressive.
   Do not promise a bound for every historical basis under finite storage.

3. **Keep checkpoints useful as the tree advances.** Many plain head edits are
   accepted by canopyd without invoking the sidecar. Measure how that affects
   checkpoint coverage before relying on a save every 32 replayed entries.
   Choose bounded incremental advancement from accepted log entries, on demand
   or during idle time, only where it demonstrably reduces subsequent catch-up.
   A background task must yield to foreground updates, have explicit CPU/memory
   and work limits, and never publish an unaccepted candidate as an accepted
   checkpoint. Prewarming is supplementary; empty-cache recovery must meet its
   own target. If ancestry lookup is material, add a verified cache index rather
   than repeatedly walking thousands of entries to locate a usable checkpoint.

4. **Reduce the remaining replay cost.** Exact-basis edits now keep history
   maps lazy and record only their writes. Profile the remaining full node-map
   copies, divergent-history scans and repeated hashing, especially on live
   decisions and snapshot barriers. Extend targeted materialization, indexed
   history queries and reuse of verified facts where they dominate. Measure each
   change against the eager reference engine. Consider partitioning retained
   state by file/subtree only if the simpler changes miss the target; explicitly
   handle cross-file moves/copies, deletions, shared origins and choices whose
   dependencies cross partitions. Preserve semantic identities or prove and
   version any changed private representation before adopting it.

5. **Bound foreground stalls and show progress accurately.** Measure lock hold
   and queue time for other writers during a rebuild, and time until the worker
   can read the next question after sending a retryable answer. Reduce redundant
   checkpoint discovery, hashing and collection where measured; batch or defer
   maintenance with bounded debt and safe publication. Verify correctness if
   the accepted head changes between attempts. Inspect the current client retry
   schedule before proposing changes. If server retry guidance or clearer client
   progress is needed, specify it separately and update TypeScript/Swift models,
   documentation and protocol tests together; do not disguise reconstruction as
   a connectivity failure or trade lower latency for duplicate requests.

## Verification and completion

- Compare roots, decision keys, alternatives, contributions, resolution behavior
  and operation evidence with unchanged eager/full evaluation, across cached,
  restored and fully replayed execution. Cover source edits, moves/copies,
  snapshot barriers, delete/edit choices, root choices and guarded resolutions.
- Extend the existing
  [history differential tests](../../tests/unit/canopyd-merge/history-differential.test.ts),
  [incremental tests](../../tests/unit/canopyd-merge/incremental.test.ts) and
  [replay recovery tests](../../tests/unit/canopyd-merge/saved-states.test.ts).
  Force restart/eviction at each retry boundary, several nested bases, corrupt
  or missing checkpoints, collection during another writer's work, and changing
  heads. Cache deletion must change performance only.
- Use deterministic visit/allocation counters for complexity regressions;
  publish timing distributions from repeated fixed-environment runs rather than
  machine-sensitive unit-test deadlines. Include incremental disk growth and
  memory peaks so avoiding replay cannot hide unbounded storage or retention.
- Run `bun run test:affected` on changed paths, plus `bun run test:protocol` for
  any HTTP route or response change. Rehearse the packaged worker against copied
  state. Deploy only with Joe's go-ahead; verify an actual older-device catch-up
  separately from local benchmark success, without regenerating its request.
- Record the chosen checkpoint policy, measured tradeoffs, before/after results
  and remaining limits in docs/status. Move any install/deploy-only follow-up to
  small work and delete this plan once its implementation is complete.
