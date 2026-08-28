# Data and node-model plans

These plans reconcile Arbor's logical node graph with file and database
representations. Numbers are stable identifiers within this workstream; the
dependency column controls execution order.

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-replicated-store-topology.md) | Add placement-level SQLite projection of Postgres: read-only first, then Arbor-managed bidirectional replication | P2 | DEFERRED — specify now, implement only after the node model is unified | 002; Applications 001 compiler and Canopy execution |
| [003](003-representation-equivalence.md) | Preserve stable refs, readable paths, links, queries, and mutations when one logical child set changes representation | P1 | PLANNED | 002 |
| [004](004-postgres-child-provider.md) | Replace the legacy Postgres driver with transaction/observation contracts behind `ProjectionProviderHost` | P2 | PLANNED | 002; 007; Applications 003 activation manifests |
| [005](005-database-observation-and-semantic-sync.md) | Replace whole-database revision stand-ins with transaction snapshots, committed observation cursors, logical effects, and reviewed semantic synchronization | P1 | PLANNED — observation/checkpoint design requires review | 002; 007; 004; 001 for bidirectional projection |
| [006](006-native-offline-rollup-row-projection.md) | Present synchronized CSV/JSON/JSONL rows through native offline replicas | P2 | DEFERRED — preserve Wire rollups losslessly until native offline row browsing is required | 002; Applications 003 execution decisions |
| [007](007-provider-runtime-ownership.md) | Give every projection backing one runtime owner and make Arbor Sync provider-neutral | P0 | COMPLETE | 002 |

Historical [Data 002](../history/data/002-reconcile-node-data-model.md) and
completed [Data 007](007-provider-runtime-ownership.md) are the architectural
prerequisites. Plans 001, 003, 004, 005, and 006 must not
introduce a second row protocol, collection endpoint, replication log, identity
model, or query meaning. Representation-path conversion belongs to 003;
Postgres driver/runtime details belong to 004. Cross-database observation and
semantic synchronization belong to 005; no plan may reintroduce an exact
whole-database revision or storage-byte merge.
