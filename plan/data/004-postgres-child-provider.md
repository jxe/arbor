# Data 004: Complete the Postgres projection provider

## Status

- **Priority:** P2
- **Effort:** L
- **State:** PLANNED — extracted from Data 002; not a prerequisite for closing
  the common node model.
- **Depends on:** Data 002 common node model; Data 007 provider runtime;
  reviewed observation and Wire query/mutation routes; Application 003
  activation manifests.
- **Related:** Data 001 read-only SQLite projection and Data 012 bidirectional
  projection.

## Target result

A `_store.yaml` placement using the Postgres driver exposes its database,
relations, and rows through the same `ProjectionProviderHost`, `NodeSnapshot`,
`ChildrenPage`, stable-key, query, mutation, observation, and diagnostic
contracts as expanded, collection-file, and SQLite providers. Postgres is a
placement/provider choice, never a parallel public node ontology.

The placement declares whether authority execution addresses Postgres directly,
a read-only local SQLite projection, or an Arbor-managed bidirectional SQLite
projection. Projection mode remains a placement property, not a property of the
master tree.

## Provider implementation

1. Dispatch `_store.yaml` by reviewed driver and placement configuration. Keep
   credentials and connection material in local secret state; authored YAML
   contains only stable connection references and portable schema policy.
2. Introspect relations, primary/unique keys, ordered foreign-key field pairs,
   nullability, supported constraint actions, scalar normalization, and
   transaction capabilities into the shared provider schema.
3. Separate authored relation names from reversible collision-safe logical
   child segments. Diagnose collisions with physical children, reserved
   `~row-` segments, slashes, spaces, normalization variants, and Unicode.
4. Page rows with primary-key stable refs and transaction-snapshot-bound keyset
   cursors. Remove `external:postgres`, virtual nodes/tables, and unqualified
   offset cursors. Keyless or invalid-key relations remain explicit read-only
   projections with no durable row refs.
5. Produce coherent transaction snapshots containing schema fingerprint,
   provider observation cursor, row CAS tokens, capabilities, and actionable
   diagnostics. Do not invent a whole-database exact revision or require a
   complete model digest for ordinary reads. Retain the last usable
   schema without serving it as current after incompatible change.
6. Implement `writeProperties` only where immutable identity, full candidate
   validation, property CAS, transaction ownership, retry identity, and
   foreign-key checking are proved.
7. Execute named mutations in one Postgres transaction with authorization,
   cascades, ordered memberships, generated values, stable mutation time, and
   same-domain durable receipts.
8. Observe internal and external commits conservatively. Row/field precision
   is an optimization; the provider widens to relation/store invalidation when
   it cannot prove a narrower change.

## Projection modes

Coordinate read-only materialization with Data 001 and bidirectional
replication with Data 012 rather than embedding either here:

- `direct`: authority and permitted local tools query the same Postgres source;
- `sqlite-read-only`: a local SQLite projection supports offline/local reads and
  live refresh but rejects local mutation; and
- `sqlite-replicated`: Arbor owns a bidirectional accepted-intent protocol with
  constraints, conflicts, checkpoints, and convergence.

The same compiled handle must either retain its semantics on every allowed
placement or fail activation before data access. Never silently replace a
Postgres-specific collation, function, join, or constraint behavior with a
different SQLite result.

## Verification and deletion gate

Run the shared provider conformance suite against a disposable Postgres fixture
covering compound/Unicode keys, keyless relations, reserved segment collisions,
64-bit integers, decimals, timestamps, byte values, foreign keys, cascades,
ordered membership, external commits, schema change, cursor expiry, retries,
and concurrent mutations.

Delete all Postgres virtual-node and virtual-table branches only when managed,
untracked/reference, Canopy, query, mutation, observation, and remote browsing
all enter through `NodeProviderRouter` and the new fixture passes. Do not expose
mutable Postgres rows before that gate.
