# beetle

Beetle, the views-and-data language ([spec](../../docs/overstory-spec/1.5-beetle.md), grammar in
§7): a collection's tables in its `schema.beetle`, and views, rules, state tables and
mutations in `.beetle` files and in pages' fenced `view` blocks.

- `parseView(source)`: the syntax tree, with 1-based spans. A declaration starts in the
  first column, so a broken one is reported and the rest still parse. `model`, `r(a): …`
  rules and other older forms say what to write instead.
- `compileSchema(source)`: a `schema.beetle`'s tables, enums, connections and `re` blocks,
  checked by [`@ovst/usl`](../usl/README.md)'s checker, so its result (models,
  connections, plus `defaults`) feeds `modelLayer`, `layoutOf`, `setupSql` and the rest of
  USL unchanged. Supplies' `schema.beetle` gives the same fingerprint and layout as its
  old `schema.usl`. `uslFileOf(file)` is the translation alone. Overstory reads only
  `schema.beetle`; `tools/convert-usl-to-beetle.ts` converts a `schema.usl`.
- `formatView(source)`: the conventional form (`beetle fmt`): two-space indentation, field
  names and connections lined up, long facts wrapped under their first argument, an
  element's own attributes before `for`, `where`, `if`, `group`, `orderBy`, `limit`,
  `key` and `fallback`, and an opening tag written on one line kept on one when it fits.
  Every comment is kept, and a source with syntax errors is refused rather than changed.
  `formatPage` formats a page's view blocks and leaves its prose alone.
- `checkView(source, { path, read })`: binds the nearest `schema.beetle` (the file itself,
  for a schema), resolves `use` (all names, or a pick list with renames), every table,
  field, enum value and path, parameters, rules (alternatives, no recursion), state tables
  and local enums, elements (named views and their parameters; `where` only with `for`,
  `if` only without; any capitalized type is the UI language's unless `uiTypes` is given),
  actions, and mutation lines (facts and their keys, required fields and defaults, field
  lines, `let`, calls, `if`/`for` blocks, public errors only alone in an `if`, two values
  for one field). It returns diagnostics, and:
  - each view's **plan**, an `ElementPlan` per element that reads, nested as the elements
    are: `for`, `where`, `if`, `group`, `orderBy`, `limit`, `expandsBy` (the names it
    appears once per), `reads` (paths and aggregates), `draws` (a named view drawn there,
    with its arguments) and `fallback`. Rules are expanded in place. What reads `state`,
    `keep` or a state table is split into `clientWhere`, `clientIf`, `clientGroup` and
    `clientOrderBy`, and a `limit` beside it is an error.
  - each mutation's **writes** (`insert`, `upsert`, `update`, `delete` by table, called
    mutations included), its `let` names, its public errors and the tables it reads.
- **Data views** (`view Name(params) { … }`, §3.12) parse, format and check like UI
  views (keys, fields of the row a record is about, relationships followed with
  `field { … }`, and `key: { … }` records followed by `for`, `where`, `orderBy`, `limit`
  or `if` attributes as on an element), and their
  result carries a `DataPlan` in place of the element plan.
- `viewBlocks(markdown)`, `pageSource(markdown)`: a page's view blocks as one file.
  Unnamed views on a page are named `#1`, `#2`, ….

The main entry imports nothing from Node or Bun; the CLI needs Bun.

```
bun packages/beetle/src/cli.ts check [--root tree] file.beetle page.md...
bun packages/beetle/src/cli.ts fmt [--write] file.beetle page.md...
bun packages/beetle/src/cli.ts plan [--root tree] file.beetle...
```

Paths in `use` resolve within the tree at `--root` (default: the current directory).

**Running views and mutations** (spec §3–4), the same on a host and, ported, in Story:

- `compileProgram(source, { path, read })`: `checkView`'s result plus what the file binds
  (its views, rules, mutations and the schemas' checked tables), for the evaluator.
- `Store` / `StoreSchema`: one collection's rows in its database layout (`layoutOf(…, {
  store: "database" })`, the form the host materializes), read along USL's
  relationships. People are rows of `Person` keyed by profile id, their other fields
  (name, handle…) given by the caller; enum values are `EnumValue`s with their records.
  A to-many read is in position order for an `ordered` end, otherwise in key order.
- `new Evaluator(program, rows, { me, now, page, person })`: `view(name, input)` draws a
  view into plain `{type, props, children, key}` nodes: `for`, `where`, `if`, `orderBy`,
  `group` (`#group` nodes), `limit`, `fallback`, `key` and `slot`; one element per
  distinct combination of the names it uses (§3.5); named views drawn in place with
  their state at its initial values, each in its own file's names; rules (alternatives
  are *or*); built-ins; spec nulls. A `Rows` element is one node whose children are
  `#row` lines. Props carry a row as `{ row, key }`, an enum value with its fields, and an
  action as `{ action, from, args }` or `{ set, value }`. `data(name, input)` answers a
  data view's JSON, rows as their keys. Table-typed inputs resolve keys to rows, and a
  key with no row is `missing`; other inputs are checked against their types (`invalid`).
- `runMutation(evaluator, name, input, { mutationID })`: gathers the mutation's facts
  against the rows as they were, ends at the first public error (`BeetleError`, writing
  nothing), and applies the facts together: upserts by key, inserts with an id derived
  from the mutation identity, field lines, defaults, a new row on an `ordered` end placed
  last, to-many connections written as a whole (join rows, or a connection table's rows,
  in order), deletes cascading by the layout's foreign keys, and `conflict` for facts
  that can't both hold. It returns each changed collection's rows and the rows written
  (and deleted) by table; a host diffs them into row operations.

overstoryd runs these in process for the trees `OVERSTORYD_BEETLE` names
(`packages/overstoryd/src/beetle-host.ts`). Not yet: the `rows` answer form, Story's
Swift evaluator, and lowering plans to SQL.

Tests: `tests/unit/beetle-eval.test.ts` (Supplies' views and all 13 mutations over a
small set of rows), `tests/integration/beetle-host.test.ts` (on the host), and
`tests/unit/beetle.test.ts` ([examples](examples) check clean and are in the
conventional form; `examples/invalid` reports exactly its `// expect:` codes, each at or
after its comment; plans and writes of the Supplies files; the conformance vectors in
`docs/overstory-spec/conformance/beetle.json` are current. Regenerate them with
`bun tests/support/regenerate-beetle.ts`).
