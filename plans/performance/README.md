# Performance

Joe wants plans for reducing latency, transfer size and storage overhead together.
Take a plan when its stated size or performance problem occurs, and measure both
the benefit and the cost to correctness, recovery and offline use.

| Plan | Why and when |
| --- | --- |
| [006: Sparse iOS placement](006-sparse-ios-placement.md) | When a tree becomes too big to place on the iPhone in one download. Fetch and retain a verified spine, then resolve other files on demand. |
| [003: Fast historical catch-up](003-fast-historical-catch-up.md) | Joe requested this on 2026-10-09 after the iPhone needed several minutes to rebuild an old authored basis. Retain useful historical checkpoints and make unavoidable replay proportional to the edit. |
| [002: Shared merge cache rollout](002-shared-merge-cache.md) | Implemented locally after the iPhone replay loop. Verify the deployed revision and original queued request after Joe pushes. |
| [001: Pack object storage](001-pack-object-storage.md) | When loose objects make storage, startup, audit or backup expensive. Built 2026-10-09 and off by default, as document-grouped zstd frames, chosen on a copy of live data; rehearsal and rollout remain. |

These retain their historical Native 006 and canopyd 001 identifiers.
[Client coalescing](../merge/002-identity-preserving-coalescing.md) also reduces
wire traffic but stays with merge work because preserving authored identity is
its central constraint. [Performance ideas](../ideas.md#speed) collects measured
leads, including merge replay and directory acceptance costs, that are not yet
implementation plans.
