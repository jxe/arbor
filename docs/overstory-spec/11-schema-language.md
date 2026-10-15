# Schema language

Ultimate Schema Language (USL) declares the models of a collection or database,
how they connect, and how Story presents them by default. A collection's
`schema.usl` ([child backings §2.4](06-child-backings.md#24-collection-schemas))
is the only schema file Overstory reads. Interpreting a schema never executes
code: a conforming implementation parses and checks it under the limits of
[§8](#8-limits) and derives everything else from the checked result.

```
model Game {
  name        Text
  status      Status
  description Markdown?
  tags        Text[]
  authors     Person[]

  @@views([
    { label: "By game",   line: [status @bullet, name, authors] },
    { label: "By author", group: authors },
  ])
  @@editableBy(authors)
}

model List {
  name  Text
  games Game[]
}

Game.authors[] @fold <-> Person.games[]
List.games[] @ordered @fold <-> Game.lists[]
Game.status <-> Status.games[]

model Status {
  @@fixed {
    Draft       @color("#9aa0aa")
    Playtested  @color("#bd861a")
  }
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

A schema's identity is the SHA-256 of its exact bytes, so comments and
formatting are part of it ([child backings §2.1](06-child-backings.md#21-accepted-overstory-representation)).

## 2. Models and fields

A schema is a sequence of models and connections. `model Name { ... }` declares
a model; its name is unique, and `Person` and the value type names are
reserved.

A field is `name Type`, optionally followed by `?` (at most one value) or `[]`
(any number), then field attributes. The value types are:

| Type | Values |
|---|---|
| `Text` | one line of text |
| `Markdown` | paragraphs of text; merges by lines |
| `Int` | an integer within ±(2^53 − 1) |
| `Number` | a finite number |
| `Bool` | `true` or `false` |
| `Date` | an ISO 8601 date or date-time string |

A value array (`tags Text[]`) is stored on the row. A field whose type is a
model is a cross-reference to a connection ([§3](#3-connections)); it must
agree with the connection in target and arity.

`Person` is a built-in model: Story accounts, referenced by profile id. It has
no rows in any store.

Every row has the implicit fields `id`, `created` and `modified`, which a
model can't declare.

## 3. Connections

Every connection is written as a connection, with both ends named, outside the
models it connects: `A.x <-> B.y`, or equivalently `{ A.x, B.y }`. An end
`Model.field` declares the field that model gains; `[]` makes it many and `?`
optional. Each `Model.field` is declared by at most one connection. The
connection's arity is that of its ends: many on both is n:m, on one is 1:n,
on neither is 1:1.

A named model whose body holds two or more ends (`model Item { List.items[]
Practice.items[] }`) is a connection model: it connects them and may carry
fields of its own. Each end gives it a field named after the end's model in
lower case, or `@as(name)` on the end. An unnamed connection holds exactly two
ends and nothing else.

## 4. Keys and rows

A model's rows are keyed by `id`, except:

- a connection model is keyed by its ends' fields, so it holds at most one row
  per combination;
- `@@id(field, ...)` keys rows by the named single-valued fields (`id`
  included), such as `@@id(list, id)` for an id unique within its list; a bare
  `@@id` gives a connection model its own `id`;
- a fixed model's rows are keyed by their names.

`@@fixed { A, B }` writes a model's rows in the schema. A reference to a fixed
model is the row's name, so a fixed model with no fields is an enumeration.
A fixed row may carry values for the model's fields
(`Draft { label: "First draft" }`) and a color (`@color("#rrggbb")`). A
connection model can't have fixed rows, and a fixed model has no table.

`@@seed { ... }` writes rows in the same form that are data: they are inserted
when their `id` (the row's name) is missing and never overwritten. A seeded
model needs a `name Text` field, and its colors are data in a `@color` field.

## 5. Attributes

| Attribute | On | Meaning |
|---|---|---|
| `@ordered` | a many-valued field or end | keeps its members in order; merges as a sequence |
| `@sort(field)` | a many-valued end without `@ordered` | lists its members by one of their fields (`name` for a person or a fixed row; `created` and `modified` newest first); otherwise they are listed in the order they were connected. Presentation only |
| `@unique` | a single value field | no two rows share its value |
| `@color` | one single-valued `Text` field of a model without fixed rows | holds each row's color |
| `@path` | one required `Text` field | its value is the row's name in the tree; otherwise the key names it |
| `@column("name")` | a value field, or the end that stores a connection | the stored column's name |
| `@as(name)` | an end in a connection model | the connection model's field for that end |
| `@fold` | one end of an n:m connection | in data files, an array on that end's rows instead of a table of its own |
| `@@table("name")` | a model with a table | the stored table's name |
| `@@fold(Model)` | a connection model | in data files, stored on the rows of one model it connects |
| `@@editableBy(field, ...)` | a model | people in those `Person` fields may change its rows |
| `@@index(field, ...)` | a model with a table, any number of times | databases index those single-valued fields (`id`, `created` and `modified` included) in that order |
| `@@views([...])` | a model | default arrangements ([§6](#6-views)) |

## 6. Views

`@@views` takes a list of objects, each a default arrangement in tab order: a
unique `label` string, a `line` (the fields shown for each row), a `group`
field, and a `sort` field (`created` and `modified` included). Items of a
line take presentation attributes: `@bullet` (at most one) draws a fixed
value as the row's colored bullet, `@summary` shows a many-valued field as a
count, and `@label("lead")` names one of the field's members. A line lists a connection's members, and a view grouped by a connection orders its groups, by the end's `@sort`. A view without a `line` uses the first view's. A model
without `@@views` has one plain view plus one grouped by each connection. A
page may override any of a schema's views; views never change data.

## 7. Layout

The checked schema determines the tables, columns and keys a store holds.

- A model with data rows is a table named after the model. `Person` and fixed
  models have none: a reference to a person is a profile id, and a reference to
  a fixed model is the row's name, restricted to the fixed names.
- A table's primary key is its model's key. A key field that refers to another
  model expands to that model's key columns: one column named after the field
  when the target's key has one column, otherwise `field_key` for each.
- A 1:1 or 1:n connection is a column (or columns) on its single side,
  nullable when that end is optional. An n:m connection is a join table named
  `Model_field` after its first end, keyed by both ends.
- A connection model is a table keyed by its ends, unless `@@fold`.
- `@ordered` on a many end adds a `field_position` number where the connection
  is stored.
- Database tables have `created` and `modified` timestamps. Data files leave
  them out; a tree's history records when a row changed.
- Database tables index each reference that doesn't lead the primary key,
  profile ids included, and each `@@index`. An index whose columns begin
  another index is left out. Indexes never change what a database holds, so
  implementing a schema doesn't depend on them.
- In data files, an n:m connection with a `@fold` end is an array, on that
  end's rows, of the other side's keys. Databases always use a join table.

Two fields stored under one column name are an error. Setting up a database
from a layout creates only what is missing and inserts seed rows only when
missing; it never alters or drops anything.

A database implements a schema when every table and column of its layout
exists with a compatible type and nullability, keys and foreign keys match,
and any extra column is nullable or has a default. Extra tables are allowed.

Each connection end is also a named relationship from its model's table:
`List.owner` reaches one `Person`, `List.items` the `Item` rows of a list, and
`Practice.authors` the people through the join table. Executable documents
query along these ([executable documents](07-executable-documents.md)).

## 8. Limits

| Limit | Value |
|---|---|
| Source bytes | 1,048,576 |
| Tokens | 65,536 |
| Nesting depth of values | 32 |

Exceeding a limit rejects the schema.

## 9. Diagnostics

A rejected schema reports diagnostics with a stable code and a 1-based line and
column. The [`collection-schemas.json`](conformance/collection-schemas.json)
vectors bind the codes they list; messages are not normative.
