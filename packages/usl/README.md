# usl

Ultimate Schema Language (`.usl`), Overstory's schema language
([spec](../../docs/overstory-spec/11-schema-language.md)). A collection's or
database's `schema.usl` is compiled here: `collection-schema` builds row
validation from its data-file layout, and `apps-runtime` checks SQLite
databases and derives query relationships from its database layout.

- `compileUsl(source)`: parse (`parseUsl`) and check (`checkUsl`). Returns
  diagnostics for every broken invariant, each model's resolved fields,
  views, `editableBy` fields and `indexes`, and where each connection is
  stored.
- `layoutOf(result)`: the relational layout (tables, columns, keys, foreign
  keys, indexes, seed rows) shared by everything below, with the columns that
  hold each field. Its rules are at the top of `src/layout.ts`.
- `rowsFromRecords(tables, records)` and `recordsFromRows(tables, rows)`
  convert between records (fields by name, references as keys, n:m
  connections as arrays) and the rows of those tables, for a store adaptor.
  `rowOf`, `recordOf` and `joinRowsOf` do one row at a time.
- `setupSql(tables, "sqlite" | "postgres")`: idempotent setup SQL. It creates
  only what is missing and inserts `@@seed` rows only when their id is
  missing; it never alters or drops.
- `relationshipsOf(result, tables)`: a named relationship per connection end
  (direct columns or a join table), with people as the `Person` relation.
- `validateRow(table, row)`, `typeDeclarations(tables)`.
- `layoutOf(result, { store: "files" })` folds `@fold` connections into arrays, as data files store them.
- `presentView(result, rows, options)` (`src/present.ts`): a collection's
  data-file rows as one of its views presents them (tabs, groups, lines,
  cells, per-row capabilities), with the default arrangement for a model
  without `@@views`. `viewEdits` turns what a person does to a view into row
  operations (spec 10 §4.1), `applyRowEdits` applies them, and `checkRows`
  validates rows and references. StoryKit's `PresentedView` is the Swift
  port; both run `docs/overstory-spec/conformance/presented-views.json`.
- `@ovst/usl/verify`: `verifyStore(schema, location)` checks that a store
  implements a schema. Each kind of store is a `StoreBackend`: `sqlite` (a
  `.sqlite3` file), `postgres` (a `postgres://` URL, `?schema=` for a
  namespace), and `files` (a folder with one `<Table>.csv`, `.jsonl` or
  `.json` per table, or `_store.*` for a single table). The database backends
  compare structure; the files backend reads every row. Add a backend to
  `STORE_BACKENDS` to support another store.

Editor support (Zed and VS Code highlighting) is in [`editors/`](editors/README.md).

The main entry imports nothing from Node or Bun, so it runs in a browser;
`@ovst/usl/verify` and the CLI need Bun. The package ships TypeScript with
`.ts` import paths: a typechecking consumer needs
`"allowImportingTsExtensions": true`, and Node needs a loader such as tsx.

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
