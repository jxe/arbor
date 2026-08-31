# Slow work

These plans remove unnecessary rebuilding, unbounded scanning, and other
demonstrated scale costs. Numbers are stable identifiers within this workstream,
not an execution order.

## Active plans

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-index-updates.md) | Update search and backlink indexes incrementally after moves and deletes | P2 | TODO | soft: Insecure 001 |

## Smaller items

| Item | State | Promote when |
|---|---|---|
| File-provider exact-source cache invalidation | READY | Add filesystem-driven invalidation and metrics and deduplicate schema/store/Markdown reads while retaining exact complete-key-set validation. Do not extend the cache to database providers. |
| Canopy object reachability index | NEEDS DESIGN | Replace per-request full readable-tree graph scans only with an index whose update and invalidation rules cannot widen object access. Coordinate its access invariant with `insecure`. |
| Canopy accepted-history pack encoding | CONDITIONAL | Promote when retained accepted transitions and immutable objects produce material storage or transfer cost. Keep accepted update IDs, per-tree sequence, previous/target roots, transition manifests, and object hashes independent of physical representation; permit Git-like repacking into bounded delta chains with full bases/checkpoints, atomic pack/index replacement, integrity verification, crash recovery, and pruning that never makes a retained root unreconstructable. Do not expose historical objects or make packs part of Wire identity. |
| Static response caching and render code splitting | READY | Add ETag/cache policy for immutable built assets and measure a split that avoids eagerly loading KaTeX on routes that do not render it. |
| Minimal changed-document reconciliation | CONDITIONAL | Promote only if measured large external rewrites make whole-document `replaceBlocks` disruptive; preserve the first surviving block and cursor rather than optimizing speculatively. |

Whole-table database hashing is owned by
[Data 005](../data/005-database-observation-and-semantic-sync.md). Bounded
portable-query evaluation is owned by
[Application 003](../applications/003-development-compiler-and-editor-tooling.md).
