# Data 007: Give projection providers one runtime owner

**Status: COMPLETE — 2026-08-28**

## Outcome

Arbor's public node model remains unchanged, but projection ownership now has
one server-side boundary. `ProjectionProviderHost` owns discovery, schemas,
connections, driver resources, and short-lived `ProjectionReadSession` views.
The built-in Markdown, file-rollup, SQLite, and legacy Postgres drivers own
their backing-specific reads, paging, revisions, writes, errors, and cleanup.

`NodeProviderRouter` composes that host with `FilesystemNodeSurface`. It finds
the nearest provider mount by walking logical ancestors, then routes snapshots,
children, and property writes without inspecting backing names. The physical
surface has no provider dependency and remains the fallback for ordinary nodes
and ambiguous provider directories.

Provider writes use one prepared-write boundary. Exact-source files retain
host-journal preparation and atomic commit; SQLite retains row CAS and durable
mutation receipts in the provider transaction; Markdown validation delegates
the final source write to the physical surface. Provider errors are mapped once
at the Arbor Sync property-write boundary.

CSV, JSON, and JSONL local projections and Wire validation share the same pure
source decoder. Wire-specific quotas, schema fingerprints, and trust checks
remain separate.

## Compatibility boundary

This work does not add a new endpoint, node kind, `NodeRef`, capability, query,
or mutation shape. Dynamic manifests, Postgres writes, durable database
observation, replication, checkpoints, and semantic synchronization remain in
Data 004 and 005.
