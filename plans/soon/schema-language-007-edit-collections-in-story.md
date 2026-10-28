# Schema language 007: edit collections in Story, on the Mac and iPhone

**Why and when:** Joe wants collections edited natively in Story, on the Mac and iPhone: the
People directory first, then games, excellences and Supplies. Joe, 2026-10-24: once Schema
language 006 showed a collection read-only
([status](../../status.md#collections-in-story-on-the-mac--2026-10-25)), editing goes in soon.
This plan is the whole editing side: the write path (done but for loose ends), every view
intent as row operations, simple edits in 006's view, and then the structured editor.
Schema language 002, which presented collections the way People needs, closed on
2026-10-28; this plan took its former milestones 3a, the inverse of 3, and 4.

> **Executor instructions**: Do the steps in order. Swift is written in the cloud and built and
> tested on Joe's Mac (Remote Control). Bring any change the code needs back to the spec in the
> same commit.

## Status

- **Effort:** L: steps 5–7 are M; the structured editor (8) is most of it.
- **Risk:** MEDIUM, then HIGH for step 8, a new kind of editing surface in Story and Quagmire.
- **State:** IN PROGRESS. Part 1 (steps 0–4) is done and in daily use by the People directory,
  which writes all its rows through it
  ([status](../../status.md#people-directory-tree-picker-and-usl-summaries--2026-10-25)). Try
  edits on the games sandbox tree, which holds supplies-remake's live data.
- **Unblocks:** [People 001](../features/people-001-groups-sharing-and-go-to.md) phase 2;
  [Schema language 008](../later/schema-language-008-port-excellences-and-supplies.md).

## Joe's decisions (2026-10-25)

- **Story edits collections through the host, always.** On the iPhone, on unplaced trees and
  on placed trees on the Mac alike, Story sends row operations to overstoryd; Story Sync then
  writes the accepted rows into a placed folder's projection. Story never writes a projection,
  and only Story Sync (TS) reads and writes SQLite and files. Edits made in a projection by other
  programs still go folder → Story Sync → host.
- **The host derives the result.** Every frame root is optional and independent: a stated
  root is checked, an omitted one derived (spec 10 §2). A *derived candidate* (§2.2) omits
  its last `after` and has `candidate: null`; the host executes the trace on the element's
  basis. Any operation trace may be derived (for parsimony); Story leaves the roots after row
  operations out; Story Sync, which encodes tables, keeps stating them (Joe); Story keeps stating roots for text and structure.
- **Offline is a queue, not a replica.** Pending row operations show at once, applied over the
  rows last received, and are sent when online. That is enough on the iPhone.
- So there is no Swift port of the replay or of the table encoding (dropped from this plan).

Settled with Joe on 2026-10-15 (the editor):

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

## What exists

- **Wire:** row operations are authored operations (`rowCreate`, `rowDelete`, `rowSet`,
  `rowConnect`, `rowDisconnect`, `rowMove`; `packages/protocol/src/updates/authored-contract.ts`),
  with vectors in `protocol-authored-updates.json`. Today they travel in stated frames whose
  `after` the host checks by replay (`packages/collection-schema/src/row-replay.ts`,
  `executeRowOperations` in `packages/protocol/src/updates/source-trace.ts`), and it merges by
  field, and derives a candidate whose roots are left out. Story Sync derives row operations
  from projection edits and sends stated frames.
- **Swift:** Overstory has `RowOperation` and derived candidates; StoryKit has
  `uslRowsFromLogical`, `presentView`, `viewEdits` and `applyRowEdits`; Story draws the view
  read-only (`StoryCollectionView`, `StoryPresentedCollection`) from
  `WorkspaceProvider.collectionRows`.
- **Story:** row edits go through the row queue (`UpdateCoordinator+Rows.swift`,
  `WorkspaceProvider.appendRowEdits`); the People directory writes through it.

## Steps

### Part 1, the write path (done)

0. **Read on the iPhone.** 006's view on iOS, from the tree's own objects, offline; fix what
   looks wrong at phone width. **Done** (Joe, 2026-10-25).
1. **Derived candidates in TS and overstoryd.** The contract (`candidate: Hash | null`, each
   frame root optional and checked when stated),
   request identity (a derived candidate's `candidate` is null in the digest and in the next
   element's `base`), and the result's `candidate` and reconciliation from the preceding result's
   root (spec 01 §2.4). overstoryd executes a derived trace with the code that checks a stated
   one. Vectors in `protocol-authored-updates.json` and the request-identity cases: rows only,
   text derived, a string of derived elements, a derived frame stating `before` (checked), a
   stated root the execution doesn't match (refused), an operation that doesn't apply on its basis (refused), a retry deriving the same root.
2. ~~Story Sync sends derived row changes.~~ Dropped (Joe, 2026-10-25): Story Sync encodes tables
   in TS and keeps stating roots for row changes, so its queue is unchanged.
3. **Swift on the wire.** `RowOperation` and derived candidates in Overstory's authored
   contract and request digest, passing the shared vectors; the result's `candidate`.
4. **A row queue in `UpdateCoordinator`.** Built 2026-10-25 (`UpdateCoordinator+Rows.swift`,
   `WorkspaceProvider.appendRowEdits`). Edits (StoryKit `RowEdit`s) wait durably in
   `sync/row-changes.json`, independent of the change log's stated chain. One request at a
   time carries every pending batch as one derived element with one frame (a later frame or
   element couldn't name the collection object it builds on), based on the tree's accepted
   update; the host merges it like any concurrent change. Its body is fixed for exact retries.
   Batches stay shown (`applyRowEdits` over the rows, one edit at a time) until the tree
   installs the result, the reported head or anything later; edits made meanwhile go in the
   next request. A refusal drops the batch and keeps its reason (`refusedRowEdits`);
   `base-not-retained` rebuilds on the current base. An edit the current rows no longer allow
(another device made the same row meanwhile) is left out of the request, as the view leaves it
out, rather than have the host refuse the rest (`0e0d9d9`).

### Part 2, editing

5. **The row queue's loose ends.** Show a refused edit in the UI, and a field decision (the
   same field edited on two devices) at least read-only.
6. **Every view intent as row operations.** Map `viewEdits`' layout-row edits to logical row
   operations (a join-table row is a connect on its holder, a position is a move), and the
   rest of cranberries' `src/model.ts` intents: create in a group (preset the forward field, or
   connect the reverse owner), move within an `ordered` group, move to another group, and
   `checkValue`/`validate` before publishing. Vectors beside `presented-views.json`. Done when
   every intent over `games.usl` and `excellences.usl` round-trips to row operations that
   `usl verify` accepts, in both stacks.
7. **Simple edits in the collection view, Mac and iPhone.** A bullet choice's dot opens a menu
   of values; the line's first text field renames inline; chips add and remove through a
   menu (people from the directory Story has, keeping any `contact:` placeholders a row
   already holds; adding a new placeholder waits for People 001); a line's context menu
   deletes (or removes from the group); a group gets an "Add" line that creates a row there.
8. **The structured editor**, below.
9. **Close out.** Record the evidence in `status.md`, delete
   [Apps 010](../later/apps-010-native-offline-collection-file-projection.md) (this covers it),
   and delete this plan.

## The structured editor (step 8)

**Product.**
- A new library target and product in the quagmire repo (`QuagmireRecords`,
  say), added to `scripts/verify.sh` and to the public-API test targets.
- It's host-neutral by Quagmire's own rule: no USL, no storage, no paths.
- Input: a presented view (`presentView`'s shape, in the editor's own types),
  per-row and per-cell capabilities, and per-cell conflicts.
- Output: intents.
- Host seam: like `EditorHost` (`persistCommit` plus `flush`). The host
  applies intents as row operations and hands back the re-presented view.
- The editor reconciles the new presentation without losing the focused cell,
  selection, scroll or expanded groups.

**Behavior** (from cranberries' `src/react.tsx`, plus Joe's decisions):
- **Layout:**
  - view tabs;
  - group headings that collapse;
  - one line per occurrence, keyed by view, group and row, so the same row
    shows under several groups and edits go to the one row.
- **Adding:** a draft line under a group searches existing rows to connect,
  or creates one.
- **Cells:**
  - chips are added through a picker (cranberries' checkbox menu);
  - a `@bullet` choice is a colored dot with a menu, and also colors the line;
  - Markdown shows its first paragraph and expands inline.
- **Editing:**
  - a connection group's heading edits that row's name;
  - drag to another group changes the group;
  - drag inside an `@ordered` group writes positions;
  - Delete disconnects in a connection group and deletes elsewhere;
  - "Delete row" names the other groups first.
- **Read-only and conflicts:** read-only rows look locked; a cell with a
  field conflict shows both values to pick from.
- **Search:** a search box.
- **No longer needed:** cranberries' "Download my draft" banner, since
  conflicts are kept, not refused.

**What to share with Quagmire, when it's needed twice.** These separate
cleanly into a shared internal target:
- `EditorTheme`;
- the inline marks (`InlineMarksBridge`, `InlineAttributes`);
- `Feedback` (haptics, sounds, and its resource bundle);
- the mention trigger, search and row;
- `RowSurface` with `ReorderDropResolver`, which is deliberately
  content-agnostic.

`BlockTextEditor` (1,900 lines) and the mention orchestration are bound to
`BlockID`, `Document` and `EditorView`. They need a generic focus ID and
callbacks before a cell can reuse them, so a first version may use a plain
text field.

**Hard parts, from Quagmire's text editing.**
- **Focus across cells.** Quagmire mounts one live text view per page; every
  other row is `Text` (`EditorView.swift:813`). Tab from cell to cell needs
  its keep-the-keyboard-up handoff (`iosTransitioningEditorID`), keyed by
  occurrence and cell, and macOS Tab arrives as keyCode 48 while iOS uses key
  commands and the accessory bar.
- **Host updates while typing.** On an external change `BlockTextEditor`
  reloads the text storage wholesale and drops the caret; only undo maps the
  caret (`caretRangeAfterTextReplacement`). The cell editor must map the caret
  for every host update, and the focused cell's live text wins until its
  checkpoint commit (about 750 ms, or blur). Keep Quagmire's
  `lastKnownBindingPlain` and `textStorageDirty` guards, which exist for
  exactly this echo. `sort: modified` mustn't move the row being edited until
  you leave it.
- **Stable ids.** `RowSurface` caches heights by id, so occurrence ids must
  be stable across re-presentations or the scroll position jumps.
- **Undo** is the inverse intent from the `before` values the host already
  has, not Quagmire's snapshot undo.
- **Per-row locks** are new: Quagmire's read-only is one page-level boolean,
  so tap, focus, Tab-skip and drag all need gating.

**Story.** (Written before 006 drew collections; refresh against `StoryCollectionView.swift`.)
- `WorkspaceSurface.collection(kind:rowCount:)` (StoryKit
  `WorkspaceModels.swift`) gains the resolved schema and views.
- `WorkspaceSurfaceView` in `StoryRootView.swift` renders it with the new
  editor instead of two labels.
- Routing: `StoryAppModel.load` (around `StoryAppModel.swift:2460`) treats a
  collection as a sidebar base and leases an editor only for document
  surfaces. It needs a collection branch that leases the view session, a
  field on its cached `PagePresentation`, and a branch in
  `StoryRootView.pageFrameContent` before the `WorkspaceSurfaceView`
  fallback. `WorkingTree.collection(for:)` and `WorkingTreeProvider` detect
  `schema.usl`. `InMemoryWorkspaceProvider` already fakes a collection for
  previews.
- View tabs and the search box sit in Story's chrome. The selected tab and
  collapsed groups are the client's own state.
- A collection session beside `WorkspaceDocumentSession` sends row
  operations through the row queue (`UpdateCoordinator+Rows.swift`).
- Release: a Quagmire minor version. Pins in `swift/project.yml` and
  `swift/Packages/StoryEditor/Package.swift`. Quagmire's `AGENTS.md` still
  names the old `native/` paths; fix it in passing.

**For the directory:** Option-drag (Mac) to add a row to another group while
keeping it in this one; locked headings for groups the viewer can't edit;
unsynced changes shown dimmed; a draft line under a group that can also add a
*new* person as a placeholder; and per-row actions the host supplies (Copy
invite link, Send invite…) with a status cell (not invited, invited, joined).

Done when Joe edits a games collection in Story on two devices, with
groups, chips, bullets, drag and inline Markdown, and the edits merge per
field; and forms a group by dragging three people in the directory on the
Mac and sees it on the iPhone.

## Verification

For every step: `bun run test:affected`, the StoryKit, Overstory and OverstoryWorkingTree
package tests and `swift/scripts/test-story-app.sh` on Joe's Mac. By hand with Joe: in the
games sandbox tree, change a game's status on the iPhone offline and rename it on the Mac;
both reconnect and both edits are there, and Story Sync's `Game.jsonl` shows them; an edit
made in `Game.jsonl` shows in Story. The same
field edited on both devices shows a decision.

## Interaction with presence (Live 001)

Presence names a page by its logical path and a caret as a byte range in a
file object. A presented view's page is the collection folder (or the page
that presents it), so the roster works unchanged. A caret in a view is in one
field of one row, and a row in SQLite has no file object, so the editor
needs a second selection kind, such as `{ row: { table, key }, field, anchor,
head }`, with offsets into that field's text. That is easiest if Live 001's
phase 1 makes `PresenceSelection` extensible (a `kind`, or decoders that skip
an unknown selection) rather than fixing the byte-range shape.

## Not in this plan

- Pages that present collections kept elsewhere, and groups that are other trees: both are
  [spec extensions](../spec-extensions/README.md).
- Row ownership is [Schema language 010](../later/schema-language-010-row-ownership.md).
- A replica on the device that encodes tables, and any SQLite there (Joe, 2026-10-25). Large
  collections are [Performance 004](../later/performance-004-provenance-index.md)'s concern.
- Derived candidates for Story's text edits: allowed by the spec, not used.
