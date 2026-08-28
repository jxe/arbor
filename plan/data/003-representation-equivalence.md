# Data 003: Preserve node identity across representations

## Status

- **Priority:** P1
- **Effort:** L
- **State:** PLANNED — extracted from Data 002; implementation begins only
  after Data 002 closes its common local/Wire node and rollup protocol.
- **Depends on:** Data 002 stable keys, rollup descriptors, bounded placement,
  semantic update merge, and generic locator healing.

## Target result

One schema-governed logical child set may move between expanded Markdown
records, CSV, JSON, JSONL, SQLite, and later Postgres without changing its
TreeID, stable row identities, authored relative links, query/mutation handle
meaning, or application-visible component state once synchronization settles.
Exact representation bytes and physical filenames may change; logical node
identity and model equivalence do not.

## The unresolved path problem

Expanded Markdown records retain authored readable filenames. Rolled-up rows
derive collision-safe readable segments from declared stable keys. Those rules
do not automatically produce the same current path, so equal keys and model
digests alone are insufficient to promise equivalent `NodeRef`s or ordinary
Markdown navigation.

Before implementation, choose and specify one provider-neutral rule:

1. a schema-declared logical path property or formatter whose output is unique,
   stable, reversible where required, and validated for every representation;
2. a durable key-to-readable-path map carried with the logical collection; or
3. a reviewed converter that renames expanded files to the canonical key-derived
   path as part of representation migration.

Do not silently use display names, mutable titles, row position, SQLite rowid,
or backing-specific table names. Do not claim representation equivalence until
the selected rule has been reviewed with the user.

## Migration protocol

1. Read the complete source at one exact revision and validate its schema,
   identities, relationships, constraints, and scoped model digest.
2. Compute every target logical path and fail on collisions, reserved segments,
   invalid components, duplicate keys, or ambiguous existing relative links.
3. Produce the target representation without changing TreeID or stable keys.
4. Rewrite only relative links whose resolved target is proven to be a migrated
   node; retain application queries, content fragments, and stable-key aliases.
5. Compare the complete pre/post logical fixture, scoped model digest, query
   results, mutation validation, child generation, search results, backlinks,
   and derived reference indexes.
6. Commit the representation and link changes as one accepted candidate tree
   update, or leave the source untouched.
7. Retain a reversible migration receipt naming exact source/target revisions,
   mapping decisions, diagnostics, and rollback material.

## Conformance corpus

Use one nontrivial fixture with compound and Unicode keys, authored filenames
that differ from keys, nested Markdown content, relative links, application
queries, foreign keys, ordered memberships, nullable values, and formatting-
only changes. Materialize it through every supported representation and prove:

- identical stable refs and logical paths;
- identical properties, schemas, capabilities, child order, and model digest;
- ordinary Markdown links open in non-Arbor editors;
- locator healing preserves key, query, and content-fragment components;
- portable queries and named mutations produce the same public results and
  accepted logical effects;
- search, backlinks, and locator healing continue to address the same stable
  nodes without exposing representation files; and
- round-trip migration returns to semantically identical Markdown without
  claiming byte identity where formatting was intentionally changed.

## Completion gate

Ship the reviewed path rule, converter, dry-run report, rollback receipt,
language-neutral fixtures, and at least Markdown ↔ JSON, Markdown ↔ CSV,
Markdown ↔ JSONL, and Markdown ↔ SQLite round trips. Then remove Data 002's
temporary statement that representation migration may preserve identity while
readable paths differ.
