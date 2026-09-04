# Child backings
*Part of the [Arbor spec](../spec.md): backing-independent child behavior over Markdown, CSV, JSON, JSONL, SQLite, external stores, and placement projections.*

*Owns: how expanded files, collection files, SQLite, Postgres, and later
external providers supply logical child sets; backing-specific revisions,
snapshots, observation, and physical commit behavior; placement projections;
and representation migration. Query and transaction semantics belong to
[executable documents](07-executable-documents.md).*

## 1. Common collection contract

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
rows. Such a projection returns the same row node references and match values as
the generic node surface.

A conforming backing adapter supplies:

- schema discovery or validation;
- ordered reads and stable row identity appropriate to the backing;
- guarded write primitives through which the mutation runtime realizes its
  transaction contract;
- change observation without treating partial writes as commits;
- a consistent read snapshot and ordered committed-observation boundary;
- actionable diagnostics while preserving the last fully usable schema/view.

### 1.1 Child backings

The logical child set is independent of its backing. The portable backing
categories are expanded files, a collection file, a database, and an external
store. `_store.csv`, `_store.json`, and `_store.jsonl` are collection files:
each represents the enclosing node's complete, immediate, schema-governed,
property-only child set. `_store.sqlite3` is a database backing and may
represent a table's immediate rows or a database container's table/row subtree.
The provider exposes all of them through ordinary node and children APIs;
reserved representation files are not themselves logical children.

A child-backing summary may expose the observed category and format, but it is
capability metadata rather than identity. A collection-file summary may carry
an exact source revision, schema fingerprint, and child-set hash. A database
summary instead carries a schema fingerprint and observation boundary; it must
not invent a whole-database bytes hash or model hash.

Reformatting JSON or CSV changes the bytes hash and not the model hash,
and a representation migration may preserve the digest while changing every
byte ([data-model equality](01-tree-operations.md#representation-and-model-equality)). Updates name the complete candidate tree and may carry
compact patches to representation bytes, but the authority decodes
base/current/candidate under quotas, merges by stable node identity where safe,
validates the complete schema and constraints, and computes the accepted model
hash itself.

A live SQLite or Postgres database has no bytes hash. Database reads
instead carry a schema fingerprint, a provider-local transaction snapshot for
the duration of the read, each row's model hash as what a write must match, and an
ordered observation cursor. A database may export a canonical
logical checkpoint for synchronization or recovery, but that checkpoint is not what an
ordinary read matches on and never consists of database page, WAL, or
provider storage bytes.

### 1.2 Member identity, order, and pagination

A backing preserves these logical child-set facts:

- **Row identity.** A mutable collection's declared primary key is the
  stable-key rule for its children. It must be stable, non-null,
  serializable, and independent of row position, SQLite `rowid`, display
  label, or query plan. A row's third reference component is its canonical key
  JSON as defined by
  [locators](03-locators.md#2-stable-keys-revisions-and-fragments); each key
  field's Standard Schema output must be a JSON string, boolean, or finite
  number, and a backing value not exactly representable in one of those forms
  is normalized to a string by the schema first. Changing a key is observed as
  removal of one child and creation of another. A row's logical child segment
  is its single string key when that is a valid nonempty logical path component
  not beginning with the reserved `~row-` prefix; otherwise it is `~row-`
  followed by the unpadded base64url encoding of the canonical row key.
- **Ordering.** Collection-file and database rows enumerate in canonical stable-key
  order, falling back to canonical path, using the portable comparison; a
  backing's default collation is not an acceptable substitute. Where a
  relational extension supplies explicit ordering, the proved stable key is the
  deterministic final tie-breaker.
- **Pagination.** Live or mutable pagination uses a provider-bound keyset
  cursor, never an unqualified offset. A collection file binds that cursor to its bytes hash and schema fingerprint; a database binds it to the schema
  fingerprint, ordering, last stable key, and an observation boundary that can
  detect expiry or relevant committed change. It never hashes the complete
  database.
- **Identity-less rows.** A read-only collection may expose synthetic
  positional paging keys, but those node references have a null stable key and
  are not durable identities; handles cannot use them for mutation or durable
  references. Duplicate, missing, invalid, or noncanonical declared keys are
  diagnostics and disable mutation rather than falling back to position.

### 1.3 Read boundaries and committed change observation

Every backing read is associated with a coherent read boundary and returns the
observation cursor it read through. Collection files also name a bytes hash.
Database adapters hold a provider-local transaction snapshot only for the read;
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

## 2. File-backed collections

A file-backed collection contains `schema.ts` exporting
`export const schema = z.object(...)`, an optional declared primary key, and
exactly one row representation:

```ts
import { z } from "zod"

export const schema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
})

export const primaryKey = ["id"] as const

// Optional. Omission derives logical names from the primary key.
export const childName = { from: "property", property: "slug" } as const
```

- Markdown row files other than `_index.md`;
- one `_store.csv`;
- one `_store.json`; or
- one `_store.jsonl`.

`childName` is an optional deterministic logical-name rule for compact
backings. It is either `{ from: "primaryKey" }` or
`{ from: "property", property: <schema property> }`; omission means
`primaryKey`. The selected schema-normalized value must produce one valid
logical `Name`.

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

CSV, JSON, and JSONL rows carry properties only. A conversion from expanded
Markdown must therefore reject a child with content or children unless a later
target format explicitly represents those parts; equal keys alone do not make
a lossy conversion model-equivalent.

### 2.1 Accepted Wire representation

An expanded directory represents immediate children with separate entries. A
collection-file directory instead keeps many logical children in one physical
authored file:

```text
Physical entries below /books:
  _store.json  → sourceHash
  schema.ts    → schemaHash

Logical children below /books:
  alice
  bob
```

The entry hashes prove and preserve the two files' exact bytes, while the
directory's `childrenSource` descriptor supplies their logical
interpretation. Its shape is defined with the
[Wire directory](01-tree-operations.md#112-reading-an-accepted-snapshot).
The descriptor fields have these meanings:

| Fields | Meaning |
|---|---|
| `version`, `type` | Select this descriptor contract. |
| `format`, `source` | Select the physical collection file and parser for its exact bytes. |
| `schemaSource` | Select the physical schema file used to interpret the rows. |
| `schemaFingerprint` | Commit to the exact UTF-8 bytes of the selected schema source. |
| `childSetHash` | Commit to the normalized logical children derived from the collection file and schema. |

A conforming authority validates the descriptor in this order:

1. Require `source` and `schemaSource` to name two ordinary file entries in
   the same directory, and require `source` to agree with `format`.
2. Load the exact source and schema bytes through those entries' hashes.
3. Recompute `schemaFingerprint` from the exact schema bytes, then evaluate
   `schema.ts` in the restricted application-code runtime.
4. Parse the collection file, then validate and normalize every row with that
   schema.
5. Derive every row's stable key and logical name using the schema's
   `childName` rule.
6. Canonically order the resulting `{ key, name, properties }` values and
   recompute `childSetHash`.
7. Reject a missing or multiply claimed source, an invalid row, key, or name,
   or either derived-hash mismatch.
8. Expose the normalized rows as the directory node's complete immediate
   logical child set. Preserve `source` and `schemaSource` as physical authored
   entries, but do not expose them as logical children.

The three relevant hashes identify different things. `childSetHash` identifies
only the decoded child-set contribution. The enclosing node's model hash also
covers its properties, content, and child schema. The Wire root identifies the
exact authored object graph. A formatting-only edit can therefore change the
Wire root while leaving both logical hashes unchanged.

Database-backed placements are not decoded through a
`CollectionFileDescriptor`; database pages and WAL files are never
`WireObject` values. Their snapshot, observation, and synchronization rules are
the database contracts below.

### 2.2 File writes and observation

When the mutation runtime commits a collection-file write, the adapter realizes
that commit as one guarded whole-file replacement. It locks the source, checks
its bytes hash, validates the complete key set and requested effects, writes and
fsyncs a complete replacement, atomically renames it, and fsyncs the containing
directory where supported. Retry identity and acknowledgement remain owned by
the mutation contract.
A [property write](01-tree-operations.md#22-what-the-write-matches) on a row must
match the row's model hash and must preserve the declared key. A logical no-op leaves the source byte-identical. A direct row-property
write cannot add, remove, or reorder rows.
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

The schema evaluator accepts the authored schema and its declared schema-library import under the [no-ambient-authority rule](07-executable-documents.md#2-authored-component-forms), with finite resource bounds. This specification does not prescribe evaluator technology or generated-file layout.

### 2.3 Accepted update validation and merge

When a candidate changes a recognized collection file, the submitted root
names the exact lossless encoding of that candidate tree state. The authority
decodes coherent base, current, and candidate representations under schema and
resource bounds, recomputes logical row identities and `childSetHash`, applies
`collection-file-rows-v1` to a conflicting collection file, validates all keys,
foreign keys, and constraints, and encodes the accepted representation. It
never trusts a client-supplied schema fingerprint or child-set hash.
Formatting-only changes advance the accepted root without changing
`childSetHash`, so they invalidate no logical query dependency.

The update setting `ifMatch: "modelHash"` compares the complete model hash of
every touched logical node, not the collection file's narrower `childSetHash`.
The latter is used while decoding and merging the node's child-set
contribution. SQLite and Postgres changes instead use the database transaction,
observation, and semantic-checkpoint contracts; live database storage bytes are
never submitted or merged as a collection-file object.

Authorities advertise collection-file, schema, and row quotas and never accept
a collection file they cannot validate completely. Semantic merge reports
`collection-file-row-conflict`, `collection-file-schema-conflict`, or
`collection-file-constraint-conflict`; a row conflict path uses the parent
logical path plus its `arbor-key` identity suffix.

## 3. SQLite

`_store.sqlite3` makes the enclosing folder SQLite-backed. If `schema.ts` selects a collection/table, the folder is that collection; otherwise each introspected user table appears as a child collection of a database container. An ordinarily named `.sqlite3` file remains browsable as a database node but does not absorb its enclosing folder.

SQLite remains canonical and usable by ordinary SQLite tools. The adapter maps
one runtime-owned mutation transaction to one SQLite transaction. Observation
occurs at committed boundaries and
snapshots are database-consistent; a live main database and WAL are never
treated as unrelated files or assigned an exact bytes hash. A provider
may widen an imprecise concurrent change to collection/store invalidation, but
must not manufacture a whole-database hash by hashing all rows or storage
bytes.

External-write observation must detect committed changes made through other processes or connections. When affected rows cannot be recovered precisely, the driver emits a whole-store invalidation after the external commit. A wakeup alone is never treated as proof of a committed row change.

A server-hosted SQLite executable document coordinates committed writes with accepted updates for the containing tree, durably records mutation completion before acknowledgement, and advances the tree only from a consistent database state. Changing backing at the same logical database path does not change portable handles.

## 4. Postgres and placement projections

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
Postgres is then the shared data authority. Arbor introspects schemas, maps each
runtime-owned transaction to Postgres, and observes committed changes; the authored
tree synchronizes the safe descriptor rather than a database copy.

A device placement may instead request a private SQLite projection in its
[configuration](04-accounts-and-devices.md):

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

`mode: bidirectional` requests the later full-duplex contract
([deferred 4](../spec.md#deferred)). It is permitted
only when the host has activated the external store as an Arbor-managed
materialization: the Arbor logical data tree is canonical, external Postgres
writes are denied, accepted named mutations atomically record the resulting
scoped model hash, accepted update, and receipt with their Postgres effects,
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

## 5. Data disclosure

Collection access and executable-document result access are distinct. Publishing a component or query result does not make the backing tree, SQLite file, Postgres connection, or unrelated rows readable. Conversely, putting public and private rows in a publicly readable Arbor tree exposes the backing bytes regardless of query filters. Sites containing row-private data keep the raw data boundary private to the source tree's execution principal or split data into separate Arbor trees, then expose only validated query results.

## 6. Schema identity

Schema information and explicit relationship declarations are mapped to canonical tree-rooted collection paths so executable source remains portable across placements. Relative collection references resolve against the source tree and path before use. A database schema, file schema, or relationship change changes the corresponding schema fingerprint and invalidates dependent compiled handles. Derived declarations, caches, and introspection artifacts are not authored tree content or portable artifacts.

## 7. Backing migration

Replacing Markdown/CSV/JSON/JSONL rows with `_store.sqlite3`, or replacing one
supported backing with another, preserves the logical collection address,
stable row identities, logical child names, and portable operations only when
the schema, primary-key values, child-name rule, and every
represented part of each child are preserved. Bytes hashes may change while
the model hash remains equal. The transition is not atomic
across independent backing authorities unless the implementation actually
provides that guarantee.
