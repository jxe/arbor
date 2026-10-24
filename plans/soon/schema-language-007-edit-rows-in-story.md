# Schema language 007: edit collection rows in Story, on the Mac and iPhone

**Why and when:** Joe, 2026-10-24: once [Schema language 006](schema-language-006-read-only-collection-views.md)
shows a collection read-only, the next step goes in soon. This is
[Schema language 002](../later/schema-language-002-cranberries-in-story.md)'s milestone 3a
(rows in Story on Mac and iPhone), carved out with a small proof: simple edits in 006's view.
The People directory needs both, and the iPhone has no Story Sync.

> **Executor instructions**: Do the steps in order. Swift is written in the cloud and built and
> tested on Joe's Mac (Remote Control). The wire format exists (spec 10 §4.1); don't change it
> except to fix a disagreement both stacks must share.

## Status

- **Effort:** M–L.
- **Risk:** MEDIUM. Story starts sending row operations; a wrong replay is refused by the
  host (it replays every frame), so the risk is refused updates, not bad data.
- **State:** TODO. 006 is on main (9b4fb9b); its close-out waits on Joe's hands-on look.

## What exists

- **Wire:** row operations are authored operations (`rowCreate`, `rowDelete`, `rowSet`,
  `rowConnect`, `rowDisconnect`, `rowMove`; `packages/protocol/src/updates/authored-contract.ts`),
  with vectors in `protocol-authored-updates.json`. The host replays them
  (`packages/collection-schema/src/row-replay.ts`) and merges by field.
- **Swift:** after 006, Overstory decodes rows chunks, StoryKit has `uslRowsFromLogical`,
  `presentView` and `viewEdits` (intents to layout-row edits), and Story draws the view. Swift
  has no `RowOperation`, no replay and no logical-from-rows direction. Native working trees
  keep a collection's table and rows objects in the overlay (005 milestone 3).
- **Story:** local changes go through `UpdateCoordinator` (`appendStructure` in
  `UpdateCoordinator+LocalChanges.swift`); there is no row-change kind.

## Steps

0. **Read on the iPhone first.** 006's view on iOS, from the tree's own objects, offline. This
   half is all People 001 and 002 milestone 4 need to start.
1. **Row operations on the Swift wire.** `RowOperation` in Overstory's authored contract,
   encoded and validated as TS does; Swift passes the row-operation cases in
   `protocol-authored-updates.json`.
2. **Replay in Swift.** Port `row-replay.ts`: apply row operations to a collection's logical
   tables, re-chunk them by the fixed chunk rule, and write new table, rows and directory
   objects. Add shared vectors (schema, tables, operations → tables and root) generated from TS,
   and check both stacks: set, create, delete, connect, disconnect, ordered positions, join
   tables, and `created`/`modified` from the operation's `at` (where the stacks will drift).
   The update's `after` must be exactly the tree the host derives by replay.
3. **A row-change kind in `UpdateCoordinator`.** `appendRows([RowOperation])` beside
   `appendStructure`: replays into the working tree's overlay at once (offline included) and
   publishes the operations as the frame's authored evidence. Pending row operations are kept
   and replayed onto a new basis, as structural changes are. A refusal shows like any other
   declined change; a row-field decision (the same field changed on two devices) shows at
   least read-only.
4. **From the view to row operations.** Map `viewEdits`' layout-row edits to logical row
   operations (the inverse of `rowsFromLogical` for one edit: a join-table row is a
   connect on its holder, a position is a move). Vectors beside `presented-views.json`.
5. **Simple edits in the collection view, Mac and iPhone.** A bullet choice's dot opens a menu
   of values; the line's first text field renames inline; chips add and remove through a
   menu; a line's context menu deletes (or removes from the group); a group gets an "Add" line
   that creates a row there. Each re-presents from the working tree. The rich editor stays
   002 milestone 4.
6. **Close out.** Record the evidence in `status.md`, delete
   [Apps 010](../later/apps-010-native-offline-collection-file-projection.md) (this covers it),
   remove milestone 3a from 002, and delete this plan.

**Verification:** `bun run test:affected`, the StoryKit, Overstory and OverstoryWorkingTree
package tests and `swift/scripts/test-story-app.sh` on Joe's Mac. By hand with Joe: in the
games sandbox tree, change a game's status on the iPhone offline and rename it on the Mac;
both reconnect and both edits are there, and Story Sync's `Game.jsonl` shows them. The same
field edited on both devices shows a decision.

## Not in this plan

- The structured editor, drafts and pickers that search rows (002 milestone 4).
- A SQLite projection on the device: the overlay's rows are enough at sandbox sizes. Large
  collections are [Performance 004](../later/performance-004-provenance-index.md)'s concern.
- Ownership (002 milestone 5) and collections kept elsewhere (002 milestone 7).
