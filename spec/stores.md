# Stores and collections
*Part of the [Arbor spec](../spec.md): backing-independent collection behavior over Markdown, CSV, JSONL, SQLite, and Postgres.*

## Common collection contract

A collection is addressed by its logical folder path. Its backing is selected inside that folder and may change without changing the collection's locator, schema-facing API, views, or executable-document handles.

A conforming store supplies:

- schema discovery or validation;
- ordered reads and stable row identity appropriate to the backing;
- atomic row mutations within that backing's transaction boundary;
- change observation without treating partial writes as commits;
- a consistent revision or snapshot representation;
- actionable diagnostics while preserving the last fully usable schema/view.

Portable collection queries and mutations have the same meaning across backings. Backing-specific relational operations may exist only where the addressed database provides them and must be identified as backing-coupled.

### Portable relational query language

A mutable collection has a declared primary key. The key may be compound, but it must be stable, serializable, and independent of row position, SQLite `rowid`, or a database query plan. A read-only collection may expose synthetic positional keys, but executable-document handles cannot use those keys for mutation or durable links. Results have explicit ordering with a proved stable key as a deterministic final tie-breaker. Live or mutable pagination uses a revision-bound keyset cursor rather than an unqualified offset.

Portable database queries use ordinary TypeScript to construct a closed declarative plan rather than imperative CRUD calls, runtime ORM objects, or a second textual query language. `query.many`, `query.one`, and `query.maybe` declare root cardinality. They take a schema-derived relation handle, an optional Standard Schema input validator, and a plan callback. Omitting the validator means that the handle takes no input; callers use `useQuery(handle)` rather than supplying an empty object.

```tsx
import { z } from "zod"

const { arbor_profiles, lists } = suppliesData.relations
const profileCard = arbor_profiles.pick("id", "name", "handle", "portrait")

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

The row and relation values passed to plan callbacks are symbolic schema-checked expressions, not loaded records. A callback constructs one finite plan at compilation; it is never invoked once per database row. It may use the closed methods supplied by those expressions, ordinary object construction, and reusable plan fragments. It cannot branch on a symbolic value, await data, call an arbitrary function over rows, or acquire filesystem, network, process, clock, randomness, credential, or undeclared-tree access. Unsupported construction fails with a source-located diagnostic rather than falling back to in-memory execution.

`where` accepts one typed predicate or an array whose members are AND-combined. Field expressions provide the portable comparison, null, membership, string, and boolean operators; predicates compose through explicit methods such as `.and()`, `.or()`, and `.not()`. The callback context exposes validated symbolic `input` and trusted symbolic `user`. `user.profile` is nullable-safe for a query that also admits anonymous execution; dereferencing `user.required.profile` declares that the query requires an authenticated Arbor user and fails before data access when none exists.

`select` is a plain object whose keys are the public result keys. Assigning a field under a different key aliases it. `row.pick("id", "name")` produces an explicit reusable field projection and may be spread into the result. There is no implicit select-all shortcut: fields crossing the query disclosure boundary remain visible in source. The return shape projects database facts, nested relations, and specified aggregates; it is not a general-purpose presentation expression language.

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

A file-backed collection contains `schema.ts` exporting exactly `export const schema = z.object(...)` and exactly one row representation:

- Markdown row files other than `_index.md`;
- one `_store.csv`; or
- one `_store.jsonl`.

`_store.csv` uses its header for field names. `_store.jsonl` has one JSON object per nonblank line. A Markdown row uses authored frontmatter for schema fields; its path, durable `id`, and body are Arbor metadata rather than row fields unless the common API explicitly projects them.

Mixing backing shapes produces a diagnostic and disables collection-level interpretation without making the underlying files inaccessible. Invalid rows are diagnostics, not daemon crashes or silent deletion.

The schema evaluator accepts the authored schema and its declared schema-library import without ambient filesystem, network, process, clock, randomness, or secret access. It has finite resource bounds. This specification does not prescribe evaluator technology or generated-file layout.

## SQLite

`_store.sqlite3` makes the enclosing folder SQLite-backed. If `schema.ts` selects a collection/table, the folder is that collection; otherwise each introspected user table appears as a child collection of a database container. An ordinarily named `.sqlite3` file remains browsable as a database node but does not absorb its enclosing folder.

SQLite remains canonical and usable by ordinary SQLite tools. Row mutations run in SQLite transactions. Observation occurs at committed boundaries and snapshots are database-consistent; a live main database and WAL are never treated as unrelated files. Concurrent database revisions may conflict as whole-database units.

External-write observation must detect committed changes made through other processes or connections. When affected rows cannot be recovered precisely, the driver emits a whole-store invalidation after the external commit. A wakeup alone is never treated as proof of a committed row change.

An authority-hosted SQLite executable document coordinates committed writes with accepted updates for the containing tree, durably records mutation completion before acknowledgement, and advances the tree only from a consistent database state. Changing backing at the same logical database path does not change portable handles.

## Postgres

`_store.postgres` is a non-secret reference:

```yaml
driver: postgres
connection: system:connections/production
schema: public
```

The referenced system record contains a safe label and connection metadata; its DSN, password, and equivalent secrets remain in the credential facility. Postgres is the data authority. Arbor introspects schemas, runs mutations in Postgres transactions, and observes committed changes. It synchronizes the safe reference as authored content, not a redundant database copy. Offline Postgres mirroring is not required.

External Postgres observation treats notifications only as commit wakeups, never as the data authority or a durable replacement for rereading state. On listener loss, overflow, unknown payload, or cursor discontinuity, the driver widens invalidation and reestablishes a fresh snapshot boundary. A connection without precise observation must conservatively invalidate and cannot claim precise live updates.

## Data disclosure

Collection access and executable-document result access are distinct. Publishing a component or query result does not make the backing tree, SQLite file, Postgres connection, or unrelated rows readable. Conversely, putting public and private rows in a publicly readable Arbor tree exposes the backing bytes regardless of query filters. Sites containing row-private data keep the raw data boundary private to the source tree's execution principal or split data into separate Arbor trees, then expose only validated query results.

## Schema identity

Schema information and explicit relationship declarations are mapped to canonical tree-rooted collection paths so executable source remains portable across placements. Relative collection references resolve against the source tree and path before use. A database schema, file schema, or relationship change changes the corresponding schema fingerprint and invalidates dependent compiled handles. Derived declarations, caches, and introspection artifacts are not authored tree content or portable artifacts.

## Store migration

Replacing Markdown/CSV/JSONL rows with `_store.sqlite3`, or replacing a database marker with another supported backing, preserves the logical collection address and portable operations. The transition is not atomic across independent backing authorities unless the implementation actually provides that guarantee.
