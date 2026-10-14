# usl

A parser and checker for Ultimate Schema Language (`.usl`), the
Prisma-shaped schema language being designed in
[`plans/schema-language`](../../plans/schema-language/README.md). Draft: no
other package uses it yet.

- `parseUsl(source)`: the syntax tree, or one `syntax` diagnostic.
- `checkUsl(file)`: diagnostics for every broken invariant, plus each model's
  resolved fields (declared, gained from connections, or keys) and where each
  connection is stored.
- `compileUsl(source)`: both.

```
bun packages/usl/src/cli.ts check file.usl...   # diagnostics, exit 1 if any
bun packages/usl/src/cli.ts show file.usl       # resolved models and storage
```

Tests: `tests/unit/usl.test.ts` runs every example in
`plans/schema-language/examples` (expecting none) and every file in
`examples/invalid` (expecting exactly its `// expect:` codes).
