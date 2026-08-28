# Data and node-model plans

These plans reconcile Arbor's logical node graph with file and database
representations. Numbers are stable identifiers within this workstream; the
dependency column controls execution order.

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-replicated-store-topology.md) | Add placement-level SQLite projection of Postgres: read-only first, then Arbor-managed bidirectional replication | P2 | DEFERRED — specify now, implement only after the node model is unified | 002; Applications 001 compiler and Canopy execution |
| [002](002-reconcile-node-data-model.md) | Make files, documents, directories, collections, tables, and rows one capability-based node model across local, native, Wire, query, mutation, and sync implementations | P1 | IN PROGRESS — bounded placement, locator integration, provider hardening, Wire rollups/merge, live observation, and tree-scoped execution routes remain | accepted data-model/format/locators/stores/wire specification |
| [003](003-representation-equivalence.md) | Preserve stable refs, readable paths, links, queries, and mutations when one logical child set changes representation | P1 | PLANNED | 002 |
| [004](004-postgres-child-provider.md) | Replace Postgres virtual nodes with the shared `ChildProvider` and transaction/observation contracts | P2 | PLANNED | 002; Applications 003 activation manifests |

Plan 002 is the architectural prerequisite. Plans 001, 003, and 004 must not
introduce a second row protocol, collection endpoint, replication log, identity
model, or query meaning. Representation-path conversion belongs to 003;
Postgres driver/runtime details belong to 004.
