# Postgres 004: Add Arbor-managed bidirectional database projections

## Status

- **Priority:** P2
- **Effort:** XL
- **Risk:** HIGH — offline writes, authority replay, database effects, accepted
  updates, and two physical materializations must converge without creating two
  data authorities.
- **State:** DEFERRED — begin only after the read-only projection and semantic
  database synchronization contracts are complete.
- **Depends on:** Postgres 001–003; executable-document
  transaction and activation contracts

## Target result

One Arbor logical data `TreeID` is canonical. Authority Postgres and each local
SQLite placement materialize its accepted logical state. A placement declaring
`projection: { driver: sqlite, mode: bidirectional }` remains usable offline,
accepts provisional reviewed mutation intent, and later converges through
authority reauthorization, deterministic re-execution, accepted updates, and
watch. Physical Postgres/SQLite replication and arbitrary Postgres CDC are not
used.

Postgres is the authority transaction engine only after explicit host
activation. Direct external Postgres writes are refused. SQLite pages and WAL
remain private materializations; neither is synchronized as tree content.

## Execution identity

Every local and authority execution binds the same source tree/root, document
and handle version, data TreeID and complete root model hash, schema
fingerprints, user context, logical mutation time, and deterministic generated
ID namespace. A runtime never serves or mutates a materialization at another
generation.

## Required protocol

1. Define canonical logical database checkpoints and committed effect records
   under Postgres 002. They contain normalized logical nodes, keys, schemas,
   relationships, and transaction boundaries—not database storage bytes.
2. Add authority Postgres metadata for mutation identity, receipt, accepted
   update, checkpoint/effect position, and materialized model hash. Commit them
   atomically with every direct, trigger, and foreign-key effect.
3. Persist reviewed local intent before provisional SQLite execution. Preserve
   its exact handle/input, deterministic context, base generation, and ordering
   across restart.
4. Reauthorize and re-execute intent at the authority. Exact retry produces one
   effect and one receipt; changed intent under the same identity conflicts.
5. Reconcile accepted, merged, rejected, authorization-changed, schema-changed,
   and resync outcomes without losing later queued intent.
6. Treat a direct local SQLite edit as candidate logical state only where its
   complete effects and constraints are unambiguous; otherwise reject it. Never
   import arbitrary Postgres writes through CDC.
7. Expose provisional, settled, conflicted, rebuilding, and unavailable states
   through existing provider-neutral capabilities.

## Verification

Exercise online and offline named mutations, multiple queued intents, ambiguous
response retry, restart at every persistence boundary, disjoint and same-row
concurrency, parent-delete/child-insert races, cascades, deferred cycles,
authorization and schema changes, watch loss/resync, corrupt materialization,
and multiple devices. Prove SQLite and Postgres converge to the same logical
model and query results and that no credential or physical database state
crosses the authored/Wire boundary.

## Completion gate

The same application runs locally and on Canopy at one accepted logical state;
offline named mutations settle exactly once after reconnect; all physical
materializations converge; constraints and public results agree; and crash
recovery loses no acknowledged or provisional intent.

## STOP conditions

- Two independently writable canonical stores would be required.
- Data, complete effects, receipt, and accepted update cannot commit in one
  authority transaction.
- Deterministic mutation context cannot survive offline replay.
- SQLite and Postgres would expose different portable constraint or query
  behavior.
- Cross-tree foreign keys, cross-domain atomicity, or arbitrary external CDC
  becomes necessary.
