# Canopy storage 002: Adopt composable conflict fragments

Status: DEFERRED by Joe. Resume after the two Native/client goals in
[Reliability 008](../reliability/008-enable-source-operations.md): exact stale-basis
admission and retirement of the rejected-update conflict machine. Fine-grained
storage is not a prerequisite for those goals. Packing remains separate under
[001](001-pack-object-storage.md).

## Evidence and target

The [storage proof](../../docs/conflict-fragment-storage.md) validates a separate
SQLite fragment graph: immutable slices, sequences, directories, absence and
choices, plus accepted state, projection, history and exact retry. It covers hidden
and length-changing edits, independent partial resolution and ancestor deletion.
The production host still uses schema 11 whole-entry decisions. Read the current
source and tests before promoting experimental code.

## Remaining implementation

1. Select the production graph encoding and ownership. Reuse the existing accepted
   transaction and object store; do not import the experiment's parallel authority,
   owner table, receipt API or exact-state-only submission policy. Preserve source
   operation identities separately from immutable content hashes.
2. Bind validated source operations to fragment occurrences. Integrate creation,
   ordinary source/snapshot continuation, hidden-alternative edits and guarded
   partial resolution together. Preserve choices under opaque replacement and
   ancestor changes without enumerating whole-document combinations. A resolution
   discarding descendants must account for those decisions atomically.
3. Extend accepted-state inspection using the existing material references and
   dependency vocabulary. Test hidden nested locations and stale guards. Any needed
   portable change requires paired Swift/TS models, fixtures, specification and API
   documentation; keep the wire ahead of staged implementation where appropriate.
4. Retain hidden graph/source dependencies through backup, integrity checks and
   future collection. Add an offline, history-preserving migration with rollback
   evidence. Rehearse on a copy before coordinating live server activation.
5. Run two independent conflicts in one file through real TS and Swift clients:
   restart, exact retry, hidden edit, length changes, partial resolution, snapshot
   fallback, ancestor change, equal-root transition and transaction faults. Existing
   whole-entry client behavior must remain compatible.

Per-format merge rules own resolution policy. Do not add identity downloads to
ordinary editing, a capability handshake, a versioned API, review caching or
packfiles as dependencies. Selective undo, move/copy correspondence, binary nodes,
directory metadata and mounts require explicit coverage before claiming support.
