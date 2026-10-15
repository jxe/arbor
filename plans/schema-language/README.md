# Ultimate Schema Language

A workspace for the rest of Ultimate Schema Language (USL, `.usl` files),
Overstory's schema language. The language as implemented is specified in
[the schema language chapter](../../docs/overstory-spec/11-schema-language.md)
and implemented in `packages/usl` (`bun packages/usl/src/cli.ts check|show
file.usl`); every collection reads its `schema.usl` through it. What remains
is [002](002-cranberries-in-story.md): presenting and merging collections the
way cranberries does. [003](003-logical-collections.md) (proposed) makes a
collection's rows the tree's content and every file or database a
placement's projection of them. `examples/invalid/` holds one broken file per
invariant. Background and the history of the design are in the project thread
"Cranberries in Story".

**Merge follows arity** (002). A row is a set of tuples. A single-valued field
with two different concurrent values is a conflict; many-valued fields merge
member by member; `@ordered` fields merge as sequences; `Markdown` merges by
lines.

**Migrations between relation formats** are small changes to the same
declaration: refold (`@@fold` ↔ `@@table`, lossless), widen or narrow arity
(`Episode.series` → `Episode.series[]`; narrowing checks the data), promote or
demote a value (`tags Text[]` → a `Tag` model and a connection, creating one
Tag per distinct value), and grow a fixed model (`@@fixed` → `@@seed`). None
is built yet.

## Examples

| File | What it tests |
|---|---|
| [books](examples/books.usl) | the smallest case |
| [games](examples/games.usl) | supplies-remake: who may edit, ordered n:m, value arrays, views |
| [excellences](examples/excellences.usl) | the MAI document: two n:m connections, a colored fixed model |
| [supplies](examples/supplies.usl) | the Supplies example's schema (`examples/supplies/data/schema.usl`): connections with attributes, a connection on a connection |
| [stress](examples/stress.usl) | self-relations, 1:1, ordered children, keyed ratings, number arrays, a reified fixed model |

## Open questions

1. **Access.** Access will mostly be at the tree level in Overstory. How do
   `@@editableBy` and fields that change who may edit (Supplies'
   `openToEdits`) work together with tree access?
2. **Several tables in one folder.** `usl verify` reads `<Table>.csv`,
   `.jsonl` or `.json`, one per table (`_store.*` for a single table). Is
   that the naming Overstory should adopt?
3. **Attributes inside expressions.** `status @bullet` inside a `line` list
   is the second place attributes appear, after fields. The parser treats
   them as one rule; is that the language we want?
