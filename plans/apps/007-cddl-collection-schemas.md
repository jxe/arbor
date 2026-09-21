# Apps 007: Declarative CDDL collection schemas

## Status, intent and order

**P1 · PLANNED · L effort · high migration risk.** Planned at `d55f4142`,
2026-09-21. Execute before [Apps 005](005-source-resolution-and-sidecar.md).
Numbers are stable identifiers, not execution order. This plan replaces executable
collection schemas with a bounded CDDL contract; Apps 005 subsequently extracts
application execution. Neither plan authorizes live-data, installed-app or public-host
changes. Read [DEVELOPMENT.md](../../DEVELOPMENT.md) first.

A collection's interpretation must not require authored JavaScript. Use
[CDDL (RFC 8610)](https://www.rfc-editor.org/rfc/rfc8610.html) for readable schema
source, with an explicit Overstory profile. Do not substitute CUE, a Zod subset,
or a generated JSON Schema file as the authoritative source. Pure internal compiled
representations are implementation details. Application business logic stays separate.

## Baseline and scope

Run `git status --short` and
`git diff --stat d55f4142..HEAD -- packages swift docs tests examples tools`.
Reconcile changed code with this baseline before edits; preserve unrelated work.

Current load-bearing seams:

- `packages/apps-runtime/src/collections/schema.ts` imports `getQuickJS`, bundles
  authored Zod with `Bun.build`, and exposes `SchemaSandbox.compileSource` and
  `validateSource`. Its description includes columns, primary key, child-name rule
  and an exact-source revision. Validation currently returns Zod-normalized values.
- `packages/apps-runtime/src/collections/collection-file.ts` decodes exact bytes,
  checks schema fingerprints, validates rows and derives `childSetHash`.
- `packages/canopyd/src/canopy.ts` owns `private readonly wireSchemas = new SchemaSandbox()`;
  `validateGraph` calls `decodeWireCollectionFile`. This is acceptance work, not app execution.
- `packages/canopyd/src/projection.ts`, `WireProjection.collectionFile`, creates a
  sandbox for ordinary collection projection. `packages/canopyd-merge/src/merge-rules.ts`
  uses it during collection merges too.
- `packages/arborsync/src/state/providers/{discovery,file-provider}.ts`,
  `state/projection-provider-host.ts` and `generated-types.ts` discover and interpret
  `schema.ts`. Inspect database/table-selection behavior as well as file backings.
- `packages/protocol/src/model/node-model.ts` fixes `schemaSource: "schema.ts"`
  and descriptor version 1. `objects.ts` restricts physical entries accordingly.
  `swift/Packages/Overstory/Sources/Overstory/WireObjects.swift` enforces the same name;
  `CanopyWorkingTree` copies, hashes and serializes descriptors.
- `tests/integration/collections.test.ts` writes `count: z.coerce.number()` in CSV
  fixtures, and tests lossless writes, keys and logical names. Coercion cannot simply
  disappear without an explicit replacement in the CSV codec.

Scope: those packages and direct schema consumers; a new pure
`packages/collection-schema` package; package manifests/lock and packaging tools;
TS/Swift protocol models and affected clients/tests; collection fixtures/examples;
portable spec, conformance corpus, architecture/usage docs and plan indexes.
Any offline migration belongs under `packages/canopyd/migrations/` using the next
available number and its README procedure. No app API redesign, SQL schema migration,
React work, unrelated editor changes or deployment in this implementation task.
Do not remove Zod from unrelated consumers. Do not commit or push unless requested.

## 1. Freeze the portable profile and migration inventory

Inventory every checked-in `schema.ts`, including schemas embedded in test strings,
all `SchemaSandbox` callers and `SchemaDescription.jsonSchema` consumers. Read
`docs/overstory-spec/06-child-backings.md`, `01-tree-operations.md` (descriptor and
hashing), `02-directory-format.md`, `03-locators.md`, and `07-executable-documents.md`.
Create a feature matrix covering types, enums, optional/nullable values, unknown
properties, defaults, stripping, coercions, transforms, refinements, primary keys,
child names, and database selection. Distinguish necessary behavior from incidental
Zod behavior. Inspect only explicitly supplied disposable data copies for migration;
request operator inventory before any real-data conversion.

Define `schema.cddl`, root rule `row`, and an initial explicitly versioned profile:
JSON strings, booleans, null, finite numbers, integer constraints, string literals,
closed string-keyed records with optional members, homogeneous arrays, finite type
choices, numeric ranges, and local acyclic named rules. Specify exact integer and
number boundaries shared with existing `JSONValue`, Unicode/string sizing and
unknown-field behavior. Start with no recursive definitions, generics, dynamic keys,
CBOR-only values/tags, external resolution, regexes, executable extensions or
unlisted control operators. Add only a feature demonstrated by the inventory with
bounded semantics and vectors; unsupported syntax must reject, never degrade.

Keep identity metadata inside the fingerprinted source using reserved CDDL rules
whose permitted syntax is literal-only. Proposed profile notation to freeze in the
spec and vectors before implementation:

```cddl
overstory-schema-version = 1
overstory-primary-key = ["id"]
overstory-child-name = "slug"

row = {
  id: tstr,
  slug: tstr,
  title: tstr,
  ? description: tstr,
  quantity: 0..1000
}
```

These are valid CDDL definitions; their interpretation as collection metadata is an
Overstory convention, not part of RFC 8610. Absent key means existing read-only /
Markdown-id behavior; absent child-name means derive names from the key. Require
unique required key fields in tuple order and a required string field for an explicit
child-name. Reject extra reserved rules and nonliteral metadata. Keep ordering used
for generated columns explicit and deterministic. Hash exact UTF-8 source bytes,
including metadata and comments; do not hash a pretty-printed AST instead.

Validation must not insert defaults, strip fields, or execute transforms. Define
CSV text-to-value conversion separately: unambiguous schema-directed scalar parsing,
explicit empty-versus-null policy, rejection of ambiguous union conversions, and no
loss of string keys such as `001`. JSON/JSONL already contain typed values; preserve
them. Document any deliberate behavior change and conversion blocker.

Specify numeric limits for source bytes, tokens/AST nodes, nesting, expanded rule
work, row size and validation steps before implementation. Retain the existing
1 MiB schema ceiling unless measurements justify lowering it; parser and validator
must both enforce limits. Non-Turing-completeness alone is not a resource bound.

**Verify:** add `tests/unit/collection-schema.test.ts` and portable
`docs/overstory-spec/conformance/collection-schemas.json` with syntax/metadata,
value and budget vectors. During this specification step, run `bun run check:links`
and `git diff --check` → exit 0. Subsequent implementation must make every vector pass.

## 2. Implement a pure parser and validator

Select a maintained parser only after checking license, supported RFC syntax,
transitive runtime dependencies and resource limits against the profile. Otherwise
implement only the documented grammar, with explicit rejection of the remainder;
do not invent CDDL-like syntax. Record the choice in architecture docs. Use a second
independent CDDL implementation to check representative standard-syntax fixtures
where available; record the checked version and any coverage limitation.

Put parsing, profile checks, schema descriptions, validation and logical-name rules
in `@overstory/collection-schema`, independent of apps-runtime, QuickJS, runtime
code generation and network/filesystem access. Keep codecs reusable without importing
an executable-runtime barrel. A content-addressed bounded cache may hold immutable
compiled schemas; compilation failure never produces an accepted cache entry.
Preserve structured diagnostics and source locations. Adapt generated-type consumers
to the new schema description rather than preserving Zod as a hidden dependency.
In particular, `generated-types.ts` currently emits imports from `schema.ts` and
`Collection<z.infer<typeof SchemaN>>`; generate equivalent static declarations from
CDDL instead. Add `tests/unit/collection-schema-types.test.ts` covering optional and
nullable fields, literal unions, arrays, named types and deterministic regeneration;
its generated fixture must typecheck without authored schema modules or Zod imports.

**Verify:** `bun test tests/unit/collection-schema.test.ts` → all vectors pass,
including malformed UTF-8, duplicate/unknown rules, unsupported syntax, cycles,
large unions, budget exhaustion, numeric edges and deterministic diagnostics.

## 3. Version the wire contract and settle retained history

Introduce a new collection descriptor version selecting `schema.cddl`; never
reinterpret existing version-1 objects or change their hashes. Update TS and Swift
encoders/decoders, directory entry invariants, private representation hiding, schema
fingerprints and conformance fixtures together. Profile version and descriptor version
are distinct. Mixed `schema.ts`/`schema.cddl` discovery rejects ambiguity explicitly.

Before switching default writers, record the exact old-root policy. Immutable old
objects and their bytes remain retrievable. Inventory whether supported historical
logical projection, offline updates, restore and merge require interpreting old
schemas. Select and test an explicit compatibility/cutover mechanism; do not silently
turn historical collections into ordinary directories or accept unvalidated rows.
A version error is acceptable only at a documented unsupported operation boundary,
not as an unnoticed regression in previously promised history/restore behavior.

An offline converter may evaluate trusted legacy schemas in its isolated migration
process, but no ordinary host, merge worker or local-provider path may fall back to
QuickJS. Unsupported legacy transforms/refinements require a reported blocker or
explicit authored replacement; never claim generic Zod-to-CDDL equivalence. If
historical semantics cannot be preserved without a runtime legacy evaluator, stop
and bring that compatibility decision back before implementation proceeds.

Convert copies first. Preserve TreeIDs, stable keys, logical names, row values,
Markdown bodies, collection source bytes and retained roots. New schema files and
necessary descriptor/root hashes change through explicit updates or the repository's
offline migration procedure; do not rewrite content-addressed history. Check repeated
conversion, interruption, dry-run diagnostics and matched-version rollback. Back up
and reconcile queued old-client writes before any separately authorized live cutover.

**Verify:** `bun run test:protocol` and
`swift test --package-path swift/Packages/Overstory` → pass new/old descriptor and
hash vectors. Run any added migration's explicit command from its README against
disposable copies → identity comparisons and interrupted/repeated conversion pass.

## 4. Switch all collection paths and remove schema execution

Update file discovery, expanded Markdown validation, compact CSV/JSON/JSONL codecs,
local projection and edits, generated types, canopyd graph acceptance/projection,
and merge rules to the pure schema package. Keep database-introspected schemas and
provider selection separate from the CDDL file-backed contract; replace any legacy
schema-based table selection declaratively and test it. Move pure collection codecs
out of apps-runtime as needed so acceptance never depends on application activation.

Convert current examples and tests without modifying historical migration evidence.
Preserve existing row ordering, duplicate-key/name rejection, primary-key immutability,
source-preserving writes and conflict behavior. Update portable prose that currently
requires evaluating `schema.ts`; maintain explicit legacy documentation where needed.
Remove `SchemaSandbox` and QuickJS from production schema paths and their dependency
closures, including merge package barrels. Migration-only legacy tooling, if needed,
must have isolated dependencies and never ship in the daemon's runtime closure.

Add `tests/unit/collection-schema-boundary.test.ts`, following the repository's
package-boundary test style but inspecting resolved transitive imports as well as
manifests. Include canopyd, merge and Arbor Sync entrypoints. Test with QuickJS
unavailable in a disposable packaging fixture; merely avoiding `getQuickJS()` is
insufficient. Apps 005 later removes remaining application execution imports.

**Verify:**

```sh
bun test tests/unit/collection-schema.test.ts tests/unit/collection-schema-types.test.ts tests/unit/collection-schema-boundary.test.ts
bun test tests/integration/collections.test.ts tests/unit/protocol-objects.test.ts tests/unit/canopyd/update-merge.test.ts
bun test tests/unit/canopyd-merge tests/integration/canopyd-merge
swift test --package-path swift/Packages/CanopyWorkingTree
```

All pass. Include real local-provider and host tests of valid/invalid CDDL collection
updates, projection, merge, restart and source fidelity with no apps sidecar running.
Record cold/warm validation and bounded-cache memory measurements, including worst-case
accepted profile inputs; compare to the baseline rather than inventing performance wins.

## Final gates and completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol`, `bun run build`,
`bun run test:performance`, `swift test --package-path swift/Packages/ArborSyncClient`,
`bun run check:links`, and `git diff --check` → all exit 0. Run affected packaging
checks (`bun run build:cli:package`, `bun run test:cli:package`) if their inputs changed.
Use `swift/scripts/test-canopy-editor-local.sh` if editor tests are affected; never
standalone SwiftPM commands against editable CanopyEditor.

Done requires portable vectors, exact-source fingerprints, tested conversion and
retained-history policy, unchanged supported row identity/fidelity, and collection
operations without JavaScript evaluation or an apps process. The transitive runtime
boundary must prove QuickJS absent; report artifact/image contents separately from
process dependencies. Stop on unexplained identity/value changes, unsupported legacy
semantics, a need for runtime code execution, or inability to bound validation work.

Record implemented/tested versus installed/deployed evidence separately in `status.md`
and architecture docs. Repair inbound links, delete this completed plan and update
indexes; do not move it to a completed-plans directory. Future profile extensions
require a version/compatibility assessment and cross-language vectors.
