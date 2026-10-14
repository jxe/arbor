# Ultimate Schema Language

A workspace for iterating on Ultimate Schema Language (USL, `.usl` files),
Overstory's schema language: the declaration
that would replace `schema.cddl`, `schema.sql` and `relationships.json`, and
that Story uses to arrange collections. It is not specified yet; a parser
and checker live in `packages/usl` (`bun packages/usl/src/cli.ts check|show
file.usl`), and `examples/invalid/` holds one broken file per invariant. Background and the history of the design are in the project
thread "Cranberries in Story".

## The language so far

**Only models.** A `model` is a collection. A connection between models is
also a model: one whose rows are identified by what they connect. A model with
no name is written as a bare block.

```
model Game {
  name        Text
  status      Status
  description Markdown?
  tags        Text[]
  authors     Person[]
  lists       List[]

  @@views([
    { label: "By game",   line: [status @bullet, name, authors, description] },
    { label: "By author", group: authors },
    { label: "By list",   group: lists, sort: modified },
  ])
  @@editableBy(authors)
}

model List {
  name  Text
  games Game[]
}

Game.authors[] <-> Person.games[]
List.games[] @ordered <-> Game.lists[]
```

Items in any block are separated by newlines or commas. A connection with
two ends and no name or fields can be written either way:
`A <-> B` is the same as `{ A, B }`.

- **Two kinds of line.** A `name Type` line is a field of the model: `?` for
  optional, `[]` for many. A `Model.field` line is an end of a connection: it
  declares the field that model gains, with its arity (`Game.authors[]` is
  many, `Episode.series` is exactly one, `Team.lead?` at most one).
- **Every connection is written as a connection.** A field whose type is a
  model (`authors Person[]`, `status Status`) is only a cross-reference: an
  arrow or braces line must declare it with both sides named
  (`Game.status <-> Status.games[]`), and the two must agree. That keeps
  every connection findable in one form and reversible from either side.
- **Value types:** `Text` (one line), `Markdown` (paragraphs; merges by
  lines), `Number`, `Bool`, `Date`. `Person` is a built-in model: Story
  accounts.
- **Arity of a connection** is the arity of its ends: `[]` on both is n:m,
  on one is 1:n, on neither is 1:1. Attributes on an end describe the field
  it declares, such as `@ordered`.
- **Identity.** A model with two or more ends is keyed by them (one Rating
  per person and game), through a field per end named after its model
  (`person`, `game`). `@as(from)` on an end names that field instead, which
  two ends on the same model need. Any other model gets an `id`. Every row
  also has `created` and `modified`. `@@id(...)` overrides the key:
  `@@id(list, id)` makes an id unique only within its list, and a bare
  `@@id` gives a connection model its own id so it can repeat (two reviews
  of one game by one person). A fixed row's name is its id.
- **`@within(field)`** on an end says both sides share that field: an item's
  tags come from the item's own list. It is a constraint said by storage: a
  stored reference keeps only the rest of the target's key.
- **Connections with two named sides are declared outside the models they
  connect,** because they belong to neither. Storage is inferred: a 1:n becomes a column on the
  single side; an n:m becomes an array on the first end (in files) or a join
  table (SQLite). `@@fold(Model)` or `@@table` overrides. Value arrays
  (`Text[]`) always stay on the row. Storage column names come from the field
  names, so self-relations (`Page.parent?`, `Page.children[]`) need nothing
  extra.
- **`@ordered`** keeps a many-valued field in order; merge treats it as a
  sequence.
- **`@@editableBy(field, ...)`** on a model: the people in those fields (and
  admins) may change its rows. Access is a property of the model, not of a
  connection.
- **Fixed rows replace enums.** A model whose rows are written in the schema
  in a `@@fixed` block, and identified by their names, is a string with fixed
  values: a reference to it is stored as the name itself (`"Draft"`). Colors
  are presentation on the rows, so every field of that type shares them:

  ```
  model Status {
    @@fixed {
      Draft       @color("#9aa0aa")
      Playtested  @color("#bd861a")
    }
  }
  ```

  There is no `enum` keyword. The same declaration grows in place, with the
  fields that use it unchanged ([stress](examples/stress.usl) shows all
  three stages):

  1. **Fixed values,** as above. No table.
  2. **Values that carry data:** add fields and give each row values,
     `Draft { label: "First draft" } @color("#9aa0aa")`. Still no table; the
     rows live in the schema.
  3. **An actual table:** change `@@fixed` to `@@seed`. People can now add
     and rename rows, so each row keeps its old name as its `id` (stored
     references stay valid) and gains an editable `name` field. A new row
     needs its own color, so colors become a data field marked `@color`.
     `@@seed` inserts rows whose id is missing and never overwrites edits.

- **Default presentation lives in the schema too.** One `@@views([...])`
  list per model gives its default arrangements in tab order; a page may
  override any of them. Each view has a `label`, a
  `line` (the fields shown for each row, with presentation attributes such as
  `status @bullet` on the items that need them), and optionally `group` and
  `sort`. A view without a `line` uses the first view's. A model with no
  `@@views` gets one plain view plus one grouped by each connection. `@color`
  on a field says it holds each row's color; on a fixed row it gives the color
  itself. A page that presents collections
  kept elsewhere uses the same vocabulary:

  ```
  view "My games" of ../Games/Game { group: status }
  ```

**Merge follows arity.** A row is a set of tuples. A single-valued field with
two different concurrent values is a conflict; many-valued fields merge
member by member; `@ordered` fields merge as sequences; `Markdown` merges by
lines.

**Migrations between relation formats** are small changes to the same
declaration: refold (`@@fold` ↔ `@@table`, lossless), widen or narrow arity
(`Episode.series` → `Episode.series[]`; narrowing checks the data), and
promote or demote a value (`tags Text[]` → a `Tag` model and a connection,
creating one Tag per distinct value), and grow a fixed model (`@@fixed` →
`@@seed`).

## Examples

| File | What it tests |
|---|---|
| [books](examples/books.usl) | the smallest case; today's CDDL fixture |
| [games](examples/games.usl) | supplies-remake: who may edit, ordered n:m, value arrays, views |
| [excellences](examples/excellences.usl) | the MAI document: two n:m connections, a colored fixed model |
| [supplies](examples/supplies.usl) | `examples/supplies/data/schema.sql` + `relationships.json` rewritten: connections with attributes, a connection on a connection |
| [stress](examples/stress.usl) | self-relations, 1:1, ordered children, keyed ratings, number arrays, a reified fixed model |

## Where a schema lives

A `.usl` file sits beside the data it describes: the `.sqlite3`, `.csv` or
`.jsonl` file. A folder may hold several CSV or JSONL files, one per table.

## Settled by Joe (2026-10-14)

- Row names as ids, with quotes when needed, are fine.
- Scoped identity and the Supplies same-list constraint are expressed with
  `@@id(list, id)` and `@within(list)` (see [supplies](examples/supplies.usl)).
- `@@id` is the escape hatch from keying by ends; `@as` names an end's field.
- `@@views` in a schema are defaults; a page may override all of them.

## Open questions

1. **Access.** Access will mostly be at the tree level in Overstory. How do
   `@@editableBy` and fields that change who may edit (Supplies'
   `openToEdits`) work together with tree access?
2. **Several tables in one folder.** With one CSV or JSONL file per table,
   how are the files named and matched to models (`Game.csv` for `Game`)?
3. **Attributes inside expressions.** `status @bullet` inside a `line` list
   is the second place attributes appear, after fields. The parser treats
   them as one rule; is that the language we want?
