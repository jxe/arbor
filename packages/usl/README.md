# usl

Ultimate Schema Language (`.usl`), Overstory's schema language
([spec](../../docs/overstory-spec/11-schema-language.md)). A collection's or
database's `schema.usl` is compiled here: `collection-schema` builds row
validation from its data-file layout, and `apps-runtime` checks SQLite
databases and derives query relationships from its database layout.

- `compileUsl(source)`: parse (`parseUsl`) and check (`checkUsl`). Returns
  diagnostics for every broken invariant, each model's resolved fields, and
  where each connection is stored.
- `layoutOf(result)`: the relational layout (tables, columns, keys, foreign
  keys, seed rows) shared by everything below. Its rules are at the top of
  `src/layout.ts`.
- `setupSql(tables, "sqlite" | "postgres")`: idempotent setup SQL. It creates
  only what is missing and inserts `@@seed` rows only when their id is
  missing; it never alters or drops.
- `relationshipsOf(result, tables)`: a named relationship per connection end
  (direct columns or a join table), with people as the `Person` relation.
- `validateRow(table, row)`, `typeDeclarations(tables)`.

The main entry imports nothing from Node or Bun, so it runs in a browser;
`@ovst/usl/verify` and the CLI need Bun.
- `layoutOf(result, { store: "files" })` folds `@fold` connections into arrays, as data files store them.
- `@ovst/usl/verify`: `verifyStore(schema, location)` checks that a store
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
