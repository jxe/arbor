# Stores and collections
*Part of the [Arbor spec](../spec.md): backing-independent child behavior over Markdown, CSV, JSON, JSONL, SQLite, external stores, and placement projections.*

## Common collection contract

A collection is not a separate logical node kind. It is a node whose immediate
children share a declared record schema, stable identity rules, and provider
operations. Each row is an ordinary child node: its columns project as node
properties, it may additionally have content or children, and inserting or
deleting the row creates or removes that child. Generic node/children APIs
therefore browse a collection; query handles provide filtered, related, or
derived result sets rather than a parallel row ontology.

A collection is addressed by its logical folder path. Its backing is selected inside that folder and may change without changing the collection's locator, schema-facing API, views, executable-document handles, or durable row identities when the migration preserves their primary-key values.

Collection enumeration is ordinary paginated child enumeration. A protocol may
offer a collection-shaped projection for columns, tables, or bulk query results,
but it does not require a second collection-page resource to identify or browse
rows. Such a projection returns the same row node references and revisions as
the generic node surface.

A conforming store supplies:

- schema discovery or validation;
- ordered reads and stable row identity appropriate to the backing;
- atomic row mutations within that backing's transaction boundary;
- change observation without treating partial writes as commits;
- a consistent read snapshot and ordered committed-observation boundary;
- actionable diagnostics while preserving the last fully usable schema/view.

Portable collection queries and mutations have the same meaning across backings. Backing-specific relational operations may exist only where the addressed database provides them and must be identified as backing-coupled.

### Scoped model digests and physical representations

Expanded child files and rolled-up child sets are representations of the same
logical nodes. `_store.csv`, `_store.json`, and `_store.jsonl` represent the
enclosing node's immediate schema-governed children. `_store.sqlite3` may
represent a table's immediate rows or a database container's table/row subtree.
The provider exposes those children through ordinary node and children APIs;
reserved store files are not themselves row children.

For expanded files and CSV/JSON/JSONL rollups, the exact representation
revision and the schema-normalized, store-scoped model digest are separate.
This digest is defined for the collection/subtree schema;
it is not a universal serialization or hash for all Arbor trees. Reformatting
JSON or CSV advances exact authored tree state without changing row identity or
the scoped digest. A representation migration may preserve the digest while
changing exact bytes. Updates name the complete candidate tree and may carry
compact patches to representation bytes, but the authority decodes
base/current/candidate under quotas, merges by stable node identity where safe,
validates the complete schema and constraints, and computes the accepted model
digest itself.

A live SQLite or Postgres database has no corresponding exact representation
revision. Database reads instead carry a schema fingerprint, a provider-local
transaction snapshot for the duration of the read, per-row CAS revisions, and
an ordered committed-observation cursor. A database may export a canonical
logical checkpoint for synchronization or recovery, but that checkpoint is not
the revision of ordinary reads and never consists of database page, WAL, or
provider storage bytes.

### Queries over collections

The query language—its portable baseline of predicate filtering, explicit field
picking, and cardinality; its capability extensions for relationships, joins,
aggregates, authored ordering, and pagination; plan-callback confinement; and
the one-transaction-per-mutation rule—is specified once in
[executable documents](07-executable-documents.md#queries). A database relation
or schema-governed collection is a typed node set within that language, not a
separate query universe. A provider may compile a plan to SQL or another native
plan but cannot change its meaning, and an unsupported extension fails before
data access.

This specification adds only the facts a store owns:

- **Row identity.** A mutable collection's declared primary key is the
  stable-key rule for its children. It must be stable, non-null,
  serializable, and independent of row position, SQLite `rowid`, display
  label, or query plan. A row's third reference component is its canonical key
  JSON as defined by
  [locators](03-locators.md#stable-keys-revisions-and-fragments); each key
  field's Standard Schema output must be a JSON string, boolean, or finite
  number, and a backing value not exactly representable in one of those forms
  is normalized to a string by the schema first. Changing a key is observed as
  removal of one child and creation of another. A row's logical child segment
  is its single string key when that is a valid nonempty logical path component
  not beginning with the reserved `~row-` prefix; otherwise it is `~row-`
  followed by the unpadded base64url encoding of the canonical row key.
- **Ordering.** Rollup and database rows enumerate in canonical stable-key
  order, falling back to canonical path, using the portable comparison; a
  backing's default collation is not an acceptable substitute. Where a
  relational extension supplies explicit ordering, the proved stable key is the
  deterministic final tie-breaker.
- **Pagination.** Live or mutable pagination uses a provider-bound keyset
  cursor, never an unqualified offset. A file rollup binds that cursor to its
  exact source and schema revision; a database binds it to the schema
  fingerprint, ordering, last stable key, and an observation boundary that can
  detect expiry or relevant committed change. It never hashes the complete
  database.
- **Identity-less rows.** A read-only collection may expose synthetic
  positional paging keys, but those node references have a null stable key and
  are not durable identities; handles cannot use them for mutation or durable
  references. Duplicate, missing, invalid, or noncanonical declared keys are
  diagnostics and disable mutation rather than falling back to position.
- **Constraints.** Portable mutable schema includes primary and alternate
  unique keys, ordered foreign-key field pairs, nullability, and explicit
  constraint actions. Primary keys are immutable. The first portable
  foreign-key subset supports `restrict`, `cascade`, and `set-null` on delete,
  validated at transaction end so declared deferred or cyclic inserts succeed.
  `ON UPDATE CASCADE`, `SET DEFAULT`, and backing-default collation or coercion
  are not portable. A foreign key may cross collections only inside one logical
  data tree and one transaction domain; a cross-tree Arbor reference is a typed
  authored property value, not a transactional foreign key. A named mutation's
  accepted transaction contains all direct and cascading row effects; Arbor
  never invents cascade intent for an ambiguous concurrent file edit or
  imprecise database invalidation, and cross-file foreign-key atomicity is not
  implied.

### Revisions and committed change observation

Every store read is associated with a coherent read boundary. File stores name
an exact source revision. Database stores hold a provider-local transaction
snapshot only for the read and return an ordered observation cursor; they do
not expose a whole-database revision. A store observer yields changes only
after the corresponding transaction commits and supplies a cursor from which
the runtime can establish a snapshot-then-follow boundary. Rollbacks and
partial statements produce no visible change.

An observation has the narrowest precision the driver can prove:

```ts
type StoreChange =
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

For a runtime-owned mutation, the store driver normally knows exact affected collections, primary keys, and changed fields. External writers may provide less information. A conforming driver may degrade from row precision to collection or whole-store invalidation, but it must not miss an externally committed change. Observation precision is an optimization and cannot change query results.

Mutation retry identity and its completed result are recorded in the same transaction domain as the data effects, or by an equivalent crash-recoverable mechanism that can distinguish a completed commit from an unexecuted intent after restart. Reusing one mutation identity with different handle code, caller, or validated input is a conflict. Generated IDs and captured mutation time remain stable across an exact retry.

## File-backed collections

A file-backed collection contains `schema.ts` exporting
`export const schema = z.object(...)`, an optional declared primary key, and
exactly one row representation:

```ts
import { z } from "zod"

export const schema = z.object({
  id: z.string(),
  title: z.string(),
})

export const primaryKey = ["id"] as const
```

- Markdown row files other than `_index.md`;
- one `_store.csv`;
- one `_store.json`; or
- one `_store.jsonl`.

`primaryKey` is required for mutation and durable row references. It names one or
more required schema properties in tuple order. Omitting it leaves CSV and
JSON/JSONL rows as read-only positional projections; Markdown rows may use their
durable `id` identity when the schema explicitly includes `id`. A key field is
immutable under an ordinary row update.

`_store.csv` uses its header for property names. `_store.json` is one top-level
JSON array whose elements are row objects; an ordinarily named `something.json`
remains an ordinary content node. `_store.jsonl` has one JSON object per
nonblank line. Markdown frontmatter supplies properties and the
Markdown body supplies optional content; `id`, path, and content remain
available through the common node projection rather than a separate Markdown-
row API.

CSV, JSON, and JSONL mutations are atomic at the whole-file transaction boundary. A
driver locks and revision-checks the source, validates the complete key set and
requested effects, writes and fsyncs a complete replacement, atomically renames
it, fsyncs the containing directory where supported, and records retry
completion in the same crash-recoverable workflow before acknowledgement.
`writeProperties` additionally compares the sampled row-properties revision;
the complete candidate property map must preserve its declared key. A logical
no-op leaves the source byte-identical. A direct row-property write cannot add,
remove, or reorder rows.
Multi-row mutations preserve row order unless the mutation
explicitly changes ordered membership. JSONL drivers preserve untouched line
bytes; JSON drivers preserve untouched value formatting where the source edit
model can prove it; CSV drivers preserve header/column order and unknown fields,
while the exact quoting of a changed record may be canonicalized. Partial files and
rolled-back attempts never become observable committed states.

After an external file change, the driver reparses and compares rows by primary
key. It publishes exact row changes when it can prove them and otherwise widens
to collection invalidation. Reordering lines does not change identity.

Mixing backing shapes produces a diagnostic and disables collection-level interpretation without making the underlying files inaccessible. Invalid rows are diagnostics, not daemon crashes or silent deletion.

The schema evaluator accepts the authored schema and its declared schema-library import under the [no-ambient-authority rule](07-executable-documents.md#authored-component-forms), with finite resource bounds. This specification does not prescribe evaluator technology or generated-file layout.

## SQLite

`_store.sqlite3` makes the enclosing folder SQLite-backed. If `schema.ts` selects a collection/table, the folder is that collection; otherwise each introspected user table appears as a child collection of a database container. An ordinarily named `.sqlite3` file remains browsable as a database node but does not absorb its enclosing folder.

SQLite remains canonical and usable by ordinary SQLite tools. Row mutations
run in SQLite transactions. Observation occurs at committed boundaries and
snapshots are database-consistent; a live main database and WAL are never
treated as unrelated files or assigned an exact source revision. A provider
may widen an imprecise concurrent change to collection/store invalidation, but
must not manufacture a whole-database revision by hashing all rows or storage
bytes.

External-write observation must detect committed changes made through other processes or connections. When affected rows cannot be recovered precisely, the driver emits a whole-store invalidation after the external commit. A wakeup alone is never treated as proof of a committed row change.

A server-hosted SQLite executable document coordinates committed writes with accepted updates for the containing tree, durably records mutation completion before acknowledgement, and advances the tree only from a consistent database state. Changing backing at the same logical database path does not change portable handles.

## Postgres and placement projections

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

With no placement `projection`, every execution placement connects directly to
the declared Postgres store and must resolve the same stable store identity.
Postgres is then the shared data authority. Arbor introspects schemas, runs
mutations in Postgres transactions, and observes committed changes; the authored
tree synchronizes the safe descriptor rather than a database copy.

A device placement may instead request a private SQLite projection in its
[configuration](05-configuration.md):

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
applied output hashes/model digests, SQLite/WAL bytes, and local paths are
private placement state.

The projection manifest declares a finite schema-complete node scope. Bootstrap
may page that scope under one consistent snapshot and observation boundary; it
does not require encoding the whole database as one public query-result value.
After uncertainty or a missed observation, the driver conservatively rereads
affected scopes or rebuilds from a fresh snapshot before advancing its applied
root.

`mode: bidirectional` requests the later full-duplex contract. It is permitted
only when the host has activated the external store as an Arbor-managed
materialization: the Arbor logical data tree is canonical, external Postgres
writes are denied, accepted named mutations atomically record the resulting
scoped model digest, accepted update, and receipt with their Postgres effects,
and local SQLite publishes reviewed mutation intent or complete candidate
updates. Host activation is an
operational trust decision, not authored tree content or placement projection
type. A host that cannot provide it rejects the placement capability rather
than degrading to Postgres-authoritative CDC.

External Postgres observation treats notifications only as commit wakeups, never as the data authority or a durable replacement for rereading state. On listener loss, overflow, unknown payload, or cursor discontinuity, the driver widens invalidation and reestablishes a fresh snapshot boundary. A connection without precise observation must conservatively invalidate and cannot claim precise live updates.

In bidirectional mode, a local named mutation is durably queued as reviewed
intent before provisional SQLite execution. Authority reauthorization and
re-execution occur against current accepted state; one accepted logical update
includes every direct, trigger, and foreign-key cascade effect. A direct local
SQLite edit has no intent and is submitted as candidate logical state through
tree updates; ambiguous cascades or constraint interactions conflict. Direct
external writes to the managed authority Postgres are unsupported.

## Data disclosure

Collection access and executable-document result access are distinct. Publishing a component or query result does not make the backing tree, SQLite file, Postgres connection, or unrelated rows readable. Conversely, putting public and private rows in a publicly readable Arbor tree exposes the backing bytes regardless of query filters. Sites containing row-private data keep the raw data boundary private to the source tree's execution principal or split data into separate Arbor trees, then expose only validated query results.

## Schema identity

Schema information and explicit relationship declarations are mapped to canonical tree-rooted collection paths so executable source remains portable across placements. Relative collection references resolve against the source tree and path before use. A database schema, file schema, or relationship change changes the corresponding schema fingerprint and invalidates dependent compiled handles. Derived declarations, caches, and introspection artifacts are not authored tree content or portable artifacts.

## Store migration

Replacing Markdown/CSV/JSON/JSONL rows with `_store.sqlite3`, or replacing one
supported representation/provider with another, preserves the logical
collection address, stable row identities, and portable operations when schema
and primary-key values are preserved. Exact representation revisions may
change while the scoped model digest remains equal. The transition is not atomic
across independent backing authorities unless the implementation actually
provides that guarantee.
