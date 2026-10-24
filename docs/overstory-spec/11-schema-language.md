# Schema language

Ultimate Schema Language (USL) declares the models of a collection or database,
how they connect, how a placement stores them, and how Story presents them by
default. A collection's `schema.usl`
([child backings §2](06-child-backings.md#2-logical-collections)) is the only
schema file Overstory reads. Interpreting a schema never executes code: a
conforming implementation parses and checks it under the limits of
[§11](#11-limits) and derives everything else from the checked result.

```
main model Game {
  name        Text
  status      Status
  description Markdown?
  tags        Text[]
  authors     Person[]
}

model List {
  name  Text
  games Game[]
}

Game.authors[] @fold <-> Person.games[]
ordered List.games[] @fold <-> Game.lists[]
Game.status <-> Status.games[]

enum Status { Draft, Playtested }

re Game {
  ~views([
    { label: "By game",   line: [status ~bullet, name, authors] },
    { label: "By author", group: authors },
  ])
}

re Status {
  Draft       ~color("#9aa0aa")
  Playtested  ~color("#bd861a")
}
```

## 1. Source

A schema is UTF-8 text without a byte-order mark. A comment runs from `//` to
the end of the line. Space, tab and carriage return separate tokens; a line
feed ends an item. Items in any block (`{ ... }`, `[ ... ]`, `( ... )`) are
separated by line feeds or commas; line feeds inside parentheses, lists and
object literals are ignored. An identifier is `[A-Za-z_][A-Za-z0-9_]*`. A
number is an optional `-`, decimal digits, and an optional fraction. A string
is double-quoted on one line, with `\"`, `\\`, `\n` and `\t` escapes.

The words `main`, `model`, `enum`, `re`, `seed`, `ordered`, `unique`, `path` and `as`
are keywords only where this chapter places them, so a field or model may
still be named `id`, `seed` or `path`.

A collection's schema is its one `schema.usl` file. The only other `.usl`
files are a placement's own storage mappings ([§7](#7-attributes)), which it
keeps outside the tree and reads after `schema.usl`.

## 2. Layers

A schema says three kinds of thing, and each has its own spelling:

| Layer | Spelling | Says | Shared by |
|---|---|---|---|
| model | plain declarations and keywords | models, fields, types, keys, connections, enum values | every placement; it is what the tree holds ([§9](#9-fingerprints)) |
| storage | attributes starting with `@` | how a placement stores the model: folding, table and column names, indexes, a row's body | defaults every placement starts from, which a placement's own mapping may override |
| presentation | attributes starting with `~` | default views and colors | Story, as defaults a page may override |

There is one sigil per layer and no doubled sigil. An attribute's position
decides what it applies to: one that starts an item in a block applies to the
model, enum or value the block is for; one after a field or connection end
applies to that field or end. Each attribute name belongs to one layer and one
level ([§7](#7-attributes)); an attribute in the wrong place is a diagnostic.

`model Name { ... }` and `enum Name { ... }` declare a model once. `re Name
{ ... }` adds attributes to a model or enum declared elsewhere in `schema.usl`,
or from a placement's storage mapping: it re-mentions fields by bare name (`status ~bullet`) and an
enum's values by name (`Draft ~color("#9aa0aa")`), and never declares fields,
types or values. Every attribute is legal in a `model`, `enum` or `re` block.
By convention, which `usl fmt` applies, a `model` block holds the model plus
`@` attributes where a stored name differs from the derived one, presentation
goes in a `re` block, and model-level items come last in a block, after a
blank line.

## 3. Models and fields

A schema is a sequence of models, enums, connections and `re` blocks. A model
or enum name is unique, and `Person` and the value type names are reserved.

`main model Practice { ... }` makes Practice the collection's main model: its
rows are the collection folder's own children (`/practices/walking`). Every
other model with data rows is a child of the folder named after the model,
holding that model's rows (`/practices/Tag/t1`), so adding a model never moves
the main model's rows. A schema has at most one `main` model, and an enum or
connection model can't be one. A main row whose name equals another model's
name is invalid.

A field is `name [modifiers] Type`. The type is a value type or a model name,
optionally followed by `?` (at most one value) or `[]` (any number). Modifiers
go between the name and the type:

| Modifier | On | Meaning |
|---|---|---|
| `ordered` | a many-valued field or connection end | its members are a sequence; merges as one |
| `unique` | a single value field | no two rows share its value |
| `path` | one required `Text` field | its value is the row's name in the tree; otherwise the key names it |

The value types are:

| Type | Values |
|---|---|
| `Text` | one line of text |
| `Markdown` | paragraphs of text; merges by lines |
| `Int` | an integer within ±(2^53 − 1) |
| `Number` | a finite number |
| `Bool` | `true` or `false` |
| `Date` | an ISO 8601 date or date-time |

A value array (`tags Text[]`) is held on the row. A field whose type is a
model is a cross-reference to a connection ([§5](#5-connections)); it must
agree with the connection in target and arity.

`Person` is a built-in model: Story accounts, referenced by profile id. It has
no rows in any collection. A `Person` value is a profile id, or a
*placeholder* `contact:<key>` for someone with no profile yet, where `<key>`
(1 to 128 of `A`–`Z`, `a`–`z`, `0`–`9`, `_` and `-`) names a row of the
viewer's directory People collection. Any other text beginning `contact:` is
invalid. A reader shows a placeholder by the name its directory has for that
row, or by its key when it can't resolve it, and never drops it. When the
person gets a profile, their placeholders are rewritten to the profile id.

Every row has the implicit fields `id`, `created` and `modified`, which a
model can't declare. `created` and `modified` are date-times that only
accepted changes set ([child backings §2.2](06-child-backings.md#22-rows-and-values)).

## 4. Enums

`enum Status { Draft, Playtested }` declares a model whose rows are written in
the schema: its values. A reference to an enum is the value's name, and an
enum has no table. A value name that isn't an identifier is a string
(`"Current focus"`).

An enum whose values carry data declares its fields first, then its values
with their fields' values:

```
enum Genre {
  blurb Text

  Puzzle    { blurb: "Think it through" }
  Strategy  { blurb: "Plan ahead" }
}
```

An enum can't be a connection model, and its values can't be changed by
editing data. When people need to add values, the enum becomes a `model` with
a `seed { ... }` block, written in the same form: seed rows are data, inserted
when their `id` (the value's name) is missing and never overwritten, so stored
references stay valid. A seeded model needs a `name Text` field, and colors
become data in a field marked `~color`.

## 5. Connections

Every connection is written as a connection, with both ends named, outside the
models it connects: `A.x <-> B.y`, or equivalently `{ A.x, B.y }`. An end
`Model.field` declares the field that model gains; `[]` makes it many and `?`
optional, and `ordered` before the end makes its members a sequence
(`ordered List.games[] <-> Game.lists[]`). Each `Model.field` is declared by at
most one connection, and at most one end of a connection is `ordered`. The
connection's arity is that of its ends: many on both
is n:m, on one is 1:n, on neither is 1:1.

A named model whose body holds two or more ends (`model Item { List.items[]
Practice.items[] }`) is a connection model: it connects them and may carry
fields of its own. Each end gives it a field named after the end's model in
lower case, or the name after `as` (`Person.friends[] as from`). An unnamed
connection holds exactly two ends and nothing else.

## 6. Keys

A model's rows are keyed by `id`, except:

- a connection model is keyed by its ends' fields, so it holds at most one row
  per combination;
- a key in the model's header, `model Tag (list, id) { ... }`, keys rows by the
  named single-valued fields (`id` included), here an id unique within its
  list; `model Review (id) { ... }` gives a connection model its own `id`;
- an enum's rows are keyed by their names.

## 7. Attributes

| Attribute | Layer | On | Meaning |
|---|---|---|---|
| `@fold` | storage | one end of an n:m connection | in data files, an array on that end's rows instead of a table of its own |
| `@fold(Model)` | storage | a connection model | in data files, stored on the rows of one model it connects |
| `@column("name")` | storage | a value field, or the end that stores a connection | the stored column's name |
| `@table("name")` | storage | a model with a table | the stored table's name |
| `@index(field, ...)` | storage | a model with a table, any number of times | databases index those single-valued fields (`id`, `created` and `modified` included) in that order |
| `@body`, `@title` | storage | one `Markdown` field; one `Text` field | in Markdown row files, the field written as the body, and the one written as the page title |
| `@stored("text")` | storage | an enum value, in a `re` block | the text a store holds for that value |
| `~color` | presentation | one single-valued `Text` field of a model | holds each row's color |
| `~color("#rrggbb")` | presentation | an enum value | its color |
| `~views([...])` | presentation | a model | default arrangements ([§8](#8-views)) |

Without `@body` and `@title`, a Markdown row file's body is the `Markdown`
field named `content` and its title the `Text` field named `title`, when the
model has them.

**Precedence.** Storage is derived from the model, then from `@` attributes in
the tree's schema, then from the placement's own mapping: `re` blocks of `@`
attributes that the placement keeps outside the tree, where its
implementation chooses ([accounts §4](04-accounts-and-devices.md#4-local-placements)).
A mapping is needed only where a store's names differ, such as an existing
database the schema didn't create. Presentation is derived from the model,
then from `~` attributes, then from a page's override. Setting one attribute
twice at one level of precedence is an error.

## 8. Views

`~views` takes a list of objects, each a default arrangement in tab order: a
unique `label` string, a `line` (the fields shown for each row), a `group`
field, and a `sort` field (`created` and `modified` included). Items of a
line take presentation attributes: `~bullet` (at most one) draws an enum
value as the row's colored bullet, `~summary` shows a many-valued field as a
count, `~label("lead")` names one of the field's members, and `~sort(field)`
lists a connection's members by a field of theirs (`name` for a person or an
enum value; `created` and `modified` newest first) instead of in their stored
or connected order. `group: tags ~sort(name)` orders a grouped view's groups
the same way. A view without a `line` uses the first view's. A model without
`~views` has one plain view plus one grouped by each enum, connection or
`Person` field. A page may override any of a schema's views; views never
change data.

## 9. Fingerprints

A collection binds to its schema's **model fingerprint**: the canonical CBOR
hash ([tree operations §4.1](01-tree-operations.md#41-cbor-and-hashes)) of the
checked model layer, with models, enums, fields, values and connections in
UTF-8 order of name and comments, formatting and every `@`
and `~` attribute left out. Changing only storage or presentation therefore
leaves every collection's logical state and hash unchanged.

A placement's **storage fingerprint** covers the model and the storage it
resolved (§7), and decides when that placement rebuilds its projection.
Presentation has no fingerprint.

## 10. Layout

The checked schema and its storage determine the tables, columns and keys a
placement's store holds: its *layout*. A layout is a projection of the logical
form ([child backings §2.2](06-child-backings.md#22-rows-and-values)), so the
two layouts below hold the same rows and changing one never changes data.

- A model with data rows is a table named after the model, or `@table`.
  `Person` and enums have none: a reference to a person is a profile id (or a
  `contact:` placeholder), and a
  reference to an enum is the value's name (or its `@stored` text).
- A table's primary key is its model's key. A key field that refers to another
  model expands to that model's key columns: one column named after the field
  when the target's key has one column, otherwise `field_key` for each.
- A 1:1 or 1:n connection is a column (or columns) on its single side,
  nullable when that end is optional. An n:m connection is a join table named
  `Model_field` after its first end, keyed by both ends.
- A connection model is a table keyed by its ends, unless `@fold(Model)`.
- An `ordered` many end adds a `field_position` number where the connection is
  stored. Positions are the store's own: a placement writes and renumbers
  them freely, and only their order is data.
- Every table has `created` and `modified` columns.
- Database tables index each reference that doesn't lead the primary key,
  profile ids included, and each `@index`. An index whose columns begin
  another index is left out. Indexes never change what a database holds, so
  implementing a schema doesn't depend on them.
- **Data files** follow the same tables, except that an n:m connection with a
  `@fold` end is an array, on that end's rows, of the other side's keys, in
  order when the end is `ordered`. Databases always use a join table.

Two fields stored under one column name are an error. Setting up a database
from a layout creates only what is missing and inserts seed rows only when
missing; it never alters or drops anything.

A database implements a layout when every table and column exists with a
compatible type and nullability, keys and foreign keys match, and any extra
column is nullable or has a default. Extra tables are allowed.

Each connection end is also a named relationship from its model's table:
`List.owner` reaches one `Person`, `List.items` the `Item` rows of a list, and
`Practice.authors` the people through the join table. Executable documents
query along these ([executable documents](07-executable-documents.md)).

## 11. Limits

| Limit | Value |
|---|---|
| Source bytes | 1,048,576 |
| Tokens | 65,536 |
| Nesting depth of values | 32 |

Exceeding a limit rejects the schema.

## 12. Diagnostics

A rejected schema reports diagnostics with a stable code, a file and a 1-based
line and column. The [`collection-schemas.json`](conformance/collection-schemas.json)
vectors bind the codes they list; messages are not normative.
