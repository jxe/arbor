# Schema language 002: cranberries documents in Story

**Why and when:** Joe asked on 2026-10-13 whether cranberries could live in
Story, so that the MAI excellences document and supplies-remake run natively
in Story.app on the Overstory data model, whose collections are declared in
`schema.usl` ([schema language](../../docs/overstory-spec/11-schema-language.md)). The design history is in the project
thread "Cranberries in Story" and its sketch.

## Status

- **Effort:** XL, in milestones.
- **Risk:** HIGH. It needs field-level merge, which changes the merge
  protocol, and a new kind of editing surface in Story.
- **State:** PLANNED.
- **Depends on:** nothing.
- **Unblocks:** porting excellences and supplies-remake off Supabase.

## Joe's decisions

- An arrangement lives on a collection (its schema's `@@views`) and on pages
  that present collections kept elsewhere (`view "…" of path { … }`); a
  collection with neither gets a default arrangement. Views in a schema are
  defaults a page may override.
- People are Story accounts: the `Person` model, stored as profile ids.
- The editor is native (Swift and Quagmire), not cranberries' React in a web
  view.
- The merge tool and merge protocol are extended for field-level and
  database merges.
- SQLite will be the most common representation.
- Eventually a placed tree has a local copy of the data and a visitor uses the
  host, and it's hard to tell which. Not needed for this plan.

## Target result

A folder whose `schema.usl` has `@@views` opens in Story as an arrangement:
one line per row, grouped by each view's field, so a row appears under every
group it belongs to, with a colored bullet and chips for connections. Editing
a line changes the row; adding a line under a group connects the new row to
that group. Two people editing the same row at once merge field by field and
member by member. The excellences document and a supplies-remake game list
run this way, backed by files or SQLite, with the same content they have on
Supabase today.

## Milestones

1. **Presented views.** A format-agnostic `presentView(tables, rows, view)`
   per stack (TypeScript in `packages/protocol`, Swift in StoryKit), like
   `presentPage`: groups, lines and the cells of each line, plus the inverse
   that turns an edited line into row changes (set a field, connect,
   disconnect, reorder). Cranberries' `model.ts` (`groups`, `apply`,
   `validate`) ports nearly line for line. The default arrangement comes from
   the schema: a line of its fields in order, and one grouping per fixed
   model, connection or people field.
2. **The native editor.** Story draws a presented view as an outline in
   Quagmire: group headings, row lines, chips, a bullet colored from the
   fixed row or the `@color` field, tabs for views. Reordering in an
   `@ordered` group writes positions.
3. **Field-level merge.** The unit of change becomes a logical row change:
   set a field (with the value the editor saw), connect or disconnect a
   member, move within a sequence. Merge follows the schema: a single value
   conflicts only if both sides set it differently; sets merge per member;
   `@ordered` merges as a sequence; `Markdown` merges by lines. Collection
   files decode both sides to rows and merge the same way; tree-merge's
   `collection-file-rows-v1` becomes field-wise. Cranberries' `dv_changes`
   log is the prototype.
4. **SQLite placements that sync.** The same row changes, logged per
   placement and exchanged through the merge protocol, so a SQLite collection
   can be edited on two devices (spec 06 deferred item 5, Postgres 002).
5. **Access.** Who may edit a row (`@@editableBy`) checked by the host,
   together with tree-level access (open question 1).
6. **Pages that present other collections.** A page carrying
   `view "My games" of ../Games/Game { group: status }` shows that view, with
   edits going back to the source collection.
7. **Public pages.** overstoryd renders `presentView` output as HTML for
   public trees; editing on the web waits for story-web.
8. **Port the two sites.** Import excellences and a supplies-remake list from
   Supabase (cranberries' export) into trees using
   `plans/schema-language/examples/excellences.usl` and `games.usl`, and
   check them with `usl verify`.

## Invariants

- One record, many groups: grouping is never stored, and an edit made under
  any group changes the one row.
- Every edit is a row change that the schema can validate before it is
  published.
- Presentation never changes data: a view, a page's override or a default
  arrangement only chooses what is shown.

## Interaction with presence (Sharing 003)

Presence names a page by its logical path and a caret as a byte range in a
file object. A presented view's page is the collection folder (or the page
that presents it), so the roster works unchanged. A caret in a view is in one
field of one row, and a row in SQLite has no file object, so milestone 2
needs a second selection kind, such as `{ row: { table, key }, field, anchor,
head }`, with offsets into that field's text. That is easiest if Sharing 003's
phase 1 makes `PresenceSelection` extensible (a `kind`, or decoders that skip
an unknown selection) rather than fixing the byte-range shape.

## Open questions

1. **Access.** Access will mostly be per tree in Overstory. How do
   `@@editableBy` and fields that change who may edit (Supplies'
   `openToEdits`) fit with that?
2. **Where an arrangement's state lives.** The selected tab, collapsed
   groups and filters: per device, per person, or in the page?
3. **Markdown rows.** A row as one Markdown file (its `Markdown` field as the
   body) or always a row in a table file or database?
