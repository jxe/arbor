# Data and node-model plans

These plans reconcile Arbor's logical node graph with file and database
representations. Numbers are stable identifiers within this workstream; the
dependency column controls execution order.

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-replicated-store-topology.md) | Add placement-level SQLite projection of Postgres: read-only first, then Arbor-managed bidirectional replication | P2 | DEFERRED — specify now, implement only after the node model is unified | 002; Applications 001 compiler and Canopy execution |
| [002](002-reconcile-node-data-model.md) | Make files, documents, directories, collections, tables, and rows one capability-based node model across every implementation | P1 | IN PROGRESS — refs, snapshots, children, clients, collection endpoint, stable row writes, `ChildProvider`, exact-source file-rollup writes, portable query core/order, and membership dependencies cut over; activation generation, bounded placement, live observation, and Wire projection remain | accepted data-model/format/locators/stores/wire specification |

Plan 002 is the architectural prerequisite. Plan 001 must not introduce a
second row protocol, collection endpoint, replication log, or identity model
while Plan 002 is incomplete.
