# overstoryd 006: What changed on a page, and who wrote each line

**Why:** Joe uses his todos tree's root page as a to-do list and deletes items as he goes,
so he wants to see what he added and deleted on a given day (2026-10-27). Later, the same
reading gives `git blame`-style line provenance, with the submitter and the agent when an
update names one ("Joe · Claude").

Historical identifier: **Smaller project 006**. Rewritten 2026-11-07 (Joe) around the
[provenance index](../../docs/architecture/overstoryd/provenance-index.md) that Performance 004
deployed on 2026-11-02. The earlier version (line matching over `document_versions`, after
overstoryd 007) is in git history.

## Status

- **Effort:** M for page changes and blame; the submitter half is another M.
- **Risk:** MEDIUM for page changes and blame (a read route over private history); HIGH for
  the submitter half (durable identity metadata, a migration, a public protocol change).
- **State:** PLANNED
- **Depends on:** nothing. It no longer waits for
  [overstoryd 007](../features/history-007-document-history-routes-and-restore.md): it reads
  the index and the update log, not 007's history routes. The agent attribution in step 6
  comes from 007 step 5.

## Target result

1. **Page changes.** `story changes <page> --day yesterday` (or `--since`/`--until`) prints
   what was added to and deleted from that page in the range: lines added and still there,
   lines deleted, and lines added and deleted within the range, each with its time. A
   reworded line is an edit, not a delete plus an add.
2. **Blame.** For the current version of a page, ordered line spans covering every line
   once, each naming the accepted update that introduced it and its acceptance time.
3. **Submitter.** Each span also names who submitted the update (and the agent, when the
   update names one), shown first in an optional **Line provenance** view in the native
   Source inspector (`StorySourceInspector`, `swift/StoryApp/StoryDailyDriverViews.swift`).

Claims stay narrow: an update is **submitted by** a profile, never "authored" or "signed";
an automatic merge does not reattribute lines it kept; and nothing exposes device IDs,
account IDs, credentials or link digests.

## What exists

- **The index.** Every accepted entry has a provenance index (pointer row in
  `provenance/v1/pointers.sqlite3`, read with `ProvenanceStore.index`,
  `packages/overstoryd/src/updates/provenance-store.ts`). Each page body is a list of
  pieces `[origin, start, length]`, and a page's node id survives renames and moves. Older
  entries are filled in the background from startup.
- **Origins name changes.** An inserted run's origin is `["<change>","<operation key>"]`;
  `accepted_updates (tree_id, change_id)` is uniquely indexed and gives the update's
  `ordinal` and `accepted_at`. `snapshot:<change>:/<path>` names a change too.
  `basis:<tree>:<root>` is everything before the tree's first retained entry (migration
  016 squashed history to each tree's head on 2026-09-24): shown as "before history".
- **Inserted text without snapshots.** An `editSource` operation carries its `text` in the
  log entry's trace, so the bytes `[change, op, start, length]` names are read from the
  entry itself. A line added and deleted within a range is recovered without loading any
  version of the page.
- **The cost of snapshots, measured.** Answering Joe's question for 2026-10-26 from
  `document_versions` meant 244 versions of a 60 KB page (16 MB) for one day. The scripts
  are in the project's `todo-history/` folder; this plan replaces them.
- **The public leak (for step 5).** Portable `AcceptedUpdate` still carries the raw
  `subject` (`packages/protocol/src/updates/types.ts`), a device ID or link subject.

## Reading the index

- **Changes in `[since, until)`.** Take the index at the last entry accepted before
  `since` (A) and before `until` (B), and the page's node in each, found by node id, not
  path. Added: B's pieces whose origin's change was accepted in the range. Deleted: A's
  pieces that B no longer holds (by origin and overlapping range, `intersectPieces`), with
  their text from A's body. Within the range: pieces whose origin's change is in the
  range and that B does not hold, with their text from the log entry. That is two page
  bodies and a walk of the range's log entries, never every version.
- **Lines.** Pieces are grouped into the lines of the text they sit in. A line is
  **added** when every non-whitespace byte in it is new in the range, **deleted** when
  every one is gone, and otherwise **edited** (shown before and after).
- **Blame.** The current index alone. A line holding pieces from several updates is
  attributed to the newest; the span also says when the line holds older bytes, so a typo
  fix does not hide where the line came from.

## Decisions (freeze first)

1. **Snapshots keep unchanged pieces.** Today a snapshot, a property frame, a rebound
   merge answer during the background fill, or a file turned into a page credits the whole
   body to that one change (`rebindProvenance`), so the page would look entirely "added"
   then. Recommended: when the kind is the same, or a Markdown file became a page with the
   same body, diff old and new bytes and keep the pieces of unchanged runs; only changed
   runs become `snapshot:` origins. The index is a cache, so the change bumps
   `PROVENANCE_VERSION`, updates the conformance vectors, and recomputes indexes in the
   background. Step 0 measures how much this matters.
2. **Access.** A write-capable device credential for the tree, since changes and blame
   reveal deleted text. No Story Sync proxy: editors and the CLI call overstoryd directly.
3. **Where the submitter lives** (step 5). Recommended: server-derived columns on
   `accepted_updates` (`actor_kind`, `actor_profile_tree`), set from the authorization
   context that passed `canWrite`, never from caller JSON; the log entry format stays the
   sidecar's contract. Portable `AcceptedUpdate` replaces `subject` with the safe `actor`
   in TypeScript, Swift and fixtures in one change. Updates from before the columns are
   `unknown` unless provable by joining device to account to profile.

```ts
type PageChangeLine = {
  kind: "added" | "deleted" | "edited" | "added-and-deleted";
  text: string; before?: string;          // `before` for edited lines
  update: string; acceptedAt: number;     // the newest update that touched it
  until?: number;                         // when an added-and-deleted line went
};
type PageChanges = { tree: TreeID; node: string; path: LogicalPath; since: number; until: number; lines: PageChangeLine[] };

type LineProvenanceSpan = {
  startLine: number; endLine: number;     // one-based, inclusive
  update: string | null;                  // null for "before history"
  acceptedAt: number | null;
  holdsOlder: boolean;                    // some bytes come from earlier updates
  actor?: LineProvenanceActor;            // from step 5
  attribution?: UpdateAttribution | null; // from overstoryd 007 step 5
};
type LineProvenance = { tree: TreeID; node: string; path: LogicalPath; update: string; spans: LineProvenanceSpan[] };
```

```text
GET /.overstory/trees/{TreeID}/changes?path={logical-path}&since={ms}&until={ms}
GET /.overstory/trees/{TreeID}/blame?path={logical-path}&at={accepted-update-id}
```

`at` must be the current update; otherwise `409 stale-update` with the current id.

## Steps

0. **Measure on the live host** (read-only, over `railway ssh`). For the todos tree's
   root page: how many of its bytes have `snapshot:` or `basis:` origins, whether every
   retained entry has an index, and what its conversion to pages (2026-11-01, update 14803) did to
   it. This decides how urgent decision 1 is.
1. **Snapshots keep unchanged pieces** (decision 1): `rebindProvenance` diffs, new
   conformance vectors, `PROVENANCE_VERSION` 2, background recompute. Rehearse on a
   production copy with a cold start, never on the merge worker.
2. **Engine.** `pageChanges` and `lineProvenance` in `@ovst/protocol` beside the index
   code, pure over a loader. Cases: insert, delete, replace, a reworded line, repeated and
   blank lines, LF/CRLF, moves and renames, merges, snapshots, "before history", a range
   with no entries, limits (a typed error, never a partial result that looks complete).
3. **Routes.** Both routes in overstoryd, authorized per decision 2, with typed failures
   for stale, not a page, missing index (computed on demand from the nearest earlier one,
   as the index allows) and oversized ranges. Spec text in `01-tree-operations.md` and
   `05-access-control.md`.
4. **`story changes`.** The CLI command over the route for a page in a placed folder,
   `--day today|yesterday|YYYY-MM-DD` in the device's time zone, or `--since`/`--until`.
   Plain text: Added, Deleted, Edited, Added and deleted, each line with its time.
5. **Submitter** (decision 3): columns and derivation at every acceptance path (ordinary
   updates, account configuration, boundary rewrites, tree creation), a migration step in
   `packages/overstoryd/migrations/next/` with the backfill, the portable `actor` across
   TS, Swift, fixtures and spec. Rehearse on a production copy.
6. **Native view.** `ProtocolClient.blame`; the inspector gutter grouping spans, profile
   labels resolved at display time, "Joe · Claude" for attributed spans and a filter by
   agent, **Available after changes sync** while the change log has unpublished work for
   the page, and accessibility labels reading line, submitter and date.

## Use case: replaying voice recordings

Story keeps transcribed voice recordings on the device and matches blocks to them by page
and in-order words, a stopgap. With blame, Story stores the change ID that inserted each
transcript in its local recordings index and finds a block's recording through the line's
update. No recording reference ever syncs.

## Verification

`bun run typecheck`, `bun run test`, `bun run test:protocol`, the migration suite while
step 5's migration exists, `swift test` for `swift/Packages/Overstory` and
`OverstoryWorkingTree`, macOS and iOS builds through `swift/Story.local.xcworkspace`,
`bun run check:links` and `git diff --check`. Hands-on: `story changes` for a day on Joe's
todos page matches what he remembers doing; two profiles editing alternate lines on two
devices show the right profile per line after sync, and a merge keeps earlier lines'
submitters.

## Out of scope

Restore and the History list (overstoryd 007), whole-tree history, copy detection,
collection rows or generated results, binary files, per-update profile signatures,
cross-host history transfer.

## STOP conditions

- Attribution would trust a caller-supplied TreeID.
- A result would expose device IDs, account IDs, credentials or link digests.
- A line would be credited to an older update without the index proving it.
- Acceptance would have to wait for changes or blame computation, or background work
  would use the merge worker.
- Live migration, recompute or deployment: each needs Joe's go-ahead.
