# Data 001: Add placement-selectable Postgres/SQLite projections

> **Executor instructions:** This plan is deliberately deferred. Do not begin
> implementation until Data 002 has removed the parallel collection/row model
> and the Supplies compiler binds executable documents to logical data-tree
> identities. When activated, read this entire plan, re-run the drift audit,
> and implement each phase without reviving Postgres-authoritative two-way CDC.

## Status

- **Priority:** P2
- **Effort:** XL
- **Risk:** HIGH — this adds offline relational writes, cross-runtime
  convergence, and a second durable materialization without allowing two data
  authorities.
- **State:** DEFERRED
- **Depends on:** Data 002; Applications 001 compiler/manifest, local execution,
  and Canopy activation
- **Unblocks:** optional large hosted applications that retain offline local
  operation while materializing authority data in Postgres

## Target result

One authored application and one logical data identity run isomorphically in
two staged projection modes:

- first, a read-only SQLite projection of a shared remote Postgres store for
  typed local/offline reads, built through the generic node-query algebra; and
- later, an Arbor-managed logical data `TreeID` with bidirectional SQLite
  placements and Postgres authority materialization.

The full-duplex target runs:

- locally, against an app-private SQLite materialization that remains usable
  offline and accepts provisional named mutations;
- on the authority, against Postgres at the same accepted model state;
- with identical components, scripts, compiled handles, row identities,
  constraints, and backing-independent query/mutation results for the same
  source revision, data revision, user, and inputs; and
- with bidirectional convergence through Arbor accepted updates and watch, not
  through database-specific replica protocols.

Postgres is a materialization and transaction engine for an Arbor-canonical
logical data tree. It is not an independently writable upstream authority.
Option 4 from the architecture discussion—arbitrary Postgres writes captured
through CDC and reconciled back into Arbor—is explicitly absent.

## Store declaration and placement projection

Rename the provider descriptor from `_store.postgres` to `_store.yaml`. The
reserved filename describes the logical store or external authority selected
by the tree; its contents name the driver. This leaves room for future safe
store descriptors without reserving one filename per database engine.

For Postgres:

```yaml
version: 1
driver: postgres
connection: system:connections/production
schema: public
```

Do **not** put `local`, `projection`, or `topology` in `_store.yaml`. Whether a
placement connects to the declared store directly or maintains another
physical representation is a property of that placement. Extend the device
placement entry in the account-configuration tree instead:

```yaml
placements:
  "tr_<data-tree-id>":
    server: "https://community.example"
    path: "/Users/joe/Documents/Supplies Data"
    projection:
      driver: sqlite
      mode: read-only
```

Rules:

- Without `projection`, an execution placement resolves `_store.yaml`
  directly. For Postgres, every direct placement resolves the connection to
  the same stable provider store identity and uses the shared state.
- `projection.driver: sqlite` creates a placement-private SQLite
  materialization. `mode: read-only` consumes coherent remote data and never
  publishes local database changes. `mode: bidirectional` additionally permits
  provisional named mutations and candidate updates; it is the deferred
  full-duplex topology.
- Projection mode belongs to one device placement, not authored application
  state. Devices may choose direct, read-only SQLite, or bidirectional SQLite
  behavior without changing the source/data tree root seen by others.
- A read-only projection may mirror a shared Postgres authority through a
  reviewed generic node query without changing which store is canonical.
- A bidirectional projection is available only when Canopy has activated the
  Postgres store as an Arbor-managed materialization. In that mode the
  enclosing Arbor data tree is canonical and authority Postgres plus each
  SQLite database materialize its accepted states. This activation is
  host policy, not authored content or placement projection type.
- `connection` remains a safe system reference. DSNs, passwords, TLS material,
  and platform credentials never enter the authored tree, manifest, update,
  object graph, receipt, log, or diagnostic.
- A connection record exposes a stable non-secret store identity. Shared mode
  refuses to run when two placements resolve the authored reference to
  different identities.
- The local SQLite path is placement-private and derived from `TreeID`; it is
  not another authored `_store.sqlite3`, is not included in the tree snapshot,
  and is never byte-synchronized.
- Unsupported projection drivers or modes, multiple projections, or a local
  materialization outside a promoted data tree are source-located diagnostics.

## Isomorphism invariant

Define one execution identity:

```ts
type ExecutableState = {
  sourceTree: TreeID;
  sourceRoot: Hash;
  document: LogicalPath;
  manifest: Hash;
  data: Array<{
    tree: TreeID;
    modelDigest: Hash;
    schema: Hash;
  }>;
  user: ProfileID | null;
};
```

For the same `ExecutableState` and inputs, a conforming local or authority
runtime returns the same public query values, mutation validation, generated
IDs, logical time, constraint behavior, and public errors. Physical SQL query
plans, database bytes, indexes, vacuum state, and connection topology are not
observable application semantics.

Every materialization records at least:

- source/data `TreeID` and stable external store identity where applicable;
- applied model digest or query output hash and either its accepted
  update/watch cursor or query observation boundary;
- schema fingerprint and codec/runtime version;
- last completely applied transaction cursor; and
- whether recovery or rebuild is required.

A runtime never evaluates an application against a materialization whose
recorded model digest differs from the digest bound into the execution state. It waits,
reconnects, or reports a typed unavailable state instead of serving mixed
source/data generations.

## Canonical logical data and physical materializations

Data 002 defines canonical row nodes, collection/table child nodes, stable row
keys, schema-scoped model digests, and rollup objects. Reuse them exactly.
Replicated topology adds no new identity or row envelope.

The `modelDigest` used in this plan is the schema-scoped digest for one declared
data tree/materialization domain. It is not an accepted Wire projection root or
a universal serialization or hash of the global Arbor TreeID space.

The logical history contains:

- normalized row properties and optional content/children;
- stable collection-scoped keys and paths;
- schema and relationship identity;
- transaction boundaries and every direct/cascading row effect; and
- enough immutable logical objects or checkpoints to bootstrap a new
  materialization and resolve every retained accepted root.

It does not contain Postgres heap/index bytes or SQLite page/WAL bytes.
Postgres and SQLite drivers translate the same logical transaction into their
physical representations and attest the resulting scoped model digest.

## Portable schema and foreign keys

Extract the current SQLite-only `StoreSchema` from
`packages/data/src/schema.ts` into a backing-independent schema contract. It
must include:

- normalized scalar types and nullability;
- primary and alternate unique keys;
- foreign-key field pairs in declaration order;
- `ON DELETE` behavior for the portable subset: `restrict`, `cascade`, and
  `set-null`;
- transaction-end constraint validation, including deferred cyclic inserts;
- indexes needed for declared relationships and deterministic ordering; and
- explicit collation, comparison, and default semantics where they affect
  observable behavior.

Primary keys are immutable. `ON UPDATE CASCADE` and `SET DEFAULT` are outside
the first replicated contract. A foreign key may cross collections/tables only
within the same logical data tree and transaction domain. A cross-tree Arbor
reference is a typed link, not a transactional foreign key.

Compile this contract independently to SQLite and Postgres DDL and introspect
both results back into the same canonical fingerprint. Reject a schema when
either backing cannot preserve its semantics. Never silently inherit different
database defaults.

## Mutation model

### Shared Postgres

Both local and authority executions call the same reviewed `mutate` handle
against the same Postgres transaction domain. The existing exactly-once
mutation identity, user scope, input digest, deterministic IDs/time, receipt,
and commit-only observation rules apply. This mode has no offline write queue.

### Read-only SQLite projection

The first projected milestone evaluates a reviewed generic node query over the
remote store, applies one coherent result to a placement-private SQLite
database, then uses a provider snapshot-then-follow contract for invalidation
and replacement. Queries and components may run offline at the
last completely applied result/root. SQLite is opened query-only to ordinary
application execution; named mutations and external writes return
`read-only-projection`. Reconnect reevaluates current state rather than replaying
a mutation log. This phase proves projection fidelity, schema equivalence,
isomorphic reads, and generic query coverage without requiring Arbor-canonical
data history or bidirectional conflict handling.

### Authority mutation in replicated mode

One Postgres transaction:

1. authenticates and resolves the reviewed source/handle/data roots;
2. recovers or rejects a prior use of the mutation identity;
3. executes the handler against current accepted logical state;
4. lets Postgres enforce all portable constraints and cascades;
5. records every final row effect, including trigger/cascade effects;
6. constructs and validates the new scoped model digest;
7. records the accepted update, mutation receipt, and new applied-root marker
   in reserved `__arbor_*` tables in the same transaction; and
8. publishes watch/query invalidations only after commit.

Keeping accepted data-tree history and the authority materialization marker in
the same Postgres transaction avoids a false dual-write acknowledgement.
Canopy may index or mirror the accepted record after commit, but the provider
transaction is the durable source for this data tree's ref and receipt.

### Local offline named mutation

The local runtime:

1. freezes the reviewed handle version, validated input, user, mutation ID,
   base model digest, logical time, and deterministic generated-ID seed;
2. durably appends that intent before modifying SQLite;
3. executes it provisionally in one SQLite transaction with the same schema and
   constraints;
4. records the provisional logical effects/root and presents them locally;
5. submits the original named intent—not merely the resulting SQLite bytes or
   row diff—to authority `POST .../mutate` when connected;
6. lets the authority reauthorize and re-execute against current accepted
   state; and
7. applies the accepted result from watch, confirming or reconciling the local
   provisional chain.

Queued mutations are ordered. If one is rejected or produces a different
accepted result, rebuild the local materialization from the accepted root and
replay later still-valid intents in order. Never silently reinterpret a later
intent against a state its local execution did not observe.

### Direct local SQLite edits

An edit performed through an ordinary SQLite tool has no reviewed mutation
intent. The observer forms a logical candidate update from a consistent
transaction snapshot and submits it through `POST .../updates`. The authority
may three-way merge stable row nodes, then validates the complete merged schema,
foreign keys, uniqueness, and ordered relations. Any ambiguous cascade,
constraint interaction, or incomplete observation is a conflict.

Direct writes to the authority Postgres materialization are unsupported in
replicated mode. Use a database role that denies application-external writes to
managed tables. Detect unexpected changes, stop acknowledgement/serving for the
affected root, and require explicit repair; do not import them as CDC updates.

## Update, watch, and query integration

- `POST /.arbor/trees/{SourceTreeID}/mutate` carries named executable intent.
  Its receipt identifies the affected data tree, accepted update, exact Wire
  projection root, and gap-free observation cursor; the materializer derives
  and verifies the scoped model digest.
- `POST /.arbor/trees/{DataTreeID}/updates` carries candidate logical tree state
  from direct materialization edits or ordinary replica synchronization.
- `GET /.arbor/trees/{DataTreeID}/watch` is the single accepted-history stream
  used by every materializer.
- `QUERY /.arbor/trees/{SourceTreeID}/queries` binds the complete source and
  mounted data revisions and scoped model digests. A query stream may use local SQLite or authority Postgres
  only after proving the same execution identity.
- Query results and mutation receipts may arrive in either order. The accepted
  data-tree update, exact Wire root, and watch cursor are authoritative.

## Bootstrap, placement, and removal

Read-only projection:

1. Resolve `_store.yaml`, the stable remote provider identity, and the reviewed
   schema-complete projection query.
2. Evaluate one coherent result, create a private SQLite database, record its
   schema/output hash and query observation boundary, then subscribe before
   exposing it.
3. Reject all writes while continuing to serve the last completely applied
   result offline. Reevaluate and rebuild from current query state after a gap,
   schema change, or integrity failure.

Bidirectional activation and bootstrap:

1. Create/promote the logical data tree and freeze its canonical schema.
2. Import existing Postgres through a read-only consistent snapshot into one
   initial accepted data-tree state; this is a reviewed mode transition, not
   ongoing CDC.
3. Install reserved metadata, receipt, accepted-update, and effect tables and
   bind Postgres to that root transactionally; deny external writers.
4. Rebuild the SQLite projection from the accepted tree snapshot and begin
   watch strictly after its cursor before enabling mutations.
5. Rebuild a corrupt or too-old materialization from a fresh snapshot; retain
   unsent mutation intents as recoverable drafts until explicitly reconciled or
   discarded.

Removing a projected placement deletes only its private SQLite materialization
and caches after recoverable intents have been exported or explicitly
abandoned. It never deletes the logical tree or authority Postgres data.

## Implementation phases

### Phase 0 — freeze vectors before runtime code

- Add language-neutral fixtures for logical schemas, compound row keys,
  transaction effect sets, foreign-key cascades, scoped model digests, mutation intent,
  accepted receipts, materialization markers, and invalid projection YAML.
- Include equivalent SQLite and Postgres datasets that must produce the same
  schema fingerprint, scoped model digest, queries, and mutations.
- Add negative vectors for collation drift, unsupported defaults, missing
  stable store identity, cross-tree foreign keys, and materialization-root
  mismatch.

### Phase 1 — descriptor, placement schema, and activation

- Rename `_store.postgres` recognition to the driver-dispatched `_store.yaml`;
  diagnose both files coexisting rather than silently choosing one.
- Extend synchronized placement parsing for
  `projection: { driver: sqlite, mode: read-only | bidirectional }`.
- Resolve credentials through the existing system connection facility and
  verify stable provider identity without logging secrets.
- Extend compiler manifests and Canopy activation with required provider,
  materialization drivers, schema fingerprint, and resource bounds.
- Show placement projection mode and readiness in diagnostics/UI without
  exposing DSNs.

### Phase 2 — portable schema compilers

- Move schema IR out of the SQLite executor.
- Preserve foreign-key actions and deferred semantics during introspection.
- Add Postgres introspection/DDL equivalence tests using an explicitly supplied
  test DSN; never claim live Postgres coverage when it is absent.
- Generate local SQLite schema from the canonical IR rather than copying
  Postgres DDL text.

### Phase 3 — read-only local SQLite projection

- Store private materializations beneath Arbor's private state, keyed by
  `TreeID` and placement/device.
- Compile a provider-neutral, schema-complete node query that selects the
  projection; do not require a database-only relation root.
- Apply each coherent complete result idempotently and validate its output hash
  before advancing the local observation marker.
- Open application access query-only and reject both named and external writes.
- Implement query snapshot-then-follow bootstrap, reconnect reevaluation,
  rebuild, disk-full handling, and explicit removal/recovery.
- Keep materialization bytes, WAL, caches, and provisional tables out of authored
  snapshots and search.
- Verify unchanged Supplies components and queries locally and on Canopy at the
  same source revision and scoped model digest before enabling any local write path.

### Phase 4 — model digests and checkpoints

- Implement canonical row/collection/subtree objects from Data 002.
- Build incremental model-digest updates from committed effect sets and periodic full
  checkpoints for bootstrap/integrity verification.
- Prove that different SQLite/Postgres physical layouts produce the same digest.
- Bound snapshot, object, and retained-history sizes and report quota errors
  before partial acceptance.

### Phase 5 — authority Postgres coordinator

- Add reserved metadata, mutation receipt, accepted-update, object/checkpoint,
  and transaction-effect tables.
- Extend Postgres mutations with deterministic context and complete trigger-
  visible effect capture.
- Commit data, scoped model digest, receipt, and accepted update atomically.
- Publish tree watch and query invalidation after commit, with exact replay and
  crash injection at every boundary.

### Phase 6 — bidirectional SQLite projection and offline intent queue

- Gate this phase on `projection.mode: bidirectional`.
- Switch the projection from query-result observation to accepted logical data-
  tree snapshot/watch, preserving the same schema and logical node identities.
- Persist named intents before provisional execution.
- Reuse stable IDs/time and exact input across retries and process/device
  restarts.
- Reconcile accepted, merged, rejected, authorization-changed, and
  schema-version-changed outcomes without losing later intents.
- Surface provisional/settled/conflicted state to local React and native hosts.

### Phase 7 — execution and product parity

- Bind local executable documents to SQLite and Canopy documents to Postgres
  through the same compiled handles.
- Exercise the same source revision and scoped data model digests through local
  web, signed macOS Arbor, and canonical Canopy URLs.
- Add placement controls for downloading/removing a local SQLite materialization
  and explain its offline/storage implications.
- Keep shared-Postgres mode available when no placement projection exists.

## Source areas expected to change

- `spec/06-stores.md`, `spec/07-executable-documents.md`, `spec/04-wire.md`
- `packages/core/src/protocol.ts`
- `packages/data/src/schema.ts`, `mutation.ts`, `observer.ts`, `live.ts`, and
  SQLite executor modules
- new Postgres query/mutation/materialization modules in `packages/data`
- `packages/stores/src/collections.ts` and `connections.ts`
- `packages/wire/src/updates/*`, `packages/canopy/src/updates/*`, Canopy durable
  data-tree state, and watch routing
- `packages/arborsync` placement, private-state, query, mutation, and sync paths
- `packages/client`, `packages/render`, `ArborClient`, `ArborSync`,
  `ArborProviders`, and `ArborKit` readiness/provisional-state surfaces
- conformance fixtures and focused unit/integration/native/browser tests

Do not implement a standalone database replication daemon or reuse physical
Postgres/SQLite replication formats.

## Verification matrix

Automated acceptance must cover:

- identical schema fingerprint and scoped model digest on SQLite and Postgres;
- anonymous and authenticated query parity at one pinned execution identity;
- authority mutation, local online mutation, local offline mutation, multiple
  queued mutations, retry after lost response, and restart recovery;
- compound foreign keys, deferred cyclic inserts, restrict, cascade, set-null,
  uniqueness, ordered membership, and every cascading effect in one update;
- concurrent disjoint rows, same-row conflict, parent-delete/child-insert race,
  authorization change, and schema change;
- watch gap/resync and exact mutation causal acknowledgement;
- Postgres/Canopy crash before and after every transaction/finalization point;
- local crash before intent, after intent, after provisional SQLite commit,
  during accepted apply, and before cursor advance;
- direct local SQLite edit admission and direct authority Postgres write refusal;
- corrupt materialization rebuild, disk full, unavailable credentials, wrong
  stable store identity, and revoked access;
- local web, two browser contexts, signed macOS host, and relaunch; and
- proof that no DSN, password, raw private row, or private materialization file
  enters source, wire objects, logs, public bundles, or test artifacts.

Run focused suites throughout, then the repository typecheck/build/tests,
protocol conformance in TypeScript and Swift, exact macOS/iOS builds required by
the native plan, and a real Postgres matrix only when an explicit disposable
test DSN is available.

## STOP conditions

Stop and return to design review if:

- implementation requires two independently writable canonical data stores;
- a local SQLite mutation cannot retain reviewed intent and deterministic
  context across authority replay;
- data and accepted-root/receipt state cannot commit in one authority Postgres
  transaction;
- a portable schema has observably different constraint, collation, default,
  or ordering behavior between SQLite and Postgres;
- an execution state can be served from a materialization at another model
  digest;
- cross-tree foreign keys or cross-domain atomicity become necessary;
- direct Postgres writes must be imported through CDC;
- credentials or private materialization paths would enter authored content;
  or
- Data 002's generic node/children protocol would need a parallel row endpoint.

## Completion gate

With `_store.yaml` declaring Postgres and a device placement declaring
`projection: { driver: sqlite, mode: bidirectional }`, the unchanged Supplies-
style application runs from one source revision and one logical data state in
local Arbor and on Canopy. It remains usable for reads and named mutations while
offline, later reconciles through authority execution and accepted watch
updates, and converges to the same rows and query results as Postgres. Foreign
keys and cascades have identical semantics, retries create one effect, crash
recovery loses no acknowledged or provisional intent, and no unsupported
Postgres-authoritative CDC path exists.
