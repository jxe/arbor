# Performance

Joe wants plans for reducing latency, transfer size and storage overhead together.
Take a plan when its stated size or performance problem occurs, and measure both
the benefit and the cost to correctness, recovery and offline use.

| Plan | Why and when |
| --- | --- |
| [006: Sparse iOS placement](006-sparse-ios-placement.md) | When a tree becomes too big to place on the iPhone in one download. Fetch and retain a verified spine, then resolve other files on demand. |
| [003: Fast historical catch-up](003-fast-historical-catch-up.md) | Joe requested this on 2026-10-09 after the iPhone needed several minutes to rebuild an old authored basis. Retain useful historical checkpoints and make unavoidable replay proportional to the edit. |

The shared merge cache (Performance 002) and object packing (overstoryd 001) are
live; what they left is in cleanups:
[retire the earlier merge-cache formats](../cleanups/performance-002-retire-old-merge-cache-formats.md)
and [pack storage follow-ups](../cleanups/overstoryd-001-pack-storage-follow-ups.md).

006 retains its historical Native identifier.
[Client coalescing](../merge/002-identity-preserving-coalescing.md) also reduces
wire traffic but stays with merge work because preserving authored identity is
its central constraint. [Performance ideas](../ideas.md#speed) collects measured
leads, such as directory acceptance cost, that are not yet implementation plans;
merge replay cost is 003's.
