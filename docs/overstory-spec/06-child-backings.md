# Child backings
*Part of the [Overstory spec](README.md): backing-independent child behavior over expanded files, logical collections and their projections (CSV, JSON, JSONL, Markdown rows, SQLite), external stores, and placement projections.*

*Owns: how expanded files, logical collections, Postgres, and later external
providers supply logical child sets; what the tree holds for a collection;
how placements project collections into files and databases; observation and
physical commit behavior; and representation migration. Query and transaction semantics belong to
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
categories are expanded files, a logical collection
([§2](#2-logical-collections)) and an external store. A logical collection's
rows are part of the tree itself; whether a placement holds them as
`_store.csv`, one `<Table>.jsonl` per table, Markdown row files, a
`_store.sqlite3` database or nothing at all is that placement's projection, and
never part of the tree. The provider exposes all of them through ordinary node
and children APIs; projection files are not themselves logical children.

A child-backing summary may expose the placement's projection and format, but
it is capability metadata rather than identity. A collection's summary carries
its model fingerprint and logical hash, which are the same at every placement.

Reformatting a projected file, or moving a collection from CSV to SQLite at
one placement, changes nothing in the tree: no update, no history, no hash
([data-model equality](01-tree-operations.md#representation-and-model-equality)).
Updates change collections by row operations
([source intent §4.1](10-source-intent.md#41-row-operations)); the host
replays them on the accepted rows, merges by row identity and field
([source intent §7.1](10-source-intent.md#71-collection-rows)), validates the
complete schema and constraints, and computes the accepted logical hash itself.

An external store such as Postgres ([§4](#4-postgres-and-placement-projections))
is not a logical collection: it is the data authority, and database reads carry
a schema fingerprint, a provider-local transaction snapshot for the duration of
the read, each row's model hash as what a write must match, and an ordered
observation cursor. It never consists of database page, WAL, or provider
storage bytes.

### 1.2 Member identity, order, and pagination

A backing preserves these logical child-set facts:

- **Row identity.** A mutable collection's declared primary key is the
  stable-key rule for its children. It must be stable, non-null,
  serializable, and independent of row position, SQLite `rowid`, display
  label, or query plan. A row's third reference component is its canonical key
  JSON as defined by
  [locators](03-locators.md#2-stable-keys-revisions-and-fragments); each key
  field's validated value must be a JSON string, boolean, or finite number.
  A logical collection's key values are already in that form
  ([§2.2](#22-rows-and-values)); an external store maps a value not exactly
  representable in one of those forms to a string through its declared
  column mapping. Changing a key is observed as
  removal of one child and creation of another. A row's logical child segment
  is its single string key when that is a valid nonempty logical path component
  not beginning with the reserved `~row-` prefix; otherwise it is `~row-`
  followed by the unpadded base64url encoding of the canonical row key. This
  is the one surface that still uses base64url rather than the locator key
  token; the rule is under review in
  [Postgres 005](../../plans/later/postgres-005-representation-equivalence.md).
- **Ordering.** Collection-file and database rows enumerate in canonical stable-key
  order, falling back to canonical path, using the portable comparison; a
  backing's default collation is not an acceptable substitute. Where a
  relational extension supplies explicit ordering, the proved stable key is the
  deterministic final tie-breaker.
- **Pagination.** Live or mutable pagination uses a provider-bound keyset
  cursor, never an unqualified offset. A logical collection binds that cursor to its logical hash; an external store binds it to the schema
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
observation cursor it read through. A logical collection also names its
logical hash. External-store adapters hold a provider-local transaction snapshot only for the read;
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

## 2. Logical collections

A folder whose entries include `schema.usl` is a collection. Its rows are
logical state held in the tree, in the canonical form of §2.1 and §2.2, and
every file or database that shows them is one placement's
[projection](#24-projections) of that state. Two placements of one tree may
project a collection differently, and both hold the same rows and the same
root.

The folder's `.usl` files are its [schema](11-schema-language.md), held as
ordinary authored file entries with exact bytes. `_index.md` and other
ordinary files in the folder stay ordinary entries and pages: the folder is a
page that has a logical collection. A collection whose schema has one model
with data rows has those rows as its logical children. One with several has a
logical child per model, named after it, whose children are that model's rows.
Rows have no children; a subpage of a row belongs in a separate
folder that links to it.

Interpreting a collection never executes authored code. The schema is data: a
conforming implementation parses and checks it under the language's finite
limits and validates rows against it without inserting defaults or
transforming values. The schema is the whole contract for a collection's
rows: anything a projection holds that the schema doesn't declare, such as an
extra CSV column, JSON key order or a comment in a Markdown row's front
matter, is that placement's own and does not cross to another placement.

### 2.1 What the tree holds

```text
Entries below /games:
  _index.md   → indexHash        (an ordinary page)
  schema.usl  → schemaHash
Collection of /games:
  modelFingerprint
  Game → table → rows chunks
  List → table → rows chunks
Logical children below /games:
  Game/chess, Game/go
  List/favorites
```

The directory object's `collection` reference
([tree operations §1.1.2](01-tree-operations.md#112-reading-an-accepted-snapshot))
names the schema's model fingerprint and one table object per model with data
rows, empty ones included, in UTF-8 order of model name. A table object lists
its rows in chunks, and each chunk is a `rows` object holding its rows in the
form of §2.2:

- A table's rows are in canonical stable-key order (§1.2) and divided into
  chunks at content-defined boundaries. A chunk ends after a row when it holds
  at least 512 rows and the first two bytes of that row's hash, read as a
  big-endian integer, are below 128, or when it holds 8,192 rows; the last
  chunk ends with the table. So an edit changes O(1) chunks, and a table below
  513 rows is one chunk.
- A row's hash is the canonical CBOR hash of its §2.2 form.
- The collection's **logical hash** is the canonical CBOR hash of its
  `collection` reference. It is the collection's contribution to the folder's
  model hash, and it is the same for every representation of the same rows.

An authority validates a `collection` reference in this order:

1. Parse and check the folder's `.usl` file entries under the language's
   limits, and require `modelFingerprint` to equal the
   [model fingerprint](11-schema-language.md#9-fingerprints) they produce.
2. Require `tables` to name exactly the schema's models with data rows, in
   order, each once.
3. Load every table and `rows` object; require each to decode canonically,
   its rows to be in order with no key twice, its chunks to end exactly where
   the boundary rule ends them, and each table's `rows` count to equal the sum
   of its chunks'.
4. Validate every row against its model (§2.2), and every reference against
   the rows and enum values it names.
5. Expose the tables as the folder's logical children, and preserve the `.usl`
   files and other entries as ordinary authored entries.

A host advertises its row, table and chunk quotas. An implementation that
doesn't split tables yet may hold tables to 512 rows, since below that every
table is one chunk.

### 2.2 Rows and values

A row's §2.2 form is a map with `key`, `fields`, `created` and `modified`:

- **`key`** is its model's key ([schema language §6](11-schema-language.md#6-keys))
  as an array of `[field, value]` pairs in key order. Its canonical key JSON
  is the row's stable key ([locators](03-locators.md#2-stable-keys-revisions-and-fragments)),
  immutable under an ordinary row update; changing it is removal of one row
  and creation of another. A row's logical name is its `path` field's value,
  which must be one valid logical `Name`; without one, the name derives from
  the key as §1.2 says.
- **`fields`** holds every other declared field that has a value, by name.
  An optional field without a value and an empty many-valued field are
  absent, never `null` or empty.
- **`created`** and **`modified`** are RFC 3339 date-times in UTC with
  millisecond precision. They are stamped from accepted operations' `at`, and
  never set directly ([source intent §4.1](10-source-intent.md#41-row-operations)).

Values have one canonical form per type, so no projection's conventions
reach the tree: `Text` and `Markdown` are UTF-8 strings, `Int` is a CBOR
integer and `Number` a CBOR float (so `1` and `1.0` differ by type, not by
spelling), `Bool` is a boolean, a `Date` is `YYYY-MM-DD` or an RFC 3339
date-time in UTC, a reference to a model is the target's key value (an array
of its pairs when the key has several fields), a reference to an enum is the
value's name, a `Person` is a profile TreeID, and a value array is an array.

Only models are addressable: `/games/Game/g1`, and a connection model's rows
too. A plain n:m connection is not a node set. It is a set of pairs held once,
as a field on the rows of one end: the `ordered` end, else the end declared
first. The other end shows it as a field derived from those pairs, and either
end's row operations change the same pairs. An `ordered` field is a sequence
of member keys, never position numbers. A 1:1 or 1:n connection is a
reference on its single side.

A row has no content outside its fields. A Markdown projection's body and
title are fields ([schema language §7](11-schema-language.md#7-attributes)).

### 2.3 Accepted update validation and merge

An update changes a collection by row operations, which the host replays on
its accepted basis rows; the frame's `after` must equal the tree the replay
derives ([source intent §2](10-source-intent.md#2-the-trace)). A snapshot
update (a `null` trace) that changes a collection is accepted only from a
caller allowed to `write` the collection's path, and its effects are the row
differences from its basis. The host validates all keys, references and
constraints, merges concurrent changes by
`collection-fields-v1` ([source intent §7.1](10-source-intent.md#71-collection-rows)),
encodes the accepted tables, and never trusts a client-supplied fingerprint
or hash.

A merge conflict on a field becomes a decision scoped to that row field
([tree operations §1.2.3](01-tree-operations.md#123-reading-conflicts)); a
merged result the schema rejects is a conflict on the collection's folder.
Changing the schema's model layer is a schema migration: the update carries
the new `.usl` files and the rows rewritten to them, and is validated as a
whole.

### 2.4 Projections

A placement chooses how to project each collection: as files of a format, as
a SQLite database ([§3](#3-sqlite)), or not at all. The choice and the
placement's own [storage mapping](11-schema-language.md#7-attributes) are
placement-private options ([accounts §4](04-accounts-and-devices.md#4-local-placements)),
never tree content. On first sight of a collection it has no choice for, a
placement records what it finds on disk, so an existing folder keeps its
files. Creating a projection from nothing writes canonical form (§2.4.1).

Every projection reads and writes the same way:

- **Tolerant read.** Any valid edit to the projection, made by any program,
  becomes row operations against the state last applied to it. A row the
  schema can't read is reported for that row, and the rest of the collection
  still syncs.
- **Minimal write.** Applying accepted state writes only changed rows: a file
  projection splices changed rows into the file it already has, keeping its
  column order, quoting, line endings, unchanged rows and anything else
  that isn't data, and a database updates only changed rows in one
  transaction. A write never overwrites an edit the placement hasn't read yet.
- **Typed values at the boundary.** A projection converts between its
  spellings and §2.2's values. Normalizing is not changing: a stored value
  that reads back equal to the logical value is left as stored.

Partial files and rolled-back attempts never become observable committed
states. Projection bytes, query plans and SQLite pages are private placement
state.

#### 2.4.1 File projections

A file projection holds a collection's rows in one of these forms, beside its
`.usl` files:

- `_store.csv`, `_store.json` or `_store.jsonl`, when the file layout has one
  table;
- one `<Table>.csv`, `<Table>.json` or `<Table>.jsonl` per table of the
  [file layout](11-schema-language.md#10-layout), all in one format; or
- one Markdown file per row of a single-table collection: the body field
  (§2.2) as the body, the title field as its first H1, and the other fields as
  front matter. Such a file is a projected record, not a page, so
  [directory format](02-directory-format.md) byte-exactness doesn't cover it,
  and Story presents the folder as a collection.

`_store.csv` uses its header for column names. `_store.json` is one top-level
JSON array whose elements are row objects. `_store.jsonl` has one JSON object
per nonblank line. Each row has its file-layout columns, `created` and
`modified` included. Canonical form, for a projection created from nothing,
writes rows in stable-key order and columns in layout order, as RFC 8259 JSON
without whitespace, or CSV per §2.4.2.

Mixing projection forms in one folder produces a diagnostic and stops the
placement from reading the projection, without making the files inaccessible
or changing the tree.

#### 2.4.2 CSV cell conversion

A CSV cell is text, so a CSV projection converts each cell to a value using
its column's type. JSON values are used as parsed and converted to §2.2's
types (an `Int` column's `2.0` reads as `2`; `2.5` makes the row unreadable).

Header names must be distinct; a repeated header name makes the file
unreadable. A header name that is not a declared column is the placement's
own, kept on write and never read as data. A declared cell converts as
follows:

1. A missing or empty cell is absence when the column is optional or an array,
   otherwise the empty string for a text column; otherwise it is invalid.
2. A nonempty text cell (`Text`, `Markdown`, `Date`, references) is its exact
   text, so a key such as `001` remains the string `"001"`.
3. A nonempty `Int` or `Number` cell must match the JSON number grammar
   exactly, without surrounding whitespace, and converts to that number.
4. A nonempty `Bool` cell must be exactly `true` or `false`.
5. A nonempty array cell must be a JSON array.

Writing uses the file's own columns in their order. Numbers use their
shortest round-trip JSON number text, arrays their JSON text, and absence an
empty cell. A value that would not convert back to itself, such as the empty
string in an optional text column, can't be projected to CSV, and the
placement reports the collection as not projectable in that format.

### 2.5 Value validation and limits

Validation is a pure decision over one row. A row matches its model when
every required field is present, every value has its field's type and arity
(§2.2), every reference names an existing row or enum value, and `unique`
fields are unique. Diagnostics name a stable code (`type-mismatch`,
`missing-member`, `no-matching-choice`, `invalid-text`, `budget-exceeded`)
and the failing field, in the order fields are declared. The
[`collection-schemas.json`](conformance/collection-schemas.json) vectors bind
this section.

The [schema language's limits](11-schema-language.md#11-limits) apply to the
schema. Validating one row takes at most 1,000,000 steps (values visited plus
map members examined), and one collection at most 50,000,000; exceeding
either rejects the row or the update with `budget-exceeded` naming
`row-steps` or `collection-steps`. The quotas of §2.1 apply in addition.

## 3. SQLite

A SQLite projection holds a collection's rows in a `_store.sqlite3` database
in the folder, which implements the schema's
[database layout](11-schema-language.md#10-layout) as that placement's storage
resolves it. A placement that finds such a database beside a `schema.usl` on
first sight records it as its projection; one that adopts an existing
database whose names differ records them in its own storage mapping. A
database that doesn't implement the layout, or that the placement hasn't
chosen as a projection, is an ordinary file: a `.sqlite3` file never makes a
folder a collection by being there.

The database stays usable by ordinary SQLite tools. The placement observes
committed changes, including those other processes make, and turns them into
row operations (§2.4); a wakeup alone is never proof of a committed row
change, and when affected rows can't be recovered precisely it rereads the
tables. Positions of `ordered` connections are the database's own, and a
change of position order reads back as a move. A placement applies accepted
row operations to the database in one transaction per accepted update, and a
placement that has missed history rebuilds the database from the host's rows.
The database's pages and WAL are never tree content and are never assigned a
bytes hash.

A host may keep its own SQLite projection of a collection, to answer queries
and run mutations ([executable documents](07-executable-documents.md)). It is
derived from accepted state and can be dropped and rebuilt from it; it never
changes what a root means. A mutation computed on it submits its effects as an
ordinary update of row operations. Changing a projection at the same logical
path does not change portable handles.

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

Schema information and explicit relationship declarations are mapped to canonical tree-rooted collection paths so executable source remains portable across placements. Relative collection references resolve against the source tree and path before use. A change to a collection's model layer changes its model fingerprint, and a change to an external store's schema its schema fingerprint; either invalidates dependent compiled handles. A storage or presentation change alone invalidates none. Derived declarations, caches, and introspection artifacts are not authored tree content or portable artifacts.

## 7. Backing migration

Changing how a placement projects a logical collection, from Markdown rows to
CSV or from CSV to SQLite, changes nothing in the tree: the collection's
address, rows, logical hash and portable operations stay as they are, and
other placements are unaffected. Moving rows between a logical collection and
an external store, or between external stores, preserves the logical
collection address, stable row identities, logical child names, and portable
operations only when the schema, primary-key values, child-name rule, and
every field of each row are preserved. The transition is not atomic across
independent backing authorities unless the implementation actually provides
that guarantee.
