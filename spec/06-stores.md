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
- a consistent revision or snapshot representation;
- actionable diagnostics while preserving the last fully usable schema/view.

Portable collection queries and mutations have the same meaning across backings. Backing-specific relational operations may exist only where the addressed database provides them and must be identified as backing-coupled.

### Scoped model digests and physical representations

Expanded child files and rolled-up child sets are representations of the same
logical nodes. `_store.csv`, `_store.json`, and `_store.jsonl` represent the
enclosing node's immediate schema-governed children. `_store.sqlite3` may
represent a table's immediate rows or a database container's table/row subtree.
The provider exposes those children through ordinary node and children APIs;
reserved store files are not themselves row children.

The exact representation revision and the schema-normalized, store-scoped model
digest are separate. This digest is defined for the collection/subtree schema;
it is not a universal serialization or hash for all Arbor trees. Reformatting
JSON or CSV advances exact authored tree state without changing row identity or
the scoped digest. A representation migration may preserve the digest while
changing exact bytes. Updates name the complete candidate tree and may carry
compact patches to representation bytes, but the authority decodes
base/current/candidate under quotas, merges by stable node identity where safe,
validates the complete schema and constraints, and computes the accepted model
digest itself.

### Relational capability of the node query language

The general query contract is defined by [executable documents](07-executable-documents.md#queries).
A database relation or schema-governed collection is a typed node set within
that language, not a separate query universe. Its portable surface is the same
property filtering, field picking, and cardinality available to ordinary
`arbor(path).children` sources. A relational capability extension may
add proved relationships, joins, aggregates, grouping, ordering, and
transaction-domain metadata; providers may compile those operators to SQL or
another native plan. Unsupported extensions fail before data access.

A mutable collection has a declared primary key. The key may be compound, but
it must be stable, non-null, serializable, and independent of row position,
SQLite `rowid`, a display label, or a database query plan. That declaration is
the stable-key rule declared by the collection's children capability. A row
uses the same uniform `(TreeID, current path, stable key)` reference as every other node; its
third component is derived from the declared key fields in order. Each key
field's Standard Schema output is a canonical JSON scalar: a string, boolean,
or finite number. A backing value that cannot be represented exactly in one of
those forms must be normalized to a string by the schema before it can be a
portable key.

The canonical row key uses the data model's canonical key encoding: RFC 8785
JSON for an array of `[field, value]` pairs in declaration order. Drivers encode
that value opaquely in node references rather than concatenating display
strings. A row's logical child segment is its
single string key when that is a valid nonempty logical path component and does
not begin with the reserved `~row-` prefix; otherwise it is `~row-` followed by
the unpadded base64url encoding of the canonical row key.
Changing a key is observed as removal of one child and creation of another.

A read-only collection may expose synthetic positional paging keys, but the
corresponding node references have a null stable key. Those rows are not durable
node identities and executable-document handles cannot use the paging keys for
mutation or durable references. Duplicate, missing, invalid, or noncanonical
declared keys are diagnostics and disable mutation rather than silently falling
back to position.
The portable query baseline over any `arbor(path).children` source is predicate
filtering plus explicit field picking and cardinality. It orders results
automatically by canonical stable key, falling back to canonical path. Authored
ordering, relationships, aggregates, joins, and pagination operators are not
portable in this version. A placement-dependent extension may expose them only
when the application manifest declares and every allowed placement proves that
capability.

Input validation, authenticated-user requirements, predicate evaluation, field
shaping, cardinality checks, and canonical-key comparison have one portable
meaning independent of provider. A native pushdown must produce that meaning;
backing-default comparison or collation is not an acceptable substitute.

Where a relational extension supplies explicit ordering, a proved stable key is
the deterministic final tie-breaker. Live or mutable pagination uses a
revision-bound keyset cursor rather than an unqualified offset.

Relational node-set queries use ordinary TypeScript to construct the same closed
declarative selection graph as other node queries rather than imperative CRUD
calls, runtime ORM objects, or a second textual query language. `query.many`,
`query.one`, and `query.maybe` assert source cardinality. When their source is a
schema-derived relation handle, the plan callback additionally receives proved
fields, relationships, aggregates, and relational controls. Omitting the
optional Standard Schema input validator means that the handle takes no input;
callers use `useQuery(handle)` rather than supplying an empty object.

```tsx
import { z } from "zod"

const arborProfiles = arbor("./data/arbor_profiles").children
const lists = arbor("./data/lists").children
const profileCard = arborProfiles.pick("id", "name", "handle", "portrait")

export const list = query.maybe(
  lists,
  z.object({ id: z.string().uuid() }),
  (list, { input, user }) => ({
    where: [
      list.id.eq(input.id),
      list.visibility.eq("public").or(
        list.owner_profile.eq(user.profile),
      ),
    ],

    select: {
      ...list.pick("id", "name", "about"),
      ownerProfile: list.owner_profile,
      owner: list.owner(profileCard),

      items: list.items({
        orderBy: item => item.position,
        select: item => ({
          position: item.position,
          practice: item.practice(practice => ({
            ...practice.pick("id", "name", "about"),
            authors: practice.authors({
              orderBy: author => author.name,
              select: profileCard,
            }),
          })),
        }),
      }),
    },
  }),
)
```

The node, row, and relation values passed to plan callbacks are symbolic
schema-checked expressions, not loaded records. A callback constructs one
finite plan at compilation; it is never invoked once per result node or row.
It may use the closed methods supplied by those expressions, ordinary object
construction, and reusable plan fragments. It cannot branch on a symbolic
value, await data, call an arbitrary function over results, or acquire
filesystem, network, process, clock, randomness, credential, or undeclared-tree
access. Unsupported construction fails with a source-located diagnostic rather
than falling back to unbounded in-memory execution.

`where` accepts one typed predicate or an array whose members are AND-combined. Field expressions provide the portable comparison, null, membership, string, and boolean operators; predicates compose through explicit methods such as `.and()`, `.or()`, and `.not()`. The callback context exposes validated symbolic `input` and trusted symbolic `user`. `user.profile` is nullable-safe for a query that also admits anonymous execution; dereferencing `user.required.profile` declares that the query requires an authenticated Arbor user and fails before data access when none exists.

`select` is a plain object whose keys are the public result keys. Assigning a field under a different key aliases it. `row.pick("id", "name")` produces an explicit reusable field projection and may be spread into the result. There is no implicit select-all shortcut: fields crossing the query disclosure boundary remain visible in source. The return shape projects node/store facts, nested edges, and specified aggregates; it is not a general-purpose presentation expression language.

Schema relationships are callable symbolic relations. Calling one with a selection fragment or selection callback is the compact form; calling it with `{ where, orderBy, take, after, keyBy, select }` adds relational controls. A relationship carries its proved correlation and `one`, nullable-one, or `many` cardinality, so nested queries do not restate them. `.count` is a typed correlated aggregate. A bare field in `orderBy` means ascending; `.desc()` reverses it. Named relationship metadata is part of the portable schema fingerprint: drivers derive unambiguous candidates from declared keys, while product-named, through, ProfileID-backed, or otherwise non-obvious relationships require an explicit schema-adjacent declaration. Arbor never guesses a relationship from mutable names or a coincidental field spelling.

```tsx
export const popularLists = query.many(
  lists,
  list => ({
    where: list.visibility.eq("public"),
    orderBy: list.reactions.count.desc(),
    take: 12,

    select: {
      ...list.pick("id", "name", "about"),
      owner: list.owner(profileCard),
      practiceCount: list.items.count,
      reactionCount: list.reactions.count,
    },
  }),
)
```

`query.one` requires exactly one result and fails with a declared not-found/cardinality error otherwise. `query.maybe` yields zero or one value and rejects a plan that could silently choose among several rows. `query.many` yields an ordered collection. Every observably ordered repeated result has deterministic ordering. The compiler infers its stable key from the root primary key or relationship metadata and appends missing key fields as ascending final tie-breakers. If uniqueness cannot be proved, the author must supply `keyBy`; an unstable, nullable, or duplicate key is a compilation error.

Merely selecting a child relationship does not filter away a parent with no matching children. Filtering by child presence uses explicit `.exists()` or `.notExists()`. Flattening joins use explicit inner, left, semi, or anti plan operations. The relational plan may use reusable virtual relations, grouping, specified aggregates, explicit null handling, deterministic ordering, and revision-bound keyset pagination.

Compilation validates all addressed paths and fields, infers `ResultOf` for the handle and `RowOf` for its relations, and produces a backing-independent query meaning. A driver must preserve Arbor's specified null, comparison, collation, aggregate, and ordering semantics or reject the expression; it never silently substitutes backing-default behavior that changes a portable result. Unsupported operations fail before data access rather than loading an unbounded collection into executable memory.

A query that deliberately uses driver-specific SQL, functions, collation, full-text behavior, extensions, or cross-database facilities is backing-coupled and is identified as such in its compiled handle and consent statement. Raw SQL is not the portable intermediate representation and cannot interpolate an unchecked table name, path, predicate, or capability.

A mutation runs inside one transaction and may atomically change several collections when their handles resolve to that same store transaction domain. The runner passes the transaction as `tx`; authored handlers do not open or nest it. Arbor does not imply atomicity across a file collection, a separate SQLite database, a Postgres connection, or another Arbor tree. A handler requiring cross-domain effects must use a separately specified workflow rather than presenting them as one collection transaction.

Portable mutable schema includes primary and alternate unique keys, ordered
foreign-key field pairs, nullability, and explicit constraint actions. Primary
keys are immutable. The first portable foreign-key subset supports `restrict`,
`cascade`, and `set-null` on delete, with transaction-end validation sufficient
for declared deferred/cyclic inserts. `ON UPDATE CASCADE`, `SET DEFAULT`, and
backing-default collation or coercion are not portable unless a later contract
defines them. A foreign key may cross collections only inside one logical data
tree and one transaction domain. A cross-tree Arbor reference is a typed
authored property value, not a transactional foreign key.

A named mutation's accepted transaction contains all direct and cascading row
effects. A candidate update decoded from externally edited CSV, JSON, JSONL, or
SQLite is merged by stable row identity and then checked against the complete
schema. Arbor never invents cascade intent for an ambiguous concurrent file
edit; it reports a constraint conflict. Cross-file foreign-key atomicity is not
implied.

Ordered membership is a portable transaction concern rather than an application calculation based on row count. A transaction may open an ordered relation partition by naming its stable membership key and order field:

```ts
const items = tx.ordered(list_practices, {
  within: { list_id: listId },
  key: "practice_id",
  order: "position",
})

await items.append({ practice_id: practiceId })
await items.replace(practiceIds)
await items.remove(practiceId)
```

The driver serializes concurrent changes to that partition, verifies replacement keys exactly, and assigns or normalizes order values without temporarily violating a declared uniqueness constraint. The order field is observable data, but its temporary rewrite strategy is not. Counting current rows and inserting that count is not a conforming append because gaps and concurrent writers can collide.

### Revisions and committed change observation

Every store read is associated with an opaque store revision. A store observer yields changes only after the corresponding transaction commits and supplies an ordered cursor from which the runtime can establish a snapshot-then-follow boundary. Rollbacks and partial statements produce no visible change.

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

The schema evaluator accepts the authored schema and its declared schema-library import without ambient filesystem, network, process, clock, randomness, or secret access. It has finite resource bounds. This specification does not prescribe evaluator technology or generated-file layout.

## SQLite

`_store.sqlite3` makes the enclosing folder SQLite-backed. If `schema.ts` selects a collection/table, the folder is that collection; otherwise each introspected user table appears as a child collection of a database container. An ordinarily named `.sqlite3` file remains browsable as a database node but does not absorb its enclosing folder.

SQLite remains canonical and usable by ordinary SQLite tools. Row mutations run in SQLite transactions. Observation occurs at committed boundaries and snapshots are database-consistent; a live main database and WAL are never treated as unrelated files. Concurrent database revisions may conflict as whole-database units.

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
