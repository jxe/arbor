# Schema language 001: replace CDDL with Ultimate Schema Language

**Why and when:** Joe decided on 2026-10-13 that using CDDL for collection
schemas was a mistake, and on 2026-10-14 named its replacement Ultimate Schema
Language (`.usl`, designed in [the workspace](README.md)). A collection today
can need three schema files (`schema.cddl` for files; `schema.sql` and
`relationships.json` for SQLite), and none of them says what a field means,
which field-level merge and Story's arrangements need. Do this before
[Schema language 002](002-cranberries-in-story.md).

## Status

- **Effort:** L
- **Risk:** MED. The collection descriptor's `schemaSource` is part of the
  protocol (TypeScript and Swift) and the node model hash, and existing trees
  hold `schema.cddl` files.
- **State:** PLANNED. `packages/usl` already parses, checks, writes setup SQL
  for SQLite and Postgres, validates rows, and checks SQLite, Postgres and data
  files against a schema.
- **Depends on:** nothing.
- **Unblocks:** Schema language 002; field-level merge for collections.

## Target result

A collection folder or database container holds one `schema.usl` beside its
data (`_store.sqlite3`, or one `.csv` / `.jsonl` / `.json` file per table).
Overstory reads, validates, merges and presents every collection through it,
and `schema.cddl`, `schema.sql` and `relationships.json` are gone from code,
spec, fixtures and examples.

## What Overstory uses CDDL for, and the USL equivalent

From a scan of every consumer of `@ovst/collection-schema` (Story Sync's file
provider, generated types and projection host; overstoryd acceptance and
projection; tree-merge's `collection-file-rows-v1`) and of
`apps-runtime/src/schema.ts` for SQLite:

| Overstory needs | CDDL profile today | USL (`packages/usl`) |
|---|---|---|
| columns and value types | `row` members: text, int, number, bool, literals, ranges, arrays, nested maps | value fields: `Text`, `Markdown`, `Int`, `Number`, `Bool`, `Date`, arrays; layout columns |
| enumerations | literal choices | fixed models (`@@fixed`), stored as the row name, with a `CHECK` in SQL |
| primary key | `overstory-primary-key` | the model's key: `id`, its ends, or `@@id(...)` |
| child names | `overstory-child-name` | `@@childName(field)` |
| references between rows | none (files); `relationships.json` (SQLite) | connections, with foreign keys in the layout |
| profiles | `virtualRelations` with `source: overstory-profile` | the built-in `Person` model |
| SQLite schema | `schema.sql`, which must match the database exactly | `usl sql sqlite` writes it; `verifyStore` checks a database |
| row validation | `validateRow` | `validateRow(table, row)` |
| CSV cells | `csvColumns`, strict number and boolean grammar | `fromCell` (same grammar; arrays are JSON) |
| generated types | `collectionTypeDeclarations` | `typeDeclarations` |
| fingerprint | SHA-256 of source bytes | `uslFingerprint`, the same |
| limits | bytes, tokens, depth, rules, and more | bytes, tokens and depth so far |
| diagnostics | codes with line and column | the same shape |

Not carried over, on purpose: integer ranges, text literals as types, nested
maps, and `null` as a value distinct from absence. None appears in a fixture
or example; a nested value can be `Markdown` or a separate model. Undeclared
columns in data files stay readable and are reported as warnings, as the
open `row` map allowed.

## Steps

1. **Spec.** Replace [06 §2.4](../../docs/overstory-spec/06-child-backings.md)
   with the USL profile: grammar, invariants (the checker's list), layout
   rules, limits, fingerprint. Replace §3's `schema.sql` and
   `relationships.json` with `schema.usl`. Rewrite the conformance vectors in
   `docs/overstory-spec/conformance/collection-schemas.json` for USL, from the
   examples and `examples/invalid/`.
2. **Finish the package.** Add the remaining limits (models, members per
   model, expanded layout size) and a step budget for row validation.
   `Bytes` for SQLite blobs if a real collection needs it.
3. **One schema interface.** Give `collection-schema`'s codec
   (`decodeProtocolCollectionFile`, `encodeProtocolCollectionFile`,
   `collectionChildSetHash`) a schema interface with `columns`, `primaryKey`,
   `childName`, `revision` and `validate`, implemented by USL's compiled
   schema. A collection folder's `schema.usl` declares one data model (fixed
   models aside); a database container's declares one per table.
4. **Protocol descriptor.** `childrenSource.schemaSource` may be
   `schema.usl` (TypeScript `protocol/src/model/node-model.ts`, Swift
   `ProtocolObjects.swift`). The model hash formula is unchanged; only the
   fingerprinted bytes differ.
5. **Discovery and providers.** Story Sync's discovery accepts `schema.usl`
   beside any store; the file provider validates and names rows through it;
   generated types come from `typeDeclarations`.
6. **SQLite and Postgres.** `apps-runtime`'s `introspectStoreSchema` checks
   the database with the USL SQLite backend instead of comparing against
   `schema.sql`, and derives its relationship declarations (direct, through,
   and the profile relation) from connections. Creating a new database
   container runs `usl sql`. Postgres introspection (Postgres 001) checks
   against the same layout.
7. **overstoryd.** Acceptance compiles `schema.usl` through the same cache,
   keyed by fingerprint.
8. **Convert.** The books fixture, the inline schemas in tests, and
   `examples/supplies/data` move to `schema.usl`. Supplies' tables and columns
   are renamed to the generated layout, or kept with a name mapping (open
   question 1).
9. **Existing trees.** A `story` command converts a tree's `schema.cddl`
   files to `schema.usl` as one authored change (open question 2). Run on
   Joe's trees only with his go-ahead.
10. **Remove CDDL.** Delete the CDDL parser, `schema.sql` and
    `relationships.json` handling, and `schemaSource: "schema.cddl"`.

## Invariants

- A schema's fingerprint is the SHA-256 of its exact bytes, and any change to
  it is a descriptor change, which merges as today (a schema conflict when
  both sides change it).
- Database bytes are never hashed or merged; a database is checked against
  its schema, never against a copy of DDL.
- Setup SQL is idempotent and never alters or drops anything; migrations are
  separate work.
- Row merge stays keyed by primary key until field-level merge lands.

## Verification

- `bun test tests/unit/usl.test.ts tests/unit/usl-stores.test.ts`, with
  `USL_TEST_POSTGRES` set for the Postgres cases.
- The conformance vectors pass in TypeScript, and Swift decodes descriptors
  with either `schemaSource`.
- `usl verify examples/supplies/schema.usl examples/supplies/data/_store.sqlite3`
  reports nothing, and the Supplies integration tests pass unchanged.
- A converted tree syncs between two placements with its rows intact.

## Open questions

1. **Names in existing databases.** The layout names tables after models
   (`List`, `Practice_authors`) and columns after fields. Supplies uses
   `lists`, `list_id` and so on. Rename the data, or add Prisma's `@@map` and
   `@map` so a schema can describe a database it didn't create?
2. **Existing trees.** Convert every `schema.cddl` once, or keep reading CDDL
   indefinitely for trees nobody converts?
3. **Data files for n:m.** The file backend stores an n:m connection as its
   own file (`Game_authors.json`), like the SQL join table. The workspace
   README says files keep it as an array on the first end. Pick one.
