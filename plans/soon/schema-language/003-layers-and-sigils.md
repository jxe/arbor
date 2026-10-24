# Schema language 003: model, storage and presentation layers

**Why and when:** In the project thread "Cranberries in Story" (2026-10-15 to
2026-10-18), and in "Splitting the database views plan" on 2026-10-24, Joe
decided that USL's annotations belong to three layers: the logical model every placement shares, storage that each placement may
choose, and presentation. Each layer should be visible on every line, and any
layer should be able to live in another file. That's needed for
[004](004-logical-collections.md)'s logical collections, whose storage is a
property of a placement, not of the schema. It is built as
[005](005-collections-that-sync.md)'s milestone 2. The examples rewritten in this
form are in [examples/layered](examples/layered).

## Status

- **Effort:** M.
- **Risk:** MEDIUM. It changes every `.usl` file and both parsers (TS
  `packages/usl` and the StoryKit port), plus the editor grammars.
- **State:** PLANNED, built as [005](005-collections-that-sync.md)'s
  milestone 2. Revised by Joe on 2026-10-24: the model layer uses keywords
  instead of a sigil, `@` now marks storage, keys go in the model's header,
  and fixed models are `enum`s.
- **Depends on:** nothing.
- **Unblocks:** placement-owned storage in 005; per-placement storage
  mappings.

## Joe's decisions

- **Three layers.** The model is plain declarations with keywords; storage
  and presentation each have a sigil:
  - the model has no sigil (2026-10-24; it was `@`);
  - `@` is storage (2026-10-24; it was `&`);
  - `~` is presentation.
- **Single sigils only.** There's no `@@` or `~~`. An attribute that
  starts an item belongs to the model; one after a field belongs to that
  field. Each attribute name belongs to one level, so a misplaced one is a
  diagnostic ("`@fold` applies to a connection end; put it after the end").
- **Model modifiers go before the type** (2026-10-24): `name unique Text`,
  `scores ordered Number[]`. On a connection end they go before the end:
  `ordered List.games[] <-> Game.lists[]`. `?` and `[]` stay on the type.
- **Keys go in the header** (2026-10-24): `model Tag (list, id) { … }`, where
  `id` is the row's own id, so `(id)` alone gives every row its own id. A
  model without a header key is keyed as before: a connection model by its
  ends, any other model by its own id.
- **`enum` is a top-level keyword** (2026-10-24) for a fixed model:
  `enum Status { Draft, Playtested, Polished }`. Values that carry data
  declare the fields first, then the values. An enum that people need to add
  to becomes a `model` with a `seed { … }` block, keeping each value's name
  as its id.
- **A row's name is its logical identity** (004 fork 3), so `path` is a model
  modifier, not storage.
- **A row's body is storage** (004 fork 6): a Markdown-records projection
  writes the field named `content` as the body and `title` as the page title;
  `@body` and `@title` name other fields.
- **`re Game { … }`** adds to a model declared elsewhere, in the same file or
  another. It re-mentions existing fields by bare name (`status ~bullet`),
  and an enum's values by name (`Draft ~color("#9aa0aa")`). It never
  declares fields or types.
- **No enforced separation, only conventions.** Every sigil is legal in
  `model`, `enum` and `re` blocks. `usl fmt` applies the conventions:
  - a `model` block holds the logical model, plus `@` where a stored name
    differs from the default;
  - presentation goes in a `re` block, after the model or in its own file;
  - model-level items (`seed`, `@table`, `@index`) come at the end of a
    block, after a blank line.
- **Keywords are contextual.** Position decides what a word is: after a
  field's name and before its type it is a modifier, at the start of a line in
  a block it is a model item. A field may still be named `id`, `unique` or
  `seed`.
- **Storage belongs to a placement.**
  - A device's choice of format for a collection goes in its local
    `placements.yaml`, nested under the tree's entry by logical path. Story
    Sync records what it finds on disk the first time, so existing folders
    don't change.
  - A placement's own storage mapping is a `.usl` file of `re` blocks with
    `@`. It lives in a visible folder under `~/.story/`, found by
    convention. Story Sync writes it when it adopts an existing database.
  - `@` in the tree's shared `.usl` files are defaults. A placement's mapping
    overrides them, and both are needed only where names differ from those
    derived from the model.
- **Host retention** is a promise to every reader. It belongs to the host
  operator and the tree configuration.

## How the annotations sort

| Layer | Field level | Model level |
|---|---|---|
| model (keywords) | types, `[]`, `?`, `ordered`, `unique`, `path`, `as` | `model X (key)`, `enum`, `seed` |
| `@` storage | `@fold`, `@column`, `@body`, `@title`; `@stored` on an enum value | `@table`, `@index` |
| `~` presentation | `~color` (the field holding a row's color) | `~views` |

- Inside `~views`, line items take `~bullet`, `~summary`, `~label` and
  `~sort`.
- An enum value's color is `~color` on that value, in a `re` block.
- `@@editableBy` is gone: ownership is access policy
  ([002](../../later/schema-language-002-cranberries-in-story.md) milestone 5).
  It leaves USL with this change; cranberries keeps it on `@ovst/usl` 0.2
  until 002's ownership replaces it.
- `as` names the field a connection end gives a connection model, when two
  ends would get the same name: `Person.friends[] as from`.

## Rules

- **Fields and types** are declared only in `model` and `enum` blocks.
- **The model has one definition.** Two `model` or `enum` blocks for one name
  is an error; that's what `re` is for.
- **Duplicates:** the same annotation set twice in one layer is an error.
  Storage precedence runs from defaults derived from the model, to `@` in the
  tree's shared files, to the placement's own mapping. Presentation runs from
  `~` in shared files to a page's `view "…" of …` override.
- **Fingerprints:**
  - the logical collection binds to a model fingerprint of the model layer
    only;
  - each placement has a storage fingerprint, which decides when it rebuilds
    its projection;
  - presentation has no fingerprint.
- **No old spellings** (Joe, 2026-10-24: no collections are live). The
  parser accepts only the new syntax, and every `.usl` in the repo is
  rewritten by hand. `@ovst/usl` ships it as 0.3.0; cranberries pins
  `^0.2.0`, so excellences and supplies-remake keep the old syntax until
  they move.

## Steps

1. **Spec 11:** the three layers, the sigils, position deciding level, `re`,
   precedence, fingerprints and conventions.
2. **TS `packages/usl`:**
   - parser and AST: keywords and header keys, `enum`, the sigils, `re`
     blocks, re-mentions;
   - checker: levels by name, re-mention resolution, duplicates;
   - layout reads `@`;
   - `presentView` reads `~`;
   - the model fingerprint.
3. **`usl fmt`:** applies the conventions.
4. **The StoryKit port and its shared vectors:** the same changes.
5. **Editors:** the tree-sitter grammar, the highlight queries (one color
   each for keywords, `@` and `~`) and the VS Code TextMate grammar in
   `packages/usl/editors`.
6. **Move the examples:** `examples/layered/*.usl` replace
   `examples/*.usl`, the invalid examples gain the new diagnostics, and
   `examples/supplies/data/schema.usl` is rewritten. supplies-remake and
   excellences follow when they move to `@ovst/usl` 0.3.
7. **Placement storage mappings** in Story Sync: per-collection formats in
   `placements.yaml`, mapping files under `~/.story/`, and writing a mapping
   when it adopts an existing database. This step belongs with
   005's milestone 3, logical collections.

## Settled questions

Joe, 2026-10-24:

1. A placement's storage mapping is one file per collection, named by tree
   and collection path: `~/.story/storage/<tree>/<collection path>.usl`, such
   as `~/.story/storage/tr_abc123/Games.usl`.
2. An enum value may have a stored name, for databases that spell it
   differently: `re Status { Playtested @stored("pt") }`.
