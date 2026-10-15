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

Settled on 2026-10-15 (discussion notes in the project thread "Cranberries in
Story"):

- **Ownership** is access policy, not schema: it must also work on pages
  that aren't rows (front matter `authors`). `access.yaml` gains a property
  subject, `who: {property: authors}`, matching the profiles in that property
  of the node being changed, judged on its current accepted state. One
  predicate, `unless`/`when: {property: x}` (non-empty), covers "anyone may
  edit unowned rows" and Supplies' `openToEdits`; try it and revisit.
  `@@editableBy` leaves USL. No special rule for editing `schema.usl`.
- "Anyone signed in" is the host's community group; no new subject.
- **Identity and sign-in** (people without accounts, invites, passkeys) wait
  for Overstory's own identity work.
- **Row operations** (set with the value seen, connect, disconnect, create,
  delete, move) join the source operations of spec 10, so row edits ride the
  ordinary updates route. Merge is per field by the schema's arity rules; a
  field conflict keeps both values for someone to pick.
- **Databases in tree roots** get a logical hash computed from rows, the same
  for every representation. Start with a multiset hash (LtHash): O(1) per row
  change, no tree objects; replicas catch up from row operations. A prolly
  tree only if syncing large tables ever needs tree diffs.
- `created` and `modified` stay stored, in files too: stamped by the host at
  acceptance; `created` never changes and `modified` merges to the later
  value, so they never conflict.
- A schema with several data models stored as files uses one
  `<Table>.jsonl` per table.
- A row may be its own Markdown file: a field named `content` (`Markdown`) is
  the body, `title` is the page title, everything else is front matter.
- Order of an unordered connection's members is configurable in the schema
  or view, defaulting to creation order.
- **The editor** is a separate structured-data editor in the quagmire repo,
  not record blocks inside Quagmire's block model. A view is its own kind of
  page in Story first; embedding in a Quagmire page (one opaque block) comes
  later. Share text-cell code with Quagmire only once it's needed twice.
- In a view: dragging a row to another group changes its group; a
  connection group's heading edits that row's name (choice groups and
  "Unassigned" are read-only); Delete in a connection group disconnects, in a
  flat or choice-grouped view it deletes, and "Delete row" always deletes,
  naming the other groups; a `Markdown` field in a table row expands inline,
  and a row stored as a Markdown file opens as its page.
- View state (tab, collapsed groups) is the client's own.
- No web views yet.

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
   that turns an editor intent into row operations (set a field, connect,
   disconnect, create in a group, delete, move). Cranberries' `model.ts`
   (`groups`, `apply`, `validate`) ports nearly line for line. The default
   arrangement comes from the schema.
2. **The structured editor.** A new editor product in the quagmire repo: in,
   a presented view with per-row and per-cell capabilities and conflicts;
   out, intents. Cells are text, Markdown (collapsed, expands inline), chips
   (through the @-mention picker) and choices. Story shows it as its own
   kind of page.
3. **Row operations and field-level merge.** Spec 10 gains the row
   operations; tree-merge's `collection-file-rows-v1` becomes field-wise,
   with conflicts kept as alternatives the editor shows per cell. Spec 11
   and the data-file layout keep `created`/`modified`; files may hold
   several tables as `<Table>.jsonl`; a `content` field is a Markdown row's
   body.
4. **SQLite placements that sync.** The logical multiset hash in tree roots
   (spec 06 changes its "never hash all rows" line), maintained per
   transaction, with row operations as the change log (spec README deferred
   item 5).
5. **Ownership.** Property subjects and `unless`/`when` in spec 05, checked
   by the host on every accepted change; `@@editableBy` removed from USL,
   the examples and cranberries' config derivation.
6. **Pages that present other collections.** A page carrying
   `view "My games" of ../Games/Game { group: status }` shows that view, with
   edits going back to the source collection; embedding the editor in a
   Quagmire page as one block.
7. **Port the two sites.** Import excellences and a supplies-remake list from
   Supabase (cranberries' export) into trees, check them with `usl verify`.
   Identity for people without accounts waits for Overstory's identity work.

## Invariants

- One record, many groups: grouping is never stored, and an edit made under
  any group changes the one row.
- Every edit is a row operation that the schema can validate before it is
  published.
- Presentation never changes data: a view, a page's override or a default
  arrangement only chooses what is shown.
- Data never grants access by itself: a property subject only matters
  through a rule an administrator accepted.

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

1. Is "property non-empty" the right size for `unless`/`when`? Revisit after
   Supplies and excellences use it.
