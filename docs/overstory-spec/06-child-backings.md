# Child backings
*Part of the [Overstory spec](README.md): backing-independent child behavior over Markdown, CSV, JSON, JSONL, SQLite, external stores, and placement projections.*

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
compact patches to representation bytes, but the host decodes
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
  field's validated value must be a JSON string, boolean, or finite number.
  A file-backed schema never normalizes a value into that form
  ([§2.4.2](#242-value-validation)); a database backing maps a value not
  exactly representable in one of those forms to a string through its
  declared column mapping. Changing a key is observed as
  removal of one child and creation of another. A row's logical child segment
  is its single string key when that is a valid nonempty logical path component
  not beginning with the reserved `~row-` prefix; otherwise it is `~row-`
  followed by the unpadded base64url encoding of the canonical row key. This
  is the one surface that still uses base64url rather than the locator key
  token; the rule is under review in
  [Postgres 005](../../plans/postgres/005-representation-equivalence.md).
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

A file-backed collection contains `schema.usl`, its
[schema](#24-collection-schemas) in the [schema language](11-schema-language.md),
and exactly one row representation:

```
model Item {
  slug        Text @path
  title       Text
  description Markdown?
  quantity    Int
}
```

- Markdown row files other than `_index.md`;
- one `_store.csv`;
- one `_store.json`;
- one `_store.jsonl`; or
- one `<Table>.csv`, `<Table>.json` or `<Table>.jsonl` file for each table a
  schema with several tables stores, all in one format
  ([§2.4](#24-collection-schemas)).

Interpreting a collection never executes authored code. The schema is data: a
conforming implementation parses and checks it under the language's finite
limits and validates rows against it without inserting defaults, removing
fields, or transforming values. A row may carry members the schema does not
declare: its Markdown frontmatter keys, JSON or JSONL object members, or CSV
columns beyond the declared ones. They are accepted and preserved exactly
([§2.4.2](#242-value-validation)); declared members are validated strictly.

A row's key is its model's key: `id` unless the schema says otherwise. It names
the row in durable references and mutations and is immutable under an ordinary
row update. A Markdown row's key is its frontmatter `id` when it has one;
without one, its file name identifies it. `@path` on a field makes that field's
value the row's logical name, which must be one valid logical `Name`; without
it, the name derives from the key.

Only `schema.usl` selects a collection schema. Any other file, including one
named `schema.ts`, is an ordinary file with no collection meaning.

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

### 2.1 Accepted Overstory representation

An expanded directory represents immediate children with separate entries. A
collection-file directory instead keeps many logical children in one physical
authored file:

```text
Physical entries below /books:
  _store.json  → sourceHash
  schema.usl   → schemaHash

Logical children below /books:
  alice
  bob
```

The entry hashes prove and preserve the two files' exact bytes, while the
directory's `childrenSource` descriptor supplies their logical
interpretation. Its shape is defined with the
[Overstory directory](01-tree-operations.md#112-reading-an-accepted-snapshot).
The descriptor fields have these meanings:

| Fields | Meaning |
|---|---|
| `version`, `type` | Select this descriptor contract: version 1, `collection-file`. Any other version is invalid. |
| `format`, `source` | Select the physical collection file and parser for its exact bytes. |
| `schemaSource` | Select the physical schema file used to interpret the rows: exactly `schema.usl`. |
| `schemaFingerprint` | Commit to the exact UTF-8 bytes of the selected schema source, comments included. |
| `childSetHash` | Commit to the validated logical children derived from the collection file and schema. |

A collection whose schema stores several tables has a `collection-tables`
descriptor instead. It has `version`, `type`, `format`, `schemaSource` and
`schemaFingerprint` as above, and `tables` in place of `source` and
`childSetHash`: one `{ table, source, childSetHash }` entry for each table the
schema stores, in UTF-8 order of `table`. `table` is the table's name in the
data-file layout, `source` is exactly `<table>.<format>`, and `childSetHash`
commits to that table's rows. The descriptor is invalid if a table entry
repeats, is out of order, or has another member, and the directory is invalid
unless each `source` names an ordinary file entry. Its logical children are
its tables, each named by `table`, and a table's logical children are its
rows.

```text
Physical entries below /games:
  Game.jsonl        → gameHash
  List.jsonl        → listHash
  List_games.jsonl  → listGamesHash
  schema.usl        → schemaHash

Logical children below /games:
  Game/chess, Game/go
  List/favorites
  List_games/…
```

A descriptor version selects the schema file and this validation procedure.
A conforming authority validates a descriptor in this order:

1. Require `source` and `schemaSource` to name two ordinary file entries in
   the same directory, and require `source` to agree with `format`.
2. Load the exact source and schema bytes through those entries' hashes.
3. Recompute `schemaFingerprint` from the exact schema bytes, then parse and
   check `schema.usl` as a [collection schema](#24-collection-schemas) under
   the language's limits.
4. Parse the collection file. For `_store.csv`, convert each cell to a value
   by the [schema-directed CSV rules](#243-csv-cell-conversion); JSON and JSONL
   values are used as parsed. Validate every row.
5. Derive every row's stable key and logical name from the validated values
   using the model's key and its `@path` field.
6. Order the resulting `{ key, name, properties }` values by the UTF-8 bytes
   of `key` and recompute `childSetHash` as their canonical CBOR hash.
7. Reject a missing or multiply claimed source, an invalid row, key, or name,
   or either derived-hash mismatch.

For a `collection-tables` descriptor, step 3 also requires `tables` to name
exactly the tables the schema stores, and steps 1, 2 and 4 to 7 apply to each
table's `source` with that table's columns and key, each table's rows checked
against its own `childSetHash`.
8. Expose the validated rows as the directory node's complete immediate
   logical child set. Preserve `source` and `schemaSource` as physical authored
   entries, but do not expose them as logical children.

The three relevant hashes identify different things. `childSetHash` identifies
only the decoded child-set contribution. The enclosing node's model hash also
covers its properties, content, and child schema. The protocol root identifies the
exact authored object graph. A formatting-only edit can therefore change the
Overstory root while leaving both logical hashes unchanged.

Database-backed placements are not decoded through a
`CollectionFileDescriptor`; database pages and WAL files are never
Overstory file bytes or directory objects. Their snapshot, observation, and synchronization rules are
the database contracts below.

### 2.2 File writes and observation

When the mutation runtime commits a collection-file write, the adapter realizes
that commit as one guarded whole-file replacement. It locks the source, checks
its bytes hash, validates the complete key set and requested effects, writes and
fsyncs a complete replacement, atomically renames it, and fsyncs the containing
directory where supported. Retry identity and acknowledgement remain owned by
the mutation contract.
A [property write](01-tree-operations.md#22-reconciliation-and-exact-state-preconditions) on a row must
match the row's model hash and must preserve the declared key. A logical no-op leaves the source byte-identical. A direct row-property
write cannot add, remove, or reorder rows.
Multi-row mutations preserve row order unless the mutation
explicitly changes ordered membership. JSONL drivers preserve untouched line
bytes; JSON drivers preserve untouched value formatting where the source edit
model can prove it; CSV drivers preserve header/column order, while the exact quoting of a changed record may be canonicalized. Partial files and
rolled-back attempts never become observable committed states.

After an external file change, the driver reparses and compares rows by primary
key. It publishes exact row changes when it can prove them and otherwise widens
to collection invalidation. Reordering lines does not change identity.

Mixing backing shapes produces a diagnostic and disables collection-level interpretation without making the underlying files inaccessible. Invalid rows are diagnostics, not daemon crashes or silent deletion.

Schema interpretation is parsing and checking data under the profile limits. It has no evaluator, imports, or ambient authority, and it is independent of executable-document activation. This specification does not prescribe parser technology or generated-file layout.

### 2.3 Accepted update validation and merge

When a candidate changes a recognized collection file, the submitted root
names the exact lossless encoding of that candidate tree state. The host
decodes coherent base, current, and candidate representations under schema and
resource bounds, recomputes logical row identities and `childSetHash`, applies
`collection-file-fields-v1` ([source intent §7](10-source-intent.md#7-format-aware-merge-rules-and-explicit-automatic-resolution))
to a conflicting collection file, validates all keys,
foreign keys, and constraints, and encodes the accepted representation. It
never trusts a client-supplied schema fingerprint or child-set hash.
Formatting-only changes advance the accepted root without changing
`childSetHash`, so they invalidate no logical query dependency.

The complete model hash of a logical node remains distinct from the collection
file's narrower `childSetHash`, which is used while decoding and merging that
node's child-set contribution. Neither hash substitutes for an accepted update
identity or a decision guard. SQLite and Postgres changes instead use the database transaction,
observation, and semantic-checkpoint contracts; live database storage bytes are
never submitted or merged as a collection-file object.

Authorities advertise collection-file, schema, and row quotas and never accept
a collection file they cannot validate completely. Semantic merge reports
`collection-file-row-conflict`, `collection-file-schema-conflict`, or
`collection-file-constraint-conflict`; a row conflict path uses the parent
logical path plus its `overstory-key` identity suffix.

### 2.4 Collection schemas

A collection's `schema.usl` declares the models whose rows it holds. It may
also declare fixed models, which rows reference by name, and connections to
`Person`. Each table of the schema's
[data-file layout](11-schema-language.md#7-layout) is one table of the
collection, and its rows' members are that table's columns: for a model, its
key, its value fields, then its connections; for an n:m connection without
`@fold`, its join table's columns. A schema with one table may store it as
`_store.csv`, `_store.json` or `_store.jsonl` with a `collection-file`
descriptor; one with several tables stores each as `<Table>.csv`, `.json` or
`.jsonl` with a `collection-tables` descriptor ([§2.1](#21-accepted-overstory-representation)),
and a `_store.*` file beside such a schema is rejected with
`collection-tables`. A schema whose layout has no table is rejected with
`collection-tables` too. The [`collection-schemas.json`](conformance/collection-schemas.json)
vectors bind this section.

#### 2.4.1 Source and identity

The source is the exact bytes of `schema.usl`. They must be well-formed UTF-8
without a byte-order mark (`invalid-utf8`), and at most 1,048,576 bytes
(`schema-too-large`). `schemaFingerprint` is the SHA-256 of those exact bytes;
implementations never hash a reformatted or parsed form.

#### 2.4.2 Value validation

Validation is a pure decision over one JSON value. It never inserts defaults,
removes fields, coerces, or transforms, so a valid row's properties are
exactly its parsed values.

- A row is a JSON object with every required member present. An optional
  member or an array may be absent, and an optional member may be `null`,
  which means the same as absent.
- `Text` and `Markdown` match a string that is valid Unicode (no unpaired
  surrogate). `Int` matches an integer within ±(2^53 − 1), decided by value:
  `1`, `1.0` and `1e0` are the same integer. `Number` matches any finite
  number. `Bool` matches `true` or `false`. `Date` matches a string that
  parses as an ISO 8601 date or date-time.
- A reference to a fixed model matches one of its row names. A reference to
  `Person` matches a profile id string. A folded connection is an array of the
  other side's keys: a value, or an object of key columns when the key has
  several.
- An array matches a JSON array whose elements all match.
- **Open rows.** Undeclared members are accepted without examination and
  preserved exactly in the row's properties, the child-set hash, and every
  re-encoding.

Diagnostics name a stable code (`type-mismatch`, `missing-member`,
`no-matching-choice`, `invalid-text`, `budget-exceeded`) and a JSON Pointer to
the failing value, in the order the columns are declared.

#### 2.4.3 CSV cell conversion

A CSV cell is text, so `_store.csv` converts each cell to a value using its
column's type before validation. JSON and JSONL rows already contain typed
values and are never converted.

Header names must be distinct; a repeated header name makes the file invalid.
A header name that is not a declared column is an undeclared column: a
nonempty cell is its exact text and an empty cell is absence. A declared cell
converts as follows:

1. A missing or empty cell is absence when the column is optional or an array,
   otherwise the empty string for a text column; otherwise it is invalid.
2. A nonempty text cell (`Text`, `Markdown`, `Date`, references) is its exact
   text, so a key such as `001` remains the string `"001"`.
3. A nonempty `Int` or `Number` cell must match the JSON number grammar
   exactly, without surrounding whitespace, and converts to that number.
4. A nonempty `Bool` cell must be exactly `true` or `false`.
5. A nonempty array cell must be a JSON array.

The converted row is then validated as in §2.4.2. Encoding writes the declared
columns in order, then undeclared members in the order they first appear
across the rows. Numbers use their shortest round-trip JSON number text,
arrays their JSON text, and absence and `null` an empty cell. A value that
would not convert back to itself, such as the empty string in an optional text
column or any nontext or empty undeclared value, cannot be written to
`_store.csv` and rejects the write.

#### 2.4.4 Resource limits

The [schema language's limits](11-schema-language.md#8-limits) apply to the
source. Validating one row takes at most 1,000,000 steps (values visited plus
object members examined), and one collection file at most 50,000,000;
exceeding either rejects the row or file with `budget-exceeded` naming
`row-steps` or `collection-steps`. The collection-file, row-count, and
schema-byte quotas of [§2.3](#23-accepted-update-validation-and-merge) apply
in addition.

## 3. SQLite

`_store.sqlite3` makes the enclosing folder SQLite-backed. Each user table appears as a child collection of a database container. A `schema.usl` beside it declares the database's models: the database must [implement](11-schema-language.md#7-layout) the schema's database layout, and the schema's connections are the relationships executable documents query along, with people reached through the virtual `Person` relation. Without a `schema.usl`, the database's own introspected schema is used and has no relationships. An ordinarily named `.sqlite3` file remains browsable as a database node but does not absorb its enclosing folder.

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
Postgres is then the shared data authority. Overstory introspects schemas, maps each
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
([deferred 4](README.md#deferred)). It is permitted
only when the host has activated the external store as an Overstory-managed
materialization: the Overstory logical data tree is canonical, external Postgres
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

Collection access and executable-document result access are distinct. Publishing a component or query result does not make the backing tree, SQLite file, Postgres connection, or unrelated rows readable. Conversely, putting public and private rows in a publicly readable Overstory tree exposes the backing bytes regardless of query filters. Sites containing row-private data keep the raw data boundary private to the source tree's execution principal or split data into separate Overstory trees, then expose only validated query results.

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
