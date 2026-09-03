# Smaller project 001: Preserve node identity across representations

## Status

- **Priority:** P1
- **Effort:** L
- **State:** PLANNED — extracted from Data 002; implementation begins after
  Data 011 lands the collection-file Wire shape and `childName` rule.
- **Depends on:** Data 002 stable keys, Data 011 collection-file descriptors
  and path rules, bounded placement, semantic update merge, and generic locator
  healing.

## Target result

One schema-governed logical child set may move between expanded Markdown
records, CSV, JSON, JSONL, SQLite, and later Postgres without changing its
TreeID, stable row identities, authored relative links, query/mutation handle
meaning, or application-visible component state once synchronization settles.
Exact representation bytes and physical filenames may change; logical node
identity and model equivalence do not.

## Logical path preservation

Expanded Markdown records retain authored readable filenames. Collection-file
rows otherwise derive collision-safe readable names from declared stable keys.
Equal keys and child-set hashes alone are therefore insufficient to promise
equivalent `NodeRef`s or ordinary Markdown navigation.

The specification supplies one provider-neutral mechanism: `schema.ts` may
declare a deterministic primary-key- or property-derived `childName` rule.

The converter uses an existing unique property when it can reproduce every
source logical name. Otherwise its dry-run reports the resulting renames or
requires a reviewed schema/property addition; it never
silently uses display names, mutable titles, row position, SQLite rowid, or
backing-specific table names.

## Migration protocol

1. Read the complete source at one exact revision and validate its schema,
   identities, relationships, constraints, and child-set hash.
2. Compute every target logical path and fail on collisions, reserved segments,
   invalid components, duplicate keys, or ambiguous existing relative links.
3. Produce the target representation without changing TreeID or stable keys.
4. Rewrite only relative links whose resolved target is proven to be a migrated
   node; retain application queries, content fragments, and stable-key aliases.
5. Compare the complete pre/post logical fixture, child-set and node model
   hashes, query
   results, mutation validation, child generation, search results, backlinks,
   and derived reference indexes.
6. Commit the representation and link changes as one accepted candidate tree
   update, or leave the source untouched.
7. Retain a reversible migration receipt naming exact source/target revisions,
   mapping decisions, diagnostics, and rollback material.

## Conformance corpus

Use one nontrivial fixture with compound and Unicode keys, authored filenames
that differ from keys, relative links, application queries, foreign keys,
ordered memberships, nullable values, and formatting-only changes. Use a
separate expanded-only fixture with nested Markdown content and children: the
property-only CSV/JSON/JSONL forms must reject that conversion rather than
claim equivalence. Materialize every fully representable fixture through each
supported backing and prove:

- identical stable refs and logical paths;
- identical properties, schemas, capabilities, child order, and model hashes;
- ordinary Markdown links open in non-Arbor editors;
- locator healing preserves key, query, and content-fragment components;
- portable queries and named mutations produce the same public results and
  accepted logical effects;
- search, backlinks, and locator healing continue to address the same stable
  nodes without exposing representation files; and
- round-trip migration returns to semantically identical Markdown without
  claiming byte identity where formatting was intentionally changed.

## Provider and exact-source continuations

- Separate authored relational names from reversible, collision-safe logical
  child segments. Cover spaces, slashes, Unicode normalization, reserved
  `~row-` prefixes, and same-named physical children without changing the
  relation name used by query and mutation handles.
- Preserve exact CSV/JSON/JSONL formatting through semantic merge where the
  authority's current source span remains identifiable. Canonical encoding is a
  fallback only for changed material whose exact form cannot be retained.
- Reuse the bounded-placement corpus when SQLite, Postgres, remote
  collection-file projections, and
  native offline projection gain direct providers. Include a 100k-row case
  proving generated placement does not grow authored Markdown source.

## Completion gate

Ship the reviewed path rule, converter, dry-run report, rollback receipt,
language-neutral fixtures, and at least Markdown ↔ JSON, Markdown ↔ CSV,
Markdown ↔ JSONL, and Markdown ↔ SQLite round trips. Then remove Data 002's
temporary statement that representation migration may preserve identity while
readable paths differ.
