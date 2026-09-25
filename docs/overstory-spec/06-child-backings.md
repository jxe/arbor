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
  ([§2.4.4](#244-value-validation)); a database backing maps a value not
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

A file-backed collection contains `schema.cddl`, a declarative row schema in the
[collection schema profile](#24-collection-schema-profile), and exactly one row
representation:

```cddl
overstory-schema-version = 1
overstory-primary-key = ["id"]
; Optional. Omission derives logical names from the primary key.
overstory-child-name = "slug"

row = {
  id: tstr,
  slug: tstr,
  title: tstr,
  ? description: tstr,
  quantity: 0..1000
}
```

- Markdown row files other than `_index.md`;
- one `_store.csv`;
- one `_store.json`; or
- one `_store.jsonl`.

Interpreting a collection never executes authored code. The schema is data: a
conforming implementation parses and checks it under the profile's finite
limits and validates rows against it without inserting defaults, removing
fields, or transforming values. A row may carry members the schema does not
declare: its Markdown frontmatter keys, JSON or JSONL object members, or CSV
columns beyond `row`'s. They are accepted and preserved exactly
([§2.4.4](#244-value-validation)); declared members are validated strictly.

`overstory-child-name` is an optional deterministic logical-name rule for
compact backings. It names one required, text-only member of `row`; omission
derives the name from the primary key. The selected value must be one valid
logical `Name`.

`overstory-primary-key` is required for mutation and durable row references. It
names one or more declared required `row` members in tuple order. Omitting it leaves CSV and
JSON/JSONL rows as read-only positional projections; Markdown rows may use their
durable `id` identity as their key when the schema explicitly declares `id`.
An undeclared `id` frontmatter key, such as the durable page ID a client adds
when a page moves, is an ordinary preserved member. A key field is immutable
under an ordinary row update.

Only `schema.cddl` selects a collection schema. Any other file, including one
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
  schema.cddl  → schemaHash

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
| `schemaSource` | Select the physical schema file used to interpret the rows: exactly `schema.cddl`. |
| `schemaFingerprint` | Commit to the exact UTF-8 bytes of the selected schema source, comments and metadata included. |
| `childSetHash` | Commit to the validated logical children derived from the collection file and schema. |

The descriptor version and the schema profile version
(`overstory-schema-version`) are distinct. A descriptor version selects the
schema file and this validation procedure; the profile version, inside the
fingerprinted source, selects the schema language. A conforming authority
validates a descriptor in this order:

1. Require `source` and `schemaSource` to name two ordinary file entries in
   the same directory, and require `source` to agree with `format`.
2. Load the exact source and schema bytes through those entries' hashes.
3. Recompute `schemaFingerprint` from the exact schema bytes, then parse and
   check `schema.cddl` under the [collection schema profile](#24-collection-schema-profile)
   and its limits.
4. Parse the collection file. For `_store.csv`, convert each cell to a value
   by the [schema-directed CSV rules](#245-csv-cell-conversion); JSON and JSONL
   values are used as parsed. Validate every row against `row`.
5. Derive every row's stable key and logical name from the validated values
   using `overstory-primary-key` and `overstory-child-name`.
6. Order the resulting `{ key, name, properties }` values by the UTF-8 bytes
   of `key` and recompute `childSetHash` as their canonical CBOR hash.
7. Reject a missing or multiply claimed source, an invalid row, key, or name,
   or either derived-hash mismatch.
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
`collection-file-rows-v1` to a conflicting collection file, validates all keys,
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
logical path plus its `arbor-key` identity suffix.

### 2.4 Collection schema profile

`schema.cddl` is written in [CDDL (RFC 8610)](https://www.rfc-editor.org/rfc/rfc8610.html).
This section defines the Overstory collection schema profile, version 1: a
strict subset of CDDL syntax interpreted over JSON values, plus three reserved
metadata rules and the open-row convention. Every accepted source is valid RFC
8610 CDDL, but the metadata interpretation and the open `row` map
([§2.4.4](#244-value-validation)) are Overstory conventions, not part of RFC
8610.
Valid CDDL outside the subset is rejected with a diagnostic, never ignored or
approximated. The [`collection-schemas.json`](conformance/collection-schemas.json)
vectors bind this section.

#### 2.4.1 Source and identity

The source is the exact bytes of `schema.cddl`. They must be well-formed UTF-8
without a byte-order mark, and at most 1,048,576 bytes. `schemaFingerprint` is
the SHA-256 of those exact bytes, so comments, metadata rules, and formatting
are part of schema identity. Implementations never hash a reformatted or
parsed form.

#### 2.4.2 Syntax subset

The lexical syntax is RFC 8610's, restricted as follows.

- Whitespace is space, tab, line feed, and carriage return. A comment runs from
  `;` to the end of the line. Any other control character outside a comment or
  text literal is rejected, as is one inside a comment other than tab or
  carriage return.
- A rule is `name = type`. Names use the RFC 8610 identifier grammar and are
  compared exactly. Each name is defined once. `/=`, `//=`, generic parameters
  (`name<T>`), and group rules (`name = ( ... )`) are rejected.
- A type is one or more alternatives separated by `/`. An alternative is a
  prelude type, a rule reference, a text literal, a numeric literal, a numeric
  range, a map, or an array. Parenthesized types, group choices (`//`),
  control operators (`.size`, `.regexp`, and every other `.name`), unwrap
  (`~`), enumeration (`&`), tags (`#`), byte-string literals, and socket
  (`$name`) extension points are rejected.
- The prelude types are `bool`, `true`, `false`, `null`, `nil` (a synonym for
  `null`), `tstr`, `text` (a synonym for `tstr`), `int`, `uint`, `nint`, and
  `number`. Every other prelude name, including `any` (outside the open-map
  entry below), `bstr`, `bytes`, `float`, `float16`, `float32`, `float64`, and
  `undefined`, is rejected, and no rule may be named after a prelude type.
- A text literal is a double-quoted string using JSON escapes (`\"`, `\\`,
  `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX` with paired surrogates). Its
  value must be valid Unicode and at most 4,096 UTF-8 bytes. Single-quoted and
  prefixed literals are rejected.
- An integer literal is `0` or an optional `-` followed by a decimal digit
  string without leading zeros, and must lie within ±(2^53 − 1). A decimal
  literal adds a fraction (`.` digits), an exponent (`e` or `E`, optional sign,
  digits), or both, and its nearest IEEE 754 double must be finite. Hexadecimal,
  binary, and hexadecimal-float literals are rejected.
- A range is `low..high` (inclusive) or `low...high` (excluding `high`). Both
  bounds are numeric literals of the same kind: two integer literals form an
  integer range, two decimal literals a number range. Mixed bounds, named
  bounds, and `low > high` are rejected.
- A map is `{ entries }`. Each entry is `key: type`, optionally preceded by
  `?`; `key` is a bareword or a text literal and names a string member.
  Entries are separated by optional commas, and a trailing comma is allowed.
  Member names are unique within a map. A map may also contain, at most once
  and in any position, the open-map entry `* tstr => any` (`text` may replace
  `tstr`), which admits undeclared members ([§2.4.4](#244-value-validation)).
  Other occurrence indicators, other `=>` keys, computed or nontext keys, and
  group entries are rejected.
- An array is `[* type]` or `[+ type]`: a homogeneous array with zero-or-more
  or one-or-more elements of `type`. Any other array group, including a
  fixed-length tuple, is rejected.
- Rule references are resolved within the one source file. An undefined
  reference, a reference cycle (direct or indirect), and a reference to a
  metadata rule are rejected. Unreferenced rules are allowed and checked.

The rule `row` is required and must be defined directly as a map. Its declared
members in source order are the collection's declared columns; that order is
the generated-column and CSV-encoding order.

#### 2.4.3 Metadata rules

Names beginning with `overstory-` are reserved. Only these three may be
defined, each at most once, and each only with the literal-only form shown:

| Rule | Form | Meaning |
|---|---|---|
| `overstory-schema-version` | integer literal | Required. The profile version; this section defines `1`, and any other value is rejected as unsupported. |
| `overstory-primary-key` | `[` text literal *( `,` text literal ) `]` | Optional. The primary-key fields in tuple order. |
| `overstory-child-name` | text literal | Optional. The member supplying each row's logical name. |

Each primary-key field names a distinct required member of `row` whose type
admits only text, number, and boolean values; a field admitting `null`, a
map, or an array is rejected. The child-name member must be a required member
of `row` whose type admits only text. Nonliteral metadata, such as
`overstory-primary-key = [tstr]` or a rule reference, is rejected. Absence of
the primary key keeps the read-only positional and Markdown-`id` behavior of
[§2](#2-file-backed-collections); absence of the child name derives each name
from the key.

#### 2.4.4 Value validation

Validation is a pure decision over one JSON value. It never inserts defaults,
removes fields, coerces, or transforms, so a valid row's properties are
exactly its parsed values.

- `tstr` matches a string that is valid Unicode (no unpaired surrogate); a
  text literal matches an equal string, compared by code point.
- `bool`, `true`, `false`, and `null` match the corresponding JSON values.
- `number` matches any finite number. `int` matches a number that is an
  integer within ±(2^53 − 1); `uint` additionally requires ≥ 0 and `nint`
  requires < 0. Numeric kind is decided by value, not by source spelling:
  `1`, `1.0`, and `1e0` are the same integer, and `-0` is zero.
- A numeric literal matches an equal number. An integer range matches an
  integer within its bounds; a number range matches any finite number within
  its bounds.
- A map matches a JSON object in which every required member is present and
  every present declared member is valid; an optional member is either absent
  or present with a valid value, and `null` is a value, not absence. A closed
  map, one without the open-map entry, also requires every member to be
  declared: an undeclared member is invalid. An open map, one with
  `* tstr => any`, accepts undeclared members with any JSON value without
  examining them.
- **Open rows.** By Overstory convention the `row` map is always open: rows
  are validated as if `row` ended with `* tstr => any`, whether or not the
  source writes that entry. Under plain RFC 8610 the two forms are equivalent;
  a `:` member key implies a cut, so a declared member with an invalid value
  never falls through to the open entry. Undeclared members are preserved
  exactly in the row's properties, the child-set hash, and every re-encoding.
  Nested maps keep ordinary CDDL semantics: they are closed unless they declare
  `* tstr => any`. The primary key and child name still name declared
  required members.
- An array type matches a JSON array whose elements all match, with at least
  one element for `+`.
- A choice matches a value that matches any alternative.

Diagnostics name a stable code and a JSON Pointer to the failing value. Their
order is deterministic: declared members in declaration order, then a closed
map's undeclared members in their order in the value. A failed choice reports the
choice itself rather than every alternative.

#### 2.4.5 CSV cell conversion

A CSV cell is text, so `_store.csv` converts each cell to a value using its
column's declared type before validation. JSON and JSONL rows already contain
typed values and are never converted.

Header names must be distinct; a repeated header name makes the file invalid.
A header name that is not a declared `row` member is an undeclared column: it
converts as if declared `? name: tstr`, so a nonempty cell is its exact text
and an empty cell is absence. Every declared `row` member's type, after removing
`null`, must admit exactly one scalar class: text (`tstr` and text literals),
number (numeric types, ranges, and numeric literals), or boolean (`bool`,
`true`, `false`). A schema with a map, array, or mixed-class member cannot
govern `_store.csv`. A cell converts as follows:

1. A missing or empty cell is absence when the member is optional, otherwise
   `null` when the type admits `null`, otherwise the empty string when the class
   is text; otherwise it is invalid.
2. A nonempty text-class cell is its exact text, so a key such as `001`
   remains the string `"001"`.
3. A nonempty number-class cell must match the JSON number grammar exactly,
   without surrounding whitespace, and converts to that number.
4. A nonempty boolean-class cell must be exactly `true` or `false`.

The converted row is then validated as in §2.4.4. Encoding writes the declared
column order of `row`, then undeclared members in the order they first appear
across the rows, and each value's text: numbers use their shortest round-trip
JSON number text, and absence and `null` write an empty cell. A value that would not
convert back to itself, such as the empty string in an optional text column or
any nontext or empty undeclared value, cannot be written to `_store.csv` and
rejects the write.

#### 2.4.6 Resource limits

Non-Turing-completeness is not a resource bound. Every implementation enforces
at least these limits, and none may accept a schema or row beyond them:

| Limit | Value |
|---|---|
| Source bytes | 1,048,576 |
| Tokens | 65,536 |
| Text literal bytes | 4,096 |
| Rules | 1,024 |
| Syntax nodes (types, members, alternatives) | 32,768 |
| Nesting depth of maps, arrays, and choices, counted through references | 32 |
| Alternatives in one choice | 256 |
| Members in one map | 1,024 |
| Expanded type nodes of `row`, counting each reference at every use | 100,000 |
| Validation steps for one row (type visits plus examined object members) | 1,000,000 |
| Validation steps for one collection file | 50,000,000 |

Exceeding a limit rejects the schema or, for the two step limits, the row or
collection file, with a `budget-exceeded` diagnostic naming the limit; an
oversized source is `schema-too-large`. The
collection-file, row-count, and schema-byte quotas of
[§2.3](#23-accepted-update-validation-and-merge) apply in addition.

A later profile version may add syntax only with bounded semantics,
conformance vectors, and a compatibility assessment; an implementation that
does not know a profile version rejects the schema.

## 3. SQLite

`_store.sqlite3` makes the enclosing folder SQLite-backed. Each introspected user table appears as a child collection of a database container; the database's own schema is authoritative. `schema.cddl` governs only Markdown and collection-file backings and does not select a table: a `schema.cddl` beside `_store.sqlite3` or an external-store descriptor is a mixed-backing diagnostic. An ordinarily named `.sqlite3` file remains browsable as a database node but does not absorb its enclosing folder.

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
