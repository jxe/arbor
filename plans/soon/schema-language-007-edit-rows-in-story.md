# Schema language 007: edit collection rows in Story, on the Mac and iPhone

**Why and when:** Joe, 2026-10-24: once Schema language 006 showed a collection read-only
([status](../../status.md#collections-in-story-on-the-mac--2026-10-25)), the next step goes in soon. This is
[Schema language 002](../later/schema-language-002-cranberries-in-story.md)'s milestone 3a
(rows in Story on Mac and iPhone), carved out with a small proof: simple edits in 006's view.
The People directory needs both, and the iPhone has no Story Sync.

> **Executor instructions**: Do the steps in order. Swift is written in the cloud and built and
> tested on Joe's Mac (Remote Control). Spec 01 §2.1 and §2.4 and spec 10 §2.2 already describe
> derived candidates (drafted 2026-10-25); implement them as written, and bring any change the
> code needs back to the spec in the same commit.

## Status

- **Effort:** M.
- **Risk:** MEDIUM. A protocol addition overstoryd, Story Sync and both clients implement.
  No client encodes a collection's tables, so the two stacks can't disagree about them.
- **State:** TODO. 006 is done ([status](../../status.md#collections-in-story-on-the-mac--2026-10-25)); try edits on the games
  sandbox tree, which holds supplies-remake's live data.

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

## What exists

- **Wire:** row operations are authored operations (`rowCreate`, `rowDelete`, `rowSet`,
  `rowConnect`, `rowDisconnect`, `rowMove`; `packages/protocol/src/updates/authored-contract.ts`),
  with vectors in `protocol-authored-updates.json`. Today they travel in stated frames whose
  `after` the host checks by replay (`packages/collection-schema/src/row-replay.ts`,
  `executeRowOperations` in `packages/protocol/src/updates/source-trace.ts`), and it merges by
  field. Story Sync derives them from projection edits and sends stated frames.
- **Swift:** Overstory decodes rows chunks, StoryKit has `uslRowsFromLogical`,
  `presentView`, `viewEdits` and `applyRowEdits`, and Story draws the view read-only
  (`StoryCollectionView`, `StoryPresentedCollection`) from `WorkspaceProvider.collectionRows`.
  Swift has no `RowOperation`.
- **Story:** local changes go through `UpdateCoordinator` (`appendStructure` in
  `UpdateCoordinator+LocalChanges.swift`); there is no row-change kind.

## Steps

Two parts. **Part 1, the backend** (steps 0–4): Story reads collections on the iPhone and
writes row operations from code, queued offline, on both devices. People 001 phase 1 starts
when part 1 is done: the directory is kept by code and shown read-only. **Part 2, editing in
the view** (steps 5–6), can follow or run beside People 001.

0. **Read on the iPhone.** 006's view on iOS, from the tree's own objects, offline; fix what
   looks wrong at phone width.
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
4. **A row queue in `UpdateCoordinator`.** `appendRows([RowOperation])` beside
   `appendStructure` keeps pending row operations durably, sends them as derived elements
   (never followed by a stated element in the same string, which couldn't know its basis), and drops them when their result
   is applied. Text and structural edits made meanwhile wait for the result and rebase as on
   any accepted change. The collection view shows pending operations applied over the last
   received rows (a display-level apply on the logical tables, then `uslRowsFromLogical`;
   nothing hashed). A refusal shows like any other declined change; a row-field decision (the
   same field changed on two devices) shows at least read-only.
5. **From the view to row operations.** Map `viewEdits`' layout-row edits to logical row
   operations (a join-table row is a connect on its holder, a position is a move). Vectors
   beside `presented-views.json`.
6. **Simple edits in the collection view, Mac and iPhone.** A bullet choice's dot opens a menu
   of values; the line's first text field renames inline; chips add and remove through a
   menu (people from the directory Story has, keeping any `contact:` placeholders a row
   already holds; adding a new placeholder waits for People 001); a line's context menu
   deletes (or removes from the group); a group gets an "Add" line that creates a row there.
   The rich editor stays 002 milestone 4.
7. **Close out.** Record the evidence in `status.md`, delete
   [Apps 010](../later/apps-010-native-offline-collection-file-projection.md) (this covers it),
   remove milestone 3a from 002, and delete this plan.

**Verification:** `bun run test:affected`, the StoryKit, Overstory and OverstoryWorkingTree
package tests and `swift/scripts/test-story-app.sh` on Joe's Mac. By hand with Joe: in the
games sandbox tree, change a game's status on the iPhone offline and rename it on the Mac;
both reconnect and both edits are there, and Story Sync's `Game.jsonl` shows them; an edit
made in `Game.jsonl` shows in Story. The same
field edited on both devices shows a decision.

## Not in this plan

- The structured editor, drafts and pickers that search rows (002 milestone 4).
- A replica on the device that encodes tables, and any SQLite there (Joe, 2026-10-25). Large
  collections are [Performance 004](../later/performance-004-provenance-index.md)'s concern.
- Derived candidates for Story's text edits: allowed by the spec, not used.
- Ownership (002 milestone 5) and collections kept elsewhere (002 milestone 7).
