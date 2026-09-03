# Postgres project

This project gives Arbor a complete Postgres-backed child surface and then
adds coherent observation and optional local SQLite materializations. It owns
the external-database sequence end to end rather than distributing it across a
generic data theme.

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-child-provider.md) | Complete the Postgres backing behind the provider-neutral child surface | P2 | PLANNED | historical Data 002 and 007; Apps 003 |
| [002](002-observation-and-semantic-sync.md) | Define database snapshots, committed observation, logical effects, checkpoints, and semantic synchronization | P1 | DESIGN REVIEW REQUIRED | 001 |
| [003](003-read-only-sqlite-projection.md) | Materialize a reviewed Postgres query into a rebuildable read-only SQLite placement | P2 | PLANNED | 001; snapshot/observation subset of 002; Apps 003 |
| [004](004-bidirectional-projection.md) | Add offline mutation intent and Arbor-managed bidirectional SQLite/Postgres materializations | P2 | DEFERRED | 001–003 |

The sequence is deliberately one-way: provider, observation and checkpoints,
read-only materialization, then bidirectional mutation. Query and mutation
meaning remain owned by the executable-document contract in the Apps project;
this project must not create a Postgres-specific node, endpoint, or query
language.

Historical [Data 002](../_done/data/002-reconcile-node-data-model.md) owns the
common logical node contract, [Data
007](../_done/data/007-provider-runtime-ownership.md) owns provider runtime
ownership, and [Data 011](../_done/data/011-collection-file-wire.md) owns the
current collection-file object shape and terminology.
