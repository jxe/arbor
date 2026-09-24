# Collection schemas

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

`@overstory/collection-schema` implements the declarative collection schema
profile of [child backings §2.4](../../overstory-spec/06-child-backings.md#24-collection-schema-profile):
a strict subset of CDDL, interpreted over JSON values, with three reserved
metadata rules. Interpreting a collection is parsing and checking data. Nothing
in canopyd, the merge worker or Arbor Sync evaluates JavaScript to read,
accept, project or merge a collection, and QuickJS is no longer a dependency
of any package.

## Pieces

- `lexer.ts`, `parser.ts`: the profile grammar only. Valid CDDL outside the
  profile (control operators, generics, group choices, `=>` keys, tuples,
  tags, byte strings, sockets, hexadecimal numbers) is rejected with
  `unsupported-syntax` at its source location, never skipped. Token,
  syntax-node, rule, nesting, choice, member and literal-size limits are
  enforced while lexing and parsing.
- `compile.ts`: rule resolution, prelude checks, cycle rejection (Tarjan, first
  cyclic rule in source order), expanded depth and size through references,
  the metadata rules, and the runtime check graph. Literal-only choices compile
  to one set lookup; literal checks and keys are interned.
- `validate.ts`: a decision, never a normalization. Row and collection-file
  step budgets are counted per type visit and examined object member; paths
  are materialized as JSON Pointers only for diagnostics.
- `csv.ts`: schema-directed cell conversion and the round-trip-checked CSV
  encoder (§2.4.5).
- `collection-file.ts`: source decoding for CSV, JSON and JSONL, the
  version-2 wire decoder used by canopyd acceptance and projection and by the
  merge rules, and the canonical child-set hash (keys ordered by UTF-8 bytes).
- `typescript.ts`: static declarations for Arbor Sync's generated
  `tree.gen.d.ts`; no authored module or Zod import is emitted.
- `cache.ts`: a content-addressed LRU keyed by the SHA-256 of the exact
  schema bytes, bounded by entry count (64) and summed syntax nodes (262,144).
  A failed compilation is thrown and never cached.

Diagnostics are deterministic: the first failure of the first failing phase
(bytes, lexing, parsing, profile version, rules, references, cycles, `row`,
expanded budgets, primary key, child name), with a 1-based line and a column
counted in Unicode scalar values.

## Parser choice

The profile is small enough that implementing exactly its grammar is simpler
and safer than adopting a general CDDL implementation. The maintained npm
parser [`cddl`](https://www.npmjs.com/package/cddl) 0.23.0 (MIT) was evaluated
and not adopted: it describes itself as work in progress, ships CLI runtime
dependencies (`yargs`, `camelcase`), has no validator for this value model, and
enforces no resource limits.

It was used once, offline, as a second independent implementation over the
conformance corpus: every accepted schema and accepted generated budget case
parses as standard CDDL. Coverage limitation: that parser itself rejects
several valid RFC 8610 constructs the profile also rejects (generics, byte
strings, `&`, group entries, a type choice between maps) and treats EOF and
control-character inputs differently, so it cannot confirm that every reject
vector is otherwise-valid CDDL; it does parse the control-operator, `/=`, `//`,
`=>`, tag, tuple, parenthesized and prelude-type rejections.

## Wiring

| Consumer | Uses |
|---|---|
| canopyd acceptance (`Canopy.validateGraph`) | `decodeWireCollectionFile` with the host's `CollectionSchemaCache`; version-1 descriptors are `422 unsupported-operation`, and in the accepted basis they are left unproven so only a candidate that replaces them is accepted |
| canopyd projection and public pages (`WireProjection`) | `decodeWireCollectionFile`; a version-1 collection read is `422 unsupported-operation` |
| `tree-merge` (`collection-file-rows-v1`) | decode and encode; any version-1 side is a `collection-file-schema-conflict` |
| Arbor Sync providers and snapshots | `schema.cddl` discovery, CSV conversion, row validation and writes, version-2 descriptors; a directory with `schema.ts` reports `legacy-collection-schema` (or `ambiguous-collection-schema` beside `schema.cddl`), and a `schema.ts` collection file refuses to snapshot |
| Arbor Sync generated types | `collectionTypeDeclarations` |

Database backings keep their introspected schemas; `schema.cddl` beside
`_store.sqlite3` or `_store.postgres` is a mixed-backing diagnostic. No
schema-file table selection existed to replace.

The retired `schema.ts` is interpreted only by the offline converter,
[migration 021](../../../packages/canopyd/migrations/021-cddl-collection-schemas/README.md),
which imports the trusted authored module with the checkout's development Zod
and proves row identity before writing `schema.cddl`.

`tests/unit/collection-schema-boundary.test.ts` checks manifests and the
lockfile, bundles each shipped entrypoint (canopyd, the merge worker,
`tree-merge`, Arbor Sync, `arbor`) to inspect its resolved module closure, and
runs acceptance decoding, projection, merge and local reads in a disposable
process where any QuickJS import fails.

## Measurements

Bun 1.3.14, Linux x64, one process, 2026-09-24. The retired QuickJS sandbox,
measured on the same machine before removal with a five-field Zod object:
214 ms cold compile, 44 µs per row warm validation, and 114 MB more RSS for one
sandbox.

| Case | Result |
|---|---|
| Five-member schema: cold compile / warm validation | 4.5 ms / 0.8 µs per row |
| 1,024 members, each a 25-literal choice (199,632 bytes, 27,650 syntax nodes) | 71 ms compile, 534 µs per row, about 4.4 MB retained |
| DAG at 2^13 expanded map nodes with non-literal choices | 0.7 ms compile, 6.4 ms per maximal row |
| 1 MiB source (comments) | 52 ms compile |
| 100,000 JSONL rows against the five-member schema | 342 ms decode and validation |
| Cache filled with 64 profile-wide schemas | 120 MB RSS growth: the weight bound keeps at most eight |

The row and collection step budgets, not wall time, bound worst-case
validation.
