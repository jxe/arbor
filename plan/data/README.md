# Data and node-model plans

These plans reconcile Arbor's logical node graph with file and database
representations. Numbers are stable identifiers within this workstream; the
dependency column controls execution order.

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-replicated-store-topology.md) | Add placement-level SQLite projection of Postgres: read-only first, then Arbor-managed bidirectional replication | P2 | DEFERRED — specify now, implement only after the node model is unified | 002; Applications 001 compiler and Canopy execution |
| [002](002-reconcile-node-data-model.md) | Make files, documents, directories, collections, tables, and rows one capability-based node model across local, native, Wire, query, mutation, and sync implementations | P1 | COMPLETE — common node/locator/provider/Wire/query/mutation/public-projection contract delivered; explicit extensions continue in 003–006 and Applications 003 | accepted data-model/format/locators/stores/wire specification |
| [003](003-representation-equivalence.md) | Preserve stable refs, readable paths, links, queries, and mutations when one logical child set changes representation | P1 | PLANNED | 002 |
| [004](004-postgres-child-provider.md) | Replace Postgres virtual nodes with the shared `ChildProvider` and transaction/observation contracts | P2 | PLANNED | 002; Applications 003 activation manifests |
| [005](005-database-observation-and-semantic-sync.md) | Replace whole-database revision stand-ins with transaction snapshots, committed observation cursors, logical effects, and reviewed semantic synchronization | P1 | PLANNED — observation/checkpoint design requires review | 002; 004; 001 for bidirectional projection |
| [006](006-native-offline-rollup-row-projection.md) | Present synchronized CSV/JSON/JSONL rows through native offline replicas | P2 | DEFERRED — preserve Wire rollups losslessly until native offline row browsing is required | 002; Applications 003 execution decisions |

Plan 002 is the completed architectural prerequisite. Plans 001, 003, 004, 005, and 006 must not
introduce a second row protocol, collection endpoint, replication log, identity
model, or query meaning. Representation-path conversion belongs to 003;
Postgres driver/runtime details belong to 004. Cross-database observation and
semantic synchronization belong to 005; no plan may reintroduce an exact
whole-database revision or storage-byte merge.
