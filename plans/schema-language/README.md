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
  (`person`, `game`). Any other model gets an `id`. Every row also has
  `created` and `modified`.
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

- **Presentation lives in the schema too.** One `@@views([...])` list per
  model gives its arrangements in tab order. Each view has a `label`, a
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

## Questions the examples raise

1. **Row names as ids.** A fixed row's name is its id; `"Current focus"`
   needs quotes. Fine, or should row names be identifiers with a separate
   label?
2. **Scoped identity.** Supplies' `list_tags` are keyed by (list, id): a tag
   id is unique only within its list. Here a Tag just gets a global `id`. Is
   that loss acceptable?
3. **Cross-connection constraints.** Supplies' `practice_tags` require the
   tag and the item to belong to the same list. The language can't say that.
4. **Keyed by ends, or not.** A model with two ends that should still allow
   duplicates (two ratings of one game by one person) needs an escape hatch;
   `@@id`?
5. **Access beyond `@@editableBy`.** Supplies' `allow_arbor_user_edits` is a
   field that changes who may edit. Does access belong in the schema at all?
6. **Which presentation belongs in the schema.** `@@views` is about one way
   of showing the data. Should the schema hold only defaults,
   with pages free to override everything?
7. **File name and place.** One schema per tree, or per collection folder?
   The extension is `.usl`.
8. **Attributes inside expressions.** `status @bullet` inside a `line` list
   is the second place attributes can appear, after fields. Is that one
   grammar rule or two?
9. **Naming a connection model's key fields.** The checker names them after
   their models (`Rating.person`, `Rating.game`), so two ends on the same
   model (`Friendship { Person.friends[], Person.friendOf[] }`) clash.
   Should an end be able to name its field on this side?
