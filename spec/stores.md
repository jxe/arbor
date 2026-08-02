# Stores and collections
*Part of the [Arbor spec](../spec.md): backing-independent collection behavior over Markdown, CSV, JSONL, SQLite, and Postgres.*

## Common collection contract

A collection is addressed by its logical folder path. Its backing is selected inside that folder and may change without changing the collection's locator, schema-facing API, views, or script handles.

A conforming store supplies:

- schema discovery or validation;
- ordered reads and stable row identity appropriate to the backing;
- atomic row mutations within that backing's transaction boundary;
- change observation without treating partial writes as commits;
- a consistent revision or snapshot representation;
- actionable diagnostics while preserving the last fully usable schema/view.

Portable collection queries and mutations have the same meaning across backings. Backing-specific relational operations may exist only where the addressed database provides them and must be identified as backing-coupled.

## File-backed collections

A file-backed collection contains `schema.ts` exporting exactly `export const schema = z.object(...)` and exactly one row representation:

- Markdown row files other than `_index.md`;
- one `_store.csv`; or
- one `_store.jsonl`.

`_store.csv` uses its header for field names. `_store.jsonl` has one JSON object per nonblank line. A Markdown row uses authored frontmatter for schema fields; its path, durable `id`, and body are Arbor metadata rather than row fields unless the common API explicitly projects them.

Mixing backing shapes produces a diagnostic and disables collection-level interpretation without making the underlying files inaccessible. Invalid rows are diagnostics, not daemon crashes or silent deletion.

The schema evaluator accepts the authored schema and its declared schema-library import without ambient filesystem, network, process, clock, randomness, or secret access. It has finite resource bounds. Exact evaluator technology and generated-file layout are reference choices.

## SQLite

`_store.sqlite3` makes the enclosing folder SQLite-backed. If `schema.ts` selects a collection/table, the folder is that collection; otherwise each introspected user table appears as a child collection of a database container. An ordinarily named `.sqlite3` file remains browsable as a database node but does not absorb its enclosing folder.

SQLite remains canonical and usable by ordinary SQLite tools. Row mutations run in SQLite transactions. Observation occurs at committed boundaries. Snapshots use a database-consistent backup/checkpoint mechanism and must never naïvely copy a live main database and WAL as unrelated files. Until logical SQLite changesets are standardized, concurrent database revisions may conflict as whole-database units.

## Postgres

`_store.postgres` is a non-secret reference:

```yaml
driver: postgres
connection: system:connections/production
schema: public
```

The referenced system record contains a safe label and connection metadata; its DSN, password, and equivalent secrets remain in the credential facility. Postgres is the data authority. Arbor introspects schemas, runs mutations in Postgres transactions, and observes committed changes. It synchronizes the safe reference as authored content, not a redundant database copy. Offline Postgres mirroring is not required.

## Schema and generated types

Schema information is mapped to canonical tree-rooted collection paths so scripts remain portable across local placements. Relative script references resolve against the script's tree/path before use. Database schema and file-schema changes refresh generated authoring support. If a schema or connection is temporarily invalid, the last valid generated types remain available but are marked stale and accompanied by a diagnostic.

Generated declarations, caches, and introspection artifacts are reproducible private/reference output, not portable authored content. Their syntax, location, and generator implementation are not part of this specification.

## Store migration

Replacing Markdown/CSV/JSONL rows with `_store.sqlite3`, or replacing a database marker with another supported backing, preserves the logical collection address and portable operations. Migration tooling must validate the destination before removing the source and must not claim atomicity across independent backing authorities unless it actually provides it.
