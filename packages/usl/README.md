# usl

Ultimate Schema Language (`.usl`), the Prisma-shaped schema language designed
in [`plans/schema-language`](../../plans/schema-language/README.md) to
replace `schema.cddl`, `schema.sql` and `relationships.json`
([Schema language 001](../../plans/schema-language/001-replace-cddl-with-usl.md)).
Draft: no other package uses it yet.

- `compileUsl(source)`: parse (`parseUsl`) and check (`checkUsl`). Returns
  diagnostics for every broken invariant, each model's resolved fields, and
  where each connection is stored.
- `layoutOf(result)`: the relational layout (tables, columns, keys, foreign
  keys, seed rows) shared by everything below. Its rules are at the top of
  `src/layout.ts`.
- `setupSql(tables, "sqlite" | "postgres")`: idempotent setup SQL. It creates
  only what is missing and inserts `@@seed` rows only when their id is
  missing; it never alters or drops.
- `validateRow(table, row)`, `typeDeclarations(tables)`, `uslFingerprint(source)`.
- `@ovst/usl/verify`: `verifyStore(tables, location)` checks that a store
  implements a schema. Each kind of store is a `StoreBackend`: `sqlite` (a
  `.sqlite3` file), `postgres` (a `postgres://` URL, `?schema=` for a
  namespace), and `files` (a folder with one `<Table>.csv`, `.jsonl` or
  `.json` per table, or `_store.*` for a single table). The database backends
  compare structure; the files backend reads every row. Add a backend to
  `STORE_BACKENDS` to support another store.

```
bun packages/usl/src/cli.ts check file.usl...
bun packages/usl/src/cli.ts show file.usl
bun packages/usl/src/cli.ts sql sqlite|postgres file.usl
bun packages/usl/src/cli.ts types file.usl
bun packages/usl/src/cli.ts verify file.usl <store> [--backend sqlite|postgres|files]
```

Tests: `tests/unit/usl.test.ts` (examples clean, `examples/invalid`
reporting exactly their `// expect:` codes) and `tests/unit/usl-stores.test.ts`
(setup SQL on SQLite, data files, rows, types, limits; Postgres too when
`USL_TEST_POSTGRES` names a server).
