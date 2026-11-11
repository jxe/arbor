# Postgres 001: collections backed by Postgres, and SQLite projections of them

**Why and when:** longer term. For now the point is that the design shows Postgres backings,
SQLite projections of them and moving a collection between representations are possible.
Nothing is scheduled. Take a stage when a real site needs a database bigger or more shared
than a logical collection.

Rewritten 2026-11-01 (Joe) from five plans, Postgres 001 to 005 (child provider,
observation and semantic sync, read-only SQLite projection, bidirectional projection,
representation equivalence). Those predated logical collections and the schema language:
they spoke of collection files, `_store.csv`, Data 002, 007 and 011, virtual nodes and an
`external:postgres` node kind. Their full text is in git history before that date; the
constraints worth keeping are below.

## Status

- **Effort:** L for stages 1 and 2, XL for stage 3.
- **Risk:** MEDIUM for stage 1 and 2 (read-only, rebuildable). HIGH for stage 3, which must
  converge offline writes without making two data authorities.
- **State:** a direction, with the contract already in the spec
  ([the removed spec text below](#spec-text-removed-2026-11-11))
  and spec deferred items 4 and 5. Not designed in detail.
- **Related:** [Performance 007](performance-007-sqlite-collection-storage.md) (the host
  keeps a collection in SQLite) is separate and nearer.

## What exists (2026-11-01)

- **Moving a collection between representations is solved for logical collections.** Rows
  are logical state in the tree (spec 06 §2), and Markdown rows, CSV, JSON, JSONL and SQLite
  are each placement's projection of them (§2.4). Changing a placement's projection changes
  nothing in the tree: address, rows, logical hash and handles stay (§7). This was most of
  the old Postgres 005.
- **The host's SQLite.** overstoryd keeps a disposable SQLite projection per collection for
  queries and mutations (`HostCollections`, run in the
  [execution sidecar](../../docs/architecture/overstoryd/execution-sidecar.md)); a mutation
  submits row operations as an ordinary update.
- **The Postgres descriptor is specified,** not built: `_store.yaml` (`driver: postgres`, a
  `system:connections/…` reference, a schema) in spec 06 §4, with secrets in the credential
  facility. A tree holding both `_store.yaml` and the legacy `_store.postgres` activates
  neither.
- **A Postgres provider stub.** Story Sync's `PostgresProjectionDriver`
  (`packages/story-sync/src/state/providers/postgres-provider.ts`) lists a schema's tables
  through a stored connection, read-only, with no rows.
- **USL speaks Postgres.** `setupSql(tables, "postgres")` and
  `usl verify … --backend postgres` (`packages/usl`), tested when `USL_TEST_POSTGRES` names a
  server.
- **Observation is specified** for any backing (spec 06 §1.3): coherent read boundaries,
  changes only after commit, precision that may widen but never miss a change.

## Stage 1: Postgres as a collection's backing

A `_store.yaml` collection reads and runs through the same collection contract as a logical
collection: the schema from USL (or introspected and checked against it), rows paged by
primary key under one transaction snapshot, named queries and mutations in one Postgres
transaction each, and observation per spec 06 §1.3 (`NOTIFY` and similar are wakeups only).
Postgres is then the data authority, and the tree synchronizes only the descriptor.

Keep from the old plans:
- Credentials never enter authored content, objects, logs or bundles.
- No whole-database revision or bytes hash; a read names its schema fingerprint and
  observation cursor, and each row a CAS token for direct edits.
- A keyless relation is read-only with no durable row identity.
- A handle either means the same on every placement it may run on or fails activation;
  never substitute a SQLite result for a Postgres-specific collation, function or
  constraint.

## Stage 2: a read-only SQLite projection on a device

Spec 06 §4's `projection: { driver: sqlite, mode: read-only }` in a device placement: the
host evaluates a reviewed, finite query over the store; the placement materializes it into
private SQLite, generation by generation, advancing only after a complete apply; local
queries use the last complete generation offline; every write fails with
`read-only-projection`. Uncertainty, a missed observation or a schema change rebuilds from a
fresh snapshot. It needs no change log, so it can come before stage 3.

## Stage 3: an Overstory-managed store with a two-way projection

Formerly spec deferred 4 and 5: the Overstory logical collection is canonical and Postgres a
host-activated materialization of it (external writes refused); a placement's SQLite takes
offline named mutations as queued intent, re-executed and reauthorized at the host, and
settles through accepted updates. This needs the external-store change log and checkpoint
format (deferred 5) first. It may never be worth it: a logical collection kept in SQLite on
the host (Performance 007) already gives offline queues through Schema language 007.

STOP if it would need two independently writable canonical stores, cross-tree foreign keys,
arbitrary external CDC, or a commit of data, effects, receipt and accepted update that is
not one transaction.

## Stage 4: moving rows between a logical collection and Postgres

Spec 06 §7: a move keeps the collection's address, row identities, child names and handles
only when the schema, keys, child-name rule and every field are preserved. A converter with a
dry run that reports what would change, and a receipt to roll back. Not atomic across two
authorities unless the implementation really makes it so.

## Open, from the old plans

- **Row child names.** `rowPathSegment` (`packages/protocol/src/model/node-key.ts`) uses a
  single string key raw when it is a valid path component, else `~row-<base64url>`. It does
  not exclude reserved child names (`schema.usl`, `_store.*`) or non-NFC keys the way
  `childName` does. Either prove the raw rule collision-free or make the segment uniform
  (probably with the readable key token of spec 03 §2). Settle before stage 4.
- **Scalar values.** One language-neutral projection of booleans, nulls, bytes, wide
  integers, decimals and timestamps across rows, queries, mutations and observation, in
  TypeScript and Swift. Partly done by USL's types; check Postgres's wider types against it.

## Read-only placement projections (moved from spec 06 §4, 2026-11-11)

Also moved out by Joe: Story Sync's Postgres provider today connects directly, reads tables
and pages by offset (which spec 06 §1.2 forbids for live data); none of this projection exists.

A device placement may instead request a private SQLite projection in its
[accounts and devices](../../docs/overstory-spec/3.1-accounts-and-devices.md):

```yaml
projection:
  driver: sqlite
  mode: read-only
```

`read-only` is the first portable projection mode. The host evaluates a reviewed
node query over the remote store, supplies a coherent typed snapshot and
snapshot-then-follow invalidation boundary, and the placement materializes that
logical result into private SQLite. Local queries may use the last completely
applied projection while offline. Mutations and direct SQLite writes fail with
`read-only-projection`; reconnect reevaluates current state, so this mode does
not need retained mutation history or two-way CDC. Projection query plans,
applied output hashes/model hashes, SQLite/WAL bytes, and local paths are
private placement state.

The projection manifest declares a finite schema-complete node scope. Bootstrap
may page that scope under one consistent snapshot and observation boundary; it
does not require encoding the whole database as one public query-result value.
After uncertainty or a missed observation, the driver conservatively rereads
affected scopes or rebuilds from a fresh snapshot before advancing its applied
root.

## Two-way placement projections (moved from spec 06 §4, 2026-11-11)

Joe moved this out of the spec because nothing builds it (the spec is normative). It is the
design the spec had for `mode: bidirectional`; spec README Deferred item 4 points here.

`mode: bidirectional` requests the later full-duplex contract
(spec Deferred 4). It is permitted
only when the host has activated the external store as an Overstory-managed
materialization: the Overstory logical data tree is canonical, external Postgres
writes are denied, accepted named mutations atomically record the resulting
scoped model hash, accepted update, and receipt with their Postgres effects,
and local SQLite publishes reviewed mutation intent or complete candidate
updates. Host activation is an
operational trust decision, not authored tree content or placement projection
type. A host that cannot provide it rejects the placement capability rather
than degrading to Postgres-authoritative CDC.

In bidirectional mode, a local named mutation is durably queued as reviewed
intent before provisional SQLite execution. Authority reauthorization and
re-execution occur against current accepted state; one accepted logical update
includes every direct, trigger, and foreign-key cascade effect. A direct local
SQLite edit has no intent and is submitted as candidate logical state through
tree updates; ambiguous cascades or constraint interactions conflict. Direct
external writes to the managed authority Postgres are unsupported.

## Spec text removed 2026-11-11

Joe took external stores out of the spec until Postgres is built (2026-11-11). The chapter as it stood, for when it comes back:

### 1. Postgres and placement projections

`_store.yaml` is the driver-dispatched, non-secret external-store descriptor.
For Postgres it contains:

```yaml
version: 1
driver: postgres
connection: system:connections/production
schema: public
```

The referenced system record contains a safe label, stable non-secret store
identity, and connection metadata; its DSN, password, and equivalent secrets
remain in the credential facility. `_store.yaml` selects the logical external
store and schema. It never selects a local representation. A tree containing
both `_store.yaml` and the legacy `_store.postgres` is ambiguous and does not
activate either descriptor.

Every execution placement connects directly to
the declared Postgres store and must resolve the same stable store identity.
Postgres is then the shared data authority. Overstory introspects schemas, maps each
runtime-owned transaction to Postgres, and observes committed changes; the authored
tree synchronizes the safe descriptor rather than a database copy.

A device placement's private SQLite projection of an external store, read-only
or two-way, is deferred.

External Postgres observation treats notifications only as commit wakeups, never as the data authority or a durable replacement for rereading state. On listener loss, overflow, unknown payload, or cursor discontinuity, the driver widens invalidation and reestablishes a fresh snapshot boundary. A connection without precise observation must conservatively invalidate and cannot claim precise live updates.

### 2. Backing adapters

An external store ([§1](#1-postgres-and-placement-projections-1)) is not a logical collection: it is the data authority, and database reads carry
a schema fingerprint, a provider-local transaction snapshot for the duration of
the read, each row's model hash as what a write must match, and an ordered
observation cursor. It never consists of database page, WAL, or provider
storage bytes.

A conforming backing adapter supplies:

- schema discovery or validation;
- ordered reads and stable row identity appropriate to the backing;
- guarded write primitives through which the mutation runtime realizes its
  transaction contract;
- change observation without treating partial writes as commits;
- a consistent read snapshot and ordered committed-observation boundary;
- actionable diagnostics while preserving the last fully usable schema/view.

A provider computes model hashes only where doing so is bounded and useful. A
database row can cheaply expose one for guarded writes, while a live database
does not maintain a whole-table model hash. Freshness for an unbounded or live
backing is expressed with its committed observation cursor instead.

- **Pagination.** Live or mutable pagination uses a provider-bound keyset
  cursor, never an unqualified offset. It binds the cursor to the schema
  fingerprint, ordering, last stable key, and an observation boundary that can
  detect expiry or relevant committed change. It never hashes the complete
  database.
- **Identity-less rows.** A read-only collection may expose synthetic
  positional paging keys, but those node references have a null stable key and
  are not durable identities; handles cannot use them for mutation or durable
  references. Duplicate, missing, invalid, or noncanonical declared keys are
  diagnostics and disable mutation rather than falling back to position.

#### 2.1 Read boundaries and committed change observation

Every backing read is associated with a coherent read boundary and returns the
observation cursor it read through. External-store adapters hold a provider-local transaction snapshot only for the read;
they do not expose a whole-database bytes hash or model hash. A backing observer yields changes only
after the corresponding transaction commits and supplies a cursor from which
the runtime can establish a snapshot-then-follow boundary. Rollbacks and
partial statements produce no visible change.

An observation has the narrowest precision the driver can prove:

```ts
type BackingChange =
  | { precision: "rows"; collection: string; rows: RowChange[] }
  | { precision: "collection"; collection: string }
  | { precision: "store" };

type RowChange = {
  key: unknown;
  operation: "insert" | "update" | "delete";
  changedFields?: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};
```

These shapes describe information, not a required JSON or driver API. Missing keys, fields, or before/after images widen invalidation; they never permit the runtime to skip a possibly affected query. Schema, relationship, collation, and access changes invalidate every dependency that relies on the changed contract.

The runtime must conservatively identify every committed change that may alter a query's public result. Optimization may not change the authored handle or observable result.

For a runtime-owned mutation, the backing adapter normally knows exact affected collections, primary keys, and changed fields. External writers may provide less information. A conforming adapter may degrade from row precision to collection or whole-backing invalidation, but it must not miss an externally committed change. Observation precision is an optimization and cannot change query results.
