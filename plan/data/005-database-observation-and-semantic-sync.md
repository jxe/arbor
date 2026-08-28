# Data 005: Database observation and semantic synchronization

## Status

- **Priority:** P1
- **Effort:** XL
- **State:** PLANNED — extracted from Data 002 after rejecting whole-database
  exact revisions; the change-log/checkpoint design requires review before
  implementation.
- **Depends on:** Data 002 common node/provider surface; Data 004 for the
  Postgres provider; Data 001 for bidirectional SQLite projections.

## Architectural correction

CSV, JSON, JSONL, and expanded files can name one exact authoritative source
revision. A live database cannot. SQLite main/WAL bytes are unstable storage
state, Postgres has no portable source object, and hashing or rereading every
row to invent a database revision would make ordinary reads unbounded and race
committed writes.

Database providers therefore separate four facts:

```ts
type DatabaseReadBoundary = {
  schema: Hash;
  observedThrough: ProviderCursor;
  transactionSnapshot: unknown; // provider-local and valid only for this read
};

type DatabaseRowSample = {
  ref: ResolvedNodeRef;
  propertiesRevision: string; // CAS token for this logical row
  properties: Record<string, JSONValue>;
};

type DatabaseChange =
  | { precision: "rows"; collection: NodeRef; rows: RowChange[] }
  | { precision: "collection"; collection: NodeRef }
  | { precision: "store"; store: NodeRef }
  | { precision: "schema"; store: NodeRef; schema: Hash };
```

The local transaction snapshot is neither a node revision nor a Wire value.
The provider cursor orders committed observations. Per-row revisions guard
direct edits. Schema fingerprints guard compiled meaning. Membership changes
invalidate affected pages/queries at the narrowest precision the provider can
prove.

## Invariants

1. One node sample or query execution reads schema, rows, and dependency facts
   from one database transaction snapshot.
2. The observer subscribes before sampling or can replay from the pre-read
   cursor, so the first delivered change cannot omit a commit racing the read.
3. Rollbacks and partial statements never advance observation.
4. Arbor-owned transactions publish every direct and cascading logical row
   effect with the same durable mutation receipt.
5. External commits may widen to collection/store invalidation; notification is
   only a wakeup until the driver proves a committed boundary.
6. A page cursor contains its source, ordering, last stable key, schema, and
   observation boundary. It never claims that an entire database has immutable
   revision bytes.
7. A resync rereads through a new transaction boundary. It does not guess lost
   row changes.
8. SQLite and Postgres use the same public node/change/query semantics even
   when their private observation mechanisms differ.

## Decisions still requiring review

### Durable observation source

Choose how observation positions survive restart and how long replay is
retained:

- Arbor transaction/change tables maintained inside the database;
- provider-native commit positions plus an Arbor retention index; or
- a hybrid where Arbor writes are precise and external writes conservatively
  invalidate from a native commit wakeup.

SQLite `PRAGMA data_version`, filesystem events, and Postgres `NOTIFY` are
wakeups, not durable replay cursors. SQLite WAL offsets are not stable across
checkpointing; Postgres LSNs require explicit retention and permission policy.

### Offline synchronization representation

Choose the accepted semantic protocol for local SQLite versus authority data:

- an ordered logical transaction log containing stable row effects and
  constraint intent;
- periodic canonical logical checkpoints plus incremental transactions; or
- checkpoints only initially, with conflicts at the affected collection/store
  boundary.

A checkpoint, if used, is a content-addressed export of schema and logical
rows. It is created for synchronization/recovery, not recomputed as the
revision of every database read, and it never contains SQLite page or WAL
bytes.

### Conflict and constraint ownership

Freeze whether concurrent changes merge row-by-row, field-by-field, or only as
authored transactions. Define primary/foreign-key effects, cascades,
set-null/restrict behavior, generated values, ordered memberships, and how an
offline mutation is reauthorized by the authority. Never infer cascade intent
from an ambiguous diff.

## Implementation phases

### 1. One coherent read boundary

- Add a provider read-session abstraction that begins one SQLite/Postgres
  snapshot before schema validation and row sampling.
- Keep transaction handles private and short-lived; do not cache them between
  HTTP requests.
- Return schema, row CAS tokens, membership sensitivity, and the pre-read
  provider cursor together.
- Retain the last usable compiled schema only as explicitly stale diagnostic
  state after an incompatible DDL change.

### 2. Shared committed-change broker

- Generalize the existing SQLite store broker into the database
  `ChildProvider` boundary rather than opening separate observer, mutation, and
  browsing connections with unrelated state.
- Publish row, collection, store, or schema precision after commit.
- Map every database change to ordinary node refs and tree observation events.
- Define bounded replay, overflow, cursor expiry, and `resync-required`.

### 3. Mutations and receipts

- Route `writeProperties` and named `mutate` through the same broker and
  transaction owner.
- Store semantic retry identity and the committed observation position in the
  transaction domain.
- Return complete direct/cascade effects and make the first observation that
  contains the caller's patch/mutation unambiguous to editors.
- Remove the private SQLite property-receipt table only after the shared broker
  provides equal crash recovery and retention policy.

### 4. Paging and live queries

- Replace whole-table row hashing and database-wide revision-bound cursors with
  stable-key cursors plus observation/sensitivity validation.
- Translate portable filter/field dependencies and relational extensions into
  row/collection/schema sensitivities.
- Prove snapshot-then-follow behavior for inserts, deletes, updates, DDL,
  external commits, cursor expiry, and listener restart.

### 5. Wire checkpoints and semantic synchronization

- Specify a language-neutral canonical checkpoint and incremental transaction
  format, if checkpoints are selected.
- Make Canopy validate schema, identities, constraints, authorization, and
  transaction intent before acceptance.
- Sync logical effects and accepted observation positions; never upload or
  merge live SQLite/Postgres storage bytes.
- Materialize accepted state into a placement's SQLite or Postgres provider and
  prove the isomorphic application invariant after settlement.

## Verification and completion gate

Use the same scenario corpus against SQLite and disposable Postgres: compound
keys, 64-bit values/blobs, foreign keys and cascades, ordered memberships,
concurrent inserts/updates/deletes, external writers, WAL checkpointing, DDL,
observer loss, expired cursors, ambiguous retries, offline divergence, and
authority rejection.

Completion requires a reviewed observation/checkpoint choice, language-neutral
vectors, restart-safe replay, gap-free editor acknowledgement, provider-neutral
query invalidation, and convergence tests. Delete whole-database logical row
hashes, `external:postgres`, stat/file revision stand-ins, and independent
browsing/mutation observer connections only after those tests pass.
