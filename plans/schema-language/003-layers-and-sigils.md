# Schema language 003: model, storage and presentation layers

**Why and when:** In the project thread "Cranberries in Story" (2026-10-15 to
2026-10-18), Joe decided that USL's annotations belong to three layers: the
logical model every placement shares, storage that each placement may
choose, and presentation. Each layer should be visible on every line, and any
layer should be able to live in another file. That's needed for
[002](002-cranberries-in-story.md)'s logical collections, whose storage is a
property of a placement, not of the schema. The examples rewritten in this
form are in [examples/layered](examples/layered).

## Status

- **Effort:** M.
- **Risk:** MEDIUM. It changes every `.usl` file and both parsers (TS
  `packages/usl` and the StoryKit port), plus the editor grammars.
- **State:** PLANNED.
- **Depends on:** nothing.
- **Unblocks:** placement-owned storage in 002; per-placement storage
  mappings.

## Joe's decisions

- **Three sigils, one per layer:**
  - `@` is the model;
  - `&` is storage;
  - `~` is presentation.
- **Single sigils only.** There's no `@@`, `&&` or `~~`. An attribute that
  starts an item belongs to the model; one after a field belongs to that
  field. Each attribute name belongs to one level, so a misplaced one is a
  diagnostic ("`@ordered` applies to a field; put it after the field").
- **`re Game { … }`** adds to a model declared elsewhere, in the same file or
  another. It re-mentions existing fields by bare name (`status ~bullet`),
  and the rows of a fixed model by name (`Draft ~color("#9aa0aa")`). It never
  declares fields or types.
- **No enforced separation, only conventions.** Every sigil is legal in both
  `model` and `re` blocks. `usl fmt` applies the conventions:
  - a `model` block holds the logical model, plus `&` where a stored name
    differs from the default;
  - presentation goes in a `re` block, after the model or in its own file;
  - model-level items come at the end of a block, after a blank line.
- **Storage belongs to a placement.**
  - A device's choice of format for a collection goes in its local
    `placements.yaml`, nested under the tree's entry by logical path. Story
    Sync records what it finds on disk the first time, so existing folders
    don't change.
  - A placement's own storage mapping is a `.usl` file of `re` blocks with
    `&`. It lives in a visible folder under `~/.story/`, found by
    convention. Story Sync writes it when it adopts an existing database.
  - `&` in the tree's shared `.usl` files are defaults. A placement's mapping
    overrides them, and both are needed only where names differ from those
    derived from the model.
- **Host retention** is a promise to every reader. It belongs to the host
  operator and the tree configuration.

## How the annotations sort

| Layer | Field level | Model level |
|---|---|---|
| `@` model | types, `[]`, `?`, `@ordered`, `@unique`, `@as` | `@id`, `@fixed`, `@seed` |
| `&` storage | `&fold`, `&column`, `&path` | `&table`, `&index` |
| `~` presentation | `~color` (the field holding a row's color) | `~views` |

- Inside `~views`, line items take `~bullet`, `~summary`, `~label` and
  `~sort`.
- A fixed row's color is `~color` on that row, in a `re` block.
- `@@editableBy` is gone: ownership is access policy (002 milestone 5).

## Rules

- **Fields and types** are declared only in `model` blocks.
- **The model has one definition.** Two `model` blocks for one name is an
  error; that's what `re` is for.
- **Duplicates:** the same annotation set twice in one layer is an error.
  Storage precedence runs from defaults derived from the model, to `&` in the
  tree's shared files, to the placement's own mapping. Presentation runs from
  `~` in shared files to a page's `view "…" of …` override.
- **Fingerprints:**
  - the logical collection binds to a model fingerprint of `@` content only;
  - each placement has a storage fingerprint, which decides when it rebuilds
    its projection;
  - presentation has no fingerprint.
- **Old spellings:** `@@views`, `@@id`, `@@fixed`, `@@seed`, `@@table`,
  `@@index`, `@fold`, `@column`, `@path`, the line-item `@bullet`,
  `@summary`, `@label` and `@sort`, and `@color` parse as deprecated
  spellings for a while. `usl fmt` rewrites them.

## Steps

1. **Spec 11:** the three layers, the sigils, position deciding level, `re`,
   precedence, fingerprints and conventions.
2. **TS `packages/usl`:**
   - parser and AST: the sigils, `re` blocks, re-mentions;
   - checker: levels by name, re-mention resolution, duplicates, deprecated
     spellings;
   - layout reads `&`;
   - `presentView` reads `~`;
   - the model fingerprint.
3. **`usl fmt`:** applies the conventions and rewrites old spellings.
4. **The StoryKit port and its shared vectors:** the same changes.
5. **Editors:** the tree-sitter grammar, the highlight queries (one color
   each for `&` and `~`) and the VS Code TextMate grammar in
   `packages/usl/editors`.
6. **Move the examples:** `examples/layered/*.usl` replace
   `examples/*.usl`, the invalid examples gain the new diagnostics, and
   `games.usl` in supplies-remake follows.
7. **Placement storage mappings** in Story Sync: per-collection formats in
   `placements.yaml`, mapping files under `~/.story/`, and writing a mapping
   when it adopts an existing database. This step belongs with 002's
   logical collections.

## Open questions

1. Where exactly under `~/.story/` do mapping files live, and how are they
   named (tree and collection path)?
2. Do `re` blocks for fixed rows also allow `&` (a stored name for a row)?
