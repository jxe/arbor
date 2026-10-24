# Schema language 006: read-only collection views on the Mac

**Why and when:** Joe, 2026-10-24: the People directory will be shown with
[Schema language 002](../later/schema-language-002-cranberries-in-story.md)'s
database views, and he wanted a small slice of that to do first. He picked this
one: a collection folder in Story on the Mac shows its rows arranged by its
schema's views, read-only. It is the first part of 002's milestone 3, carved out;
editing (002 milestones 3a and 4) comes after.

> **Executor instructions**: Do the steps in order. Swift is written in the cloud
> and built and tested on Joe's Mac (Remote Control); stop after step 4 for Joe's
> hands-on look. Don't change the TS presentation or its vectors except to fix a
> disagreement both stacks must share.

## Status

- **Effort:** M.
- **Risk:** LOW. Read-only: nothing here writes rows or changes the wire.
- **State:** TODO.

## What exists

- **TS:** `presentView(schema, rows, options)` in `packages/usl/src/present.ts`
  arranges data-file layout rows (`RowsByTable`, as `layoutOf(…, { store: "files" })`
  lays them out) by a model's `~views` or a default arrangement: tabs, groups
  (connection, choice, unassigned, flat), lines with text, Markdown (first
  paragraph), chips and choice cells. `rowsFromLogical` (`packages/usl/src/logical.ts`)
  turns a collection's logical tables into those rows.
  `docs/overstory-spec/conformance/presented-views.json` binds the output.
- **Swift:** StoryKit has the USL parser and checker (`StoryKit/USL/`) and a port of
  `presentView` (`PresentedView.swift`, tested by `PresentedViewTests.swift` against the
  vectors). There is no `rowsFromLogical`: Swift decodes a `ProtocolRows` object only as
  opaque `Data` (`ProtocolObjects.swift`, `case rows(Data)`).
- **Story:** a collection folder is `WorkspaceSurface.collection(kind:rowCount:)`
  (`WorkspaceModels.swift`), drawn by `WorkspaceSurfaceView` in `StoryRootView.swift` as a
  kind and a row count. `WorkingTree.collection(for:)` reads the count from the
  collection reference's one table. A logical collection's table and rows objects are
  kept in the native working tree's overlay (005 milestone 3).

## Steps

1. **Decode rows in Swift.** `ProtocolRows` and `LogicalRow` (spec 01, "Collections")
   decoded strictly with `CanonicalCBORCoding`, in place of `case rows(Data)`; the
   conformance vectors in `protocol-objects.json` that carry rows objects decode in
   both stacks.
2. **`rowsFromLogical` in StoryKit.** Port the logical-to-layout direction of
   `packages/usl/src/logical.ts` (not the reverse; that is 002 milestone 3a's). Add
   vectors (schema, logical tables → layout rows) generated from TS, beside
   `presented-views.json`, and check both stacks against them. Use `games.usl` and
   `excellences.usl` with their example data.
3. **A collection surface that carries its presentation.** `WorkingTree` reads the
   folder's `schema.usl`, checks it with StoryKit, loads each table's chunks and
   presents the main model's first view. `WorkspaceSurface.collection` gains the
   presentation (or a diagnostic when the schema doesn't check or a chunk is missing),
   keeping kind and row count for the fallback. Files-only collections from before
   005 (a `_store.*` with no collection reference) keep today's summary.
4. **Draw it read-only on the Mac.** Replace the two labels in `WorkspaceSurfaceView`
   with a SwiftUI list: view tabs when there are several; group headings that collapse
   (collapsed state is the client's own); one line per occurrence, keyed by its
   occurrence id; a choice with `bullet` as a colored dot that also tints the line;
   chips for connections and people (profile names from the directory Story already
   has); Markdown as its first paragraph. A search field filters lines. Nothing is
   editable; a line's context menu offers Copy Row Key.
5. **Close out.** `docs/implementing-editors/design.md` says what a collection folder
   shows. Record the evidence in `status.md`, fold what's left of 002 milestone 3 back
   into 002, and delete this plan.

**Verification:** `bun run test:affected` (vectors, if TS changes), the StoryKit and
Overstory Swift package tests and `swift/scripts/test-story-app.sh` on Joe's Mac. By
hand with Joe: a tree holding the games example as a logical collection opens in Story
on the Mac grouped by status, with bullets, chips and tabs; an edit made through Story
Sync on another device shows up after sync.

## Not in this plan

- Editing of any kind, row operations from Story, and offline rows on the iPhone
  (002 milestones 3a and 4).
- The iPhone (it follows with 3a, which gives it rows offline).
- Pages that present collections kept elsewhere, and groups that are other trees
  (002 milestone 7).
