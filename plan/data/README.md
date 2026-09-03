# Data and node-model plans

This workstream contains only unfinished work. Completed milestones live in
[`plan/history/data`](../history/data/README.md). Numbers are stable identifiers,
not execution order; the groups and explicit dependencies below describe what
can actually happen next.

Historical [Data 011](../history/data/011-collection-file-wire.md) owns the
current terminology, canonical collection-file object shape, TypeScript/Swift
cutover, conformance checkpoint, migration 002, and decoder closeout. Its
scheduled backup-age cleanup does not keep an executor plan active. No active
plan should extend the legacy encoding.

## Representation and identity

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [003](003-representation-equivalence.md) | Preserve stable identity, explicitly account for readable-name changes, and prove logical equivalence when a child set changes backing | P1 | PLANNED | completed 011 |
| [008](008-locator-identity-surfaces.md) | Give stable keys one spelling per surface and one segment-parameter grammar | P2 | PLANNED | 003; remove-later 001 |
| [006](006-native-offline-collection-file-projection.md) | Present synchronized collection-file rows through native offline replicas | P2 | DEFERRED until product need | completed 011; Applications 003 execution decisions |

## Database backings and projections

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [004](004-postgres-child-provider.md) | Complete the Postgres backing behind the provider-neutral child surface | P2 | PLANNED | completed 002 and 007; Applications 003 |
| [005](005-database-observation-and-semantic-sync.md) | Define database snapshots, committed observation, logical effects, checkpoints, and semantic synchronization | P1 | DESIGN REVIEW REQUIRED | 004 |
| [001](001-read-only-sqlite-projection.md) | Materialize a reviewed Postgres query into a rebuildable read-only SQLite placement | P2 | PLANNED | 004; snapshot/observation subset of 005 |
| [012](012-bidirectional-database-projection.md) | Add offline mutation intent and Arbor-managed bidirectional SQLite/Postgres materializations | P2 | DEFERRED | 001; 004; 005 |

The database sequence is deliberately one-way: provider, observation and
checkpoints, read-only materialization, then bidirectional mutation. This
removes the former circular dependency between Data 001 and Data 005.

## Shared boundaries

- Historical [Data 002](../history/data/002-reconcile-node-data-model.md) owns
  the common logical node contract; completed
  [Data 007](../history/data/007-provider-runtime-ownership.md) owns provider
  runtime ownership.
- Representation conversion belongs to Data 003; locator spelling belongs to
  Data 008; neither creates a new identity model.
- Postgres adapter behavior belongs to Data 004. Database change observation
  and synchronization artifacts belong to Data 005.
- Query semantics and mutation transaction semantics belong to the executable
  document contract, not to child backings or this planning taxonomy.
- No plan may introduce a parallel row endpoint, collection ontology,
  backing-specific query meaning, exact whole-database revision, or
  storage-byte merge.
