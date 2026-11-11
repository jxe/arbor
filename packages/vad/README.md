# vad

VAD, the views-and-data language ([spec](../../docs/overstory-spec/1.5-vad.md), grammar in
§7): a collection's tables in its `schema.vad`, and views, rules, state tables and
mutations in `.vad` files and in pages' fenced `view` blocks.

- `parseView(source)`: the syntax tree, with 1-based spans. A declaration starts in the
  first column, so a broken one is reported and the rest still parse. `model`, `r(a): …`
  rules and other older forms say what to write instead.
- `compileSchema(source)`: a `schema.vad`'s tables, enums, connections and `re` blocks,
  checked by [`@ovst/usl`](../usl/README.md)'s checker, so its result (models,
  connections, plus `defaults`) feeds `modelLayer`, `layoutOf`, `setupSql` and the rest of
  USL unchanged. Supplies' `schema.vad` gives the same fingerprint and layout as its
  `schema.usl`. `uslFileOf(file)` is the translation alone.
- `formatView(source)`: the conventional form (`vad fmt`): two-space indentation, field
  names and connections lined up, long facts wrapped under their first argument, an
  element's own attributes before `for`, `where`, `if`, `group`, `orderBy`, `limit`,
  `key` and `fallback`, and an opening tag written on one line kept on one when it fits.
  Every comment is kept, and a source with syntax errors is refused rather than changed.
  `formatPage` formats a page's view blocks and leaves its prose alone.
- `checkView(source, { path, read })`: binds the nearest `schema.vad` (the file itself,
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
  `field { … }`, `for … where … orderBy … limit … { … }`, `if … { … }`), and their
  result carries a `DataPlan` in place of the element plan.
- `viewBlocks(markdown)`, `pageSource(markdown)`: a page's view blocks as one file.
  Unnamed views on a page are named `#1`, `#2`, ….

The main entry imports nothing from Node or Bun; the CLI needs Bun.

```
bun packages/vad/src/cli.ts check [--root tree] file.vad page.md...
bun packages/vad/src/cli.ts fmt [--write] file.vad page.md...
bun packages/vad/src/cli.ts plan [--root tree] file.vad...
```

Paths in `use` resolve within the tree at `--root` (default: the current directory).

Not yet: lowering plans to the SQLite engine's `QueryPlan`, and the evaluator (Apps 015
steps 1–3).

Tests: `tests/unit/vad.test.ts` ([examples](examples) check clean and are in the
conventional form; `examples/invalid` reports exactly its `// expect:` codes, each at or
after its comment; plans and writes of the Supplies files; the conformance vectors in
`docs/overstory-spec/conformance/vad.json` are current. Regenerate them with
`bun tests/support/regenerate-vad.ts`).
