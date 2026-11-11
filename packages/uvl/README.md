# uvl

UVL, the Ultimate View Language: views, rules and mutations in `.view` files and in
pages' fenced `view` blocks ([spec](../../docs/overstory-spec/4.1-apps-and-views.md),
grammar in §13). This package is UVL's counterpart of [`usl`](../usl/README.md). The
language's name appears only in the package name and docs; the API speaks of views.

- `parseView(source)`: the syntax tree, with 1-based spans. A declaration starts in the
  first column, so a broken one is reported and the rest still parse.
- `formatView(source)`: the conventional form (`uvl fmt`): two-space indentation, an
  element's own attributes before `for`, `where`, `orderBy`, `limit`, `key` and
  `fallback`, `else` aligned across guards, long records wrapped. Every comment is kept,
  and a source with syntax errors is refused rather than changed. `formatPage` formats a
  page's view blocks and leaves its prose alone.
- `checkView(source, { path, read })`: resolves `use` (all names, or a pick list with
  renames; `.usl` binds a schema; the nearest ancestor `schema.usl` is bound too), every
  model, field and path, parameters, rules (no recursion), elements (named views and their
  parameters; any capitalized type is the UI language's unless `uiTypes` is given),
  actions, and mutation statements (fields, keys, required fields, ordered relationships,
  conflicting writes). It returns diagnostics, and:
  - each view's **plan**, an `ElementPlan` per element that reads, nested as the elements
    are: `for`, `where`, `orderBy`, `limit`, `expandsBy` (the names it appears once per),
    `reads` (paths and aggregates), `draws` (a named view drawn there, with its
    arguments) and `fallback`. Rules are expanded in place. Conditions and orderings that
    read `state` or `keep` are split into `clientWhere` and `clientOrderBy`, and a `limit`
    beside them is an error.
  - each mutation's **writes** (`do` included) and the models it reads.
- `viewBlocks(markdown)`, `pageSource(markdown)`: a page's view blocks as one source.
  Unnamed views on a page are named `#1`, `#2`, ….

The main entry imports nothing from Node or Bun; the CLI needs Bun.

```
bun packages/uvl/src/cli.ts check [--root tree] file.view page.md...
bun packages/uvl/src/cli.ts fmt [--write] file.view page.md...
bun packages/uvl/src/cli.ts plan [--root tree] file.view...
```

Paths in `use` resolve within the tree at `--root` (default: the current directory).

Not yet: lowering plans to the SQLite engine's `QueryPlan`, the evaluator, and
`page`/`personal` state models (Apps 015 steps 1–3).

Tests: `tests/unit/uvl.test.ts` ([examples](examples) check clean and are in the
conventional form; `examples/invalid` reports exactly its `// expect:` codes, each at or
after its comment; plans and write sets of the Supplies sources; the conformance vectors
in `docs/overstory-spec/conformance/view-language.json` are current. Regenerate them
with `bun tests/support/regenerate-view-language.ts`).
