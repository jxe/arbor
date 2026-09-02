# Data 001: Materialize a read-only SQLite placement projection

## Status

- **Priority:** P2
- **Effort:** L
- **Risk:** MED — the projection is rebuildable and never accepts writes, but
  stale or mixed-generation reads would violate executable-document semantics.
- **State:** PLANNED
- **Depends on:** Data 004 Postgres backing, the snapshot/observation subset of
  Data 005, and Applications 003 activation manifests
- **Unblocks:** offline reads for larger hosted applications; Data 012

## Target result

An authored `_store.yaml` may identify a shared Postgres backing while one
device placement requests:

```yaml
projection:
  driver: sqlite
  mode: read-only
```

The placement materializes a reviewed, schema-complete logical node query into
private SQLite. Local execution may read the last completely applied result
offline. Named mutations and direct SQLite writes fail explicitly. The
projection is a cache of one external authority, not another data authority and
not authored tree content.

## Invariants

- Projection configuration belongs to the device placement, never
  `_store.yaml` or the logical node model.
- The SQLite path, pages, WAL, indexes, readiness, and recovery state remain
  placement-private.
- Every readable generation binds source TreeID, reviewed query, schema
  fingerprint, complete output hash, and observation boundary.
- Bootstrap is snapshot-then-follow with no read/watch gap. Ambiguity,
  observation loss, schema change, corruption, or partial apply forces a fresh
  coherent rebuild before the applied marker advances.
- The same compiled query produces the same public value directly from
  Postgres and from the applied SQLite generation.
- No local write is queued, provisionally applied, or synchronized by this
  plan.

## Implementation

1. Add placement parsing and diagnostics for the exact read-only projection
   shape; reject unknown drivers, modes, multiple projections, and projections
   outside an activated data scope.
2. Resolve the safe `_store.yaml` connection reference and stable non-secret
   store identity without copying credentials into authored or projection
   state.
3. Compile a finite schema-complete node query and create SQLite schema from
   the provider-neutral schema IR rather than copied Postgres DDL.
4. Apply each complete result into a new generation, validate it, then
   atomically advance the applied marker. Never expose an in-progress
   generation.
5. Implement reconnect, cursor expiry, rebuild, disk-full, corrupt-state,
   revoked-access, removal, and offline-last-good behavior.
6. Expose readiness and read-only capability through existing provider-neutral
   node/query surfaces without creating a projection endpoint or row ontology.

## Verification

Use equivalent Postgres and SQLite fixtures with compound and Unicode keys,
foreign keys, decimals, timestamps, bytes, nullable values, schema change,
concurrent source change during bootstrap, cursor loss, crash during every
apply phase, corruption, disk full, revoked access, and wrong store identity.
Prove query equality at one pinned execution identity and prove that no DSN,
raw private row, or SQLite file enters authored content, Wire objects, logs, or
public bundles.

## Completion gate

A placement can be created, brought fully current, used offline for the same
reviewed queries, rebuilt after every uncertainty, and removed without changing
the logical data tree or external Postgres state. Every write surface remains
explicitly unavailable.

## STOP conditions

- A coherent snapshot and observation boundary cannot be established.
- Serving a partially applied or schema-mismatched generation would be needed.
- Implementation requires a projection-specific query, node, identity, or
  endpoint.
- Credentials or physical database state would enter authored or Wire state.
