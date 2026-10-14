# Collection schemas

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

`@ovst/collection-schema` implements the collection schemas of
[child backings §2.4](../../overstory-spec/06-child-backings.md#24-collection-schemas):
a collection's `schema.usl`, in the
[schema language](../../overstory-spec/11-schema-language.md), compiled by
[`@ovst/usl`](../../../packages/usl/README.md) and interpreted over JSON values.
Interpreting a collection is parsing and checking data. Nothing in overstoryd,
the merge worker or Story Sync evaluates JavaScript to read, accept, project or
merge a collection, and QuickJS is no longer a dependency of any package.

## Pieces

- `compile.ts`: `compileUsl`, then the schema's data-file layout
  (`layoutOf(result, { store: "files" })`), which must be exactly one table:
  the collection's rows. Its columns become the runtime check graph (fixed
  references compile to one set lookup; folded connections to arrays of keys),
  its primary key the stable key, and its `@path` field the child name. The
  row map is always open. USL diagnostics pass through with their codes and
  locations.
- `validate.ts`: a decision, never a normalization. Row and collection-file
  step budgets are counted per value visited and object member examined; an
  open map's undeclared members are accepted without being examined, so a
  row's cost depends on its declared shape. `null` in an optional member means
  absent. Paths are materialized as JSON Pointers only for diagnostics.
- `csv.ts`: schema-directed cell conversion and the round-trip-checked CSV
  encoder (§2.4.3). Array columns are JSON cells. An undeclared column
  converts as an optional text member; the encoder appends undeclared members
  after the declared columns in order of first appearance and rejects any it
  could not read back unchanged.
- `collection-file.ts`: source decoding for CSV, JSON and JSONL, the
  descriptor decoder used by overstoryd acceptance and projection and by the
  merge rules, and the canonical child-set hash (keys ordered by UTF-8 bytes).
  Undeclared members are ordinary properties there: they enter the child-set
  hash and every re-encoding.
- `typescript.ts`: static declarations for Story Sync's generated
  `tree.gen.d.ts`; no authored module or Zod import is emitted. The row
  renders with the index signature `[member: string]: unknown`, which admits
  every declared member's type and keeps declared members checked under
  `--strict --exactOptionalPropertyTypes`.
- `cache.ts`: a content-addressed LRU keyed by the SHA-256 of the exact
  schema bytes, bounded by entry count (64) and summed weight (members plus
  source size, 262,144). A failed compilation is thrown and never cached.

Markdown rows take their key from a frontmatter `id`, or are identified by
their file name without one (Story Sync's file provider).

## Wiring

| Consumer | Uses |
|---|---|
| overstoryd acceptance (`Overstoryd.validateGraph`) | `decodeProtocolCollectionFile` with the host's `CollectionSchemaCache` |
| overstoryd projection and public pages (`ProtocolProjection`) | `decodeProtocolCollectionFile` |
| `tree-merge` (`collection-file-rows-v1`) | decode and encode |
| Story Sync providers and snapshots | `schema.usl` discovery, CSV conversion, row validation and writes, collection descriptors |
| Story Sync generated types | `collectionTypeDeclarations` |

A `schema.usl` beside `_store.sqlite3` is read by `apps-runtime`
(`introspectStoreSchema`), not here: the database must implement the schema's
database layout, and connections become query relationships.

There is one collection descriptor version: version 1 names `schema.usl`.
CDDL was removed on 2026-10-14 before any collection used it, so nothing
converts or reads `schema.cddl`; a file of that name, like `schema.ts`, is
ordinary.

`tests/unit/collection-schema-boundary.test.ts` checks manifests and the
lockfile, bundles each shipped entrypoint (overstoryd, the merge worker,
`tree-merge`, Story Sync, `story`) to inspect its resolved module closure, and
runs acceptance decoding, projection, merge and local reads in a disposable
process where any QuickJS import fails.
