# Speed work

These plans remove unnecessary rebuilding, unbounded scanning, and other
demonstrated scale costs.

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-index-updates.md) | Update search and backlink indexes incrementally after moves and deletes | P2 | TODO | soft: Security 001 |

## Smaller items

| Item | State | Promote when |
|---|---|---|
| File-provider exact-source cache invalidation | READY | Add filesystem-driven invalidation and metrics and deduplicate schema/store/Markdown reads while retaining exact complete-key-set validation. Do not extend the cache to database providers. |
| Canopy object reachability index | NEEDS DESIGN | Replace per-request full readable-tree graph scans only with an index whose update and invalidation rules cannot widen object access. Coordinate its access invariant with `security`. |
| Static response caching and render code splitting | READY | Add ETag/cache policy for immutable built assets and measure a split that avoids eagerly loading KaTeX on routes that do not render it. |
| Minimal changed-document reconciliation | CONDITIONAL | Promote only if measured large external rewrites make whole-document `replaceBlocks` disruptive; preserve the first surviving block and cursor rather than optimizing speculatively. |
| Representative cold/warm workspace benchmarks | READY | Measure startup, discovery, indexing, navigation, and resynchronization against checked-in shape distributions before choosing another cache or index. |
| Extension-aware lazy indexing | REVERIFY | Keep deferred indexing from reading known binary, unavailable, or placeholder content; add metrics and hostile-extension fixtures before widening discovery. |

Canopy object and accepted-history packing is now the separate
[Canopy storage project](../canopy-storage/README.md). Whole-table database
hashing is owned by [Postgres 002](../postgres/002-observation-and-semantic-sync.md),
and bounded portable-query evaluation by [Apps
003](../apps/003-development-compiler-and-editor-tooling.md).
