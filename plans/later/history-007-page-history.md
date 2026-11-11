# overstoryd 007: Page history: what changed, restore, and who wrote each line

**Why:** Joe uses his todos tree's root page as a to-do list and deletes items as he goes,
so he wants to see what he added and deleted on a given day (2026-10-27). The same reading
gives a page's History with Restore, agent runs in History with Undo Run, and `git
blame`-style line provenance naming the submitter and the agent ("Joe · Claude").

Historical identifiers: **Smaller projects 006 and 007**. Merged into one plan on
2026-11-07 (Joe) and rewritten around the
[provenance index](../../docs/architecture/overstoryd/provenance-index.md) that Performance
004 deployed on 2026-11-02. Agent runs in History (formerly **Agents 003**) joined on
2026-11-01. The earlier plans (history over `document_versions` keys, blame by line
matching) are in git history.

## Status

- **Effort:** L, in slices that each ship on their own.
- **Risk:** MEDIUM for changes, History and blame (authenticated routes over private
  history, a restore whose meaning changes); HIGH for the submitter (durable identity
  metadata, a migration, a public protocol change).
- **State:** PLANNED
- **Depends on:** nothing.

## Target result

1. **Page changes.** `story changes <page> --day yesterday` (or `--since`/`--until`) prints
   what was added to and deleted from that page in the range: lines added and still there,
   lines deleted, lines edited, and lines added and deleted within the range, each with its
   time.
2. **History and Restore.** **History** on a page lists its accepted versions, newest first,
   each with a summary ("+3 lines, −1") from the same reader. **Restore as New Change**
   fetches one version's exact source and submits it as an ordinary new edit through the
   change log, so every later version stays in history. Trash recovery is a separate
   repair tool and never appears as History.
3. **Agent runs.** Updates can name the agent and run that made them; a run is one History
   entry labelled with its task, and **Undo Run** is a restore.
4. **Blame.** For the current version of a page, ordered line spans covering every line
   once, each naming the update that introduced it, its time, and later its submitter and
   agent, in an optional **Line provenance** view in the native Source inspector
   (`StorySourceInspector`, `swift/StoryApp/StoryDailyDriverViews.swift`).

Claims stay narrow: an update is **submitted by** a profile, never "authored" or "signed";
an automatic merge does not reattribute lines it kept; nothing exposes device IDs, account
IDs, credentials or link digests.

## What exists

- **The index.** Every accepted entry has a provenance index (pointer row in
  `provenance/v1/pointers.sqlite3`, read with `ProvenanceStore.index`,
  `packages/overstoryd/src/updates/provenance-store.ts`). A page body is a list of pieces
  `[origin, start, length]`, and a page's node id survives renames and moves, with or
  without an `id:` property. Older entries are filled in the background from startup.
- **Origins name changes.** An inserted run's origin is `["<change>","<operation key>"]`;
  `accepted_updates (tree_id, change_id)` is uniquely indexed and gives the update's
  `ordinal` and `accepted_at`. `snapshot:<change>:/<path>` names a change too.
  `basis:<tree>:<root>` is everything before the tree's first retained entry (migration
  016 squashed history to each tree's head on 2026-09-24), shown as "before history".
- **Inserted text without snapshots.** An `editSource` operation carries its `text` in the
  log entry's trace, so the bytes `[change, op, start, length]` names are read from the
  entry itself.
- **The version list.** `document_versions (tree_id, stable_key, update_id, entry_path,
  content_hash, accepted_at)` is written in every accepted transaction by
  `EntryMetadataStore.apply` (`packages/overstoryd/src/updates/entry-metadata.ts`), one row
  per content change, rowid in accepted order, and the retention definition keeps every
  row's body. Its key is `id:<PageID>` or `path:<entry path>`, so a page without an id
  loses its history at its first move and duplicate ids share a key. Nothing reads it yet.
  A version from before migration 016 names an update the migration squashed.
- **The cost of reading versions, measured.** Answering Joe's question for 2026-10-26 from
  `document_versions` meant 244 versions of a 60 KB page (16 MB) for one day. The scripts
  are in the project's `todo-history/` folder; the changes route replaces them.
- **Clients.** `WorkspaceDocumentSession.history()` / `recover(revision:)` is the UI seam.
  `WorkingTreeProvider` throws "history is not available yet", and
  `StoryDocumentBinding.history()` flushes and delegates to it, so History shows an empty
  state today. `StoryHistoryView` already says **History** and **Restore as New Change**.
  Every editor is a direct host client with its own credential: no Story Sync proxy, no
  local copy.
- **Agent runs today.** Story Sync keeps a pre-run snapshot per run for a day
  ([agents](../../docs/architecture/story-sync/agents.md#runs)); Undo Run uses it.
- **The public leak.** Portable `AcceptedUpdate` still carries the raw `subject`
  (`packages/protocol/src/updates/types.ts`), a device ID or link subject.

## Reading the index

- **Changes in `[since, until)`.** Take the index at the last entry accepted before `since`
  (A) and before `until` (B), and the page's node in each, found by node id. Added: B's
  pieces whose origin's change was accepted in the range. Deleted: A's pieces that B no
  longer holds (by origin and overlapping range, `intersectPieces`), with their text from
  A's body. Within the range: pieces whose origin's change is in the range and that B does
  not hold, with their text from the log entry. Two page bodies and a walk of the range's
  log entries, never every version.
- **Lines.** Pieces are grouped into the lines they sit in. A line is **added** when every
  non-whitespace byte in it is new in the range, **deleted** when every one is gone, and
  otherwise **edited** (shown before and after).
- **A version's summary** is the changes between it and the version before.
- **Blame** reads the current index alone. A line holding pieces from several updates is
  attributed to the newest; the span says when the line also holds older bytes, so a
  typo fix doesn't hide where the line came from.

## Decide first

1. **Snapshots keep unchanged pieces.** Today a snapshot, a property frame, a merge answer
   rebound during the background fill, or a file turned into a page credits the whole body
   to that one change (`rebindProvenance`), so the page would look entirely "added" then.
   Recommended: when the kind is the same, or a Markdown file became a page with the same
   body, diff old and new bytes and keep the pieces of unchanged runs; only changed runs
   become `snapshot:` origins. The index is a cache: bump `PROVENANCE_VERSION`, update the
   conformance vectors, recompute in the background. Step 0 measures how much it matters.
2. **Key versions by node id.** Recommended: `document_versions` rows keyed
   `node:<node id>` from the index the acceptance already computes, backfilled from the
   indexes, so History follows moves and duplicate ids stop mattering. The `id:`/`path:`
   keys go.
3. **Retention bound.** In 2026-09 `document_versions` held 106 MB of the collector's
   116 MB, nearly all versions of one 60 KB page, but that was before packing, which now
   zstd-compresses a page's versions together. Re-measure on the live host; choose a bound
   only if it still matters (for example every version for N days, then one a day). The
   changes reader also needs the log entries and indexes of the range it reads, so one
   bound covers both.
4. **Local versions.** Recommended: host only. Unpublished edits already survive in the
   change log and publish on reconnect, which keeps the "no second history store" STOP.
5. **Where the submitter lives.** Recommended: server-derived columns on `accepted_updates`
   (`actor_kind`, `actor_profile_tree`), set from the authorization context that passed
   `canWrite`, never from caller JSON; the log entry format stays the sidecar's contract.
   Portable `AcceptedUpdate` replaces `subject` with the safe `actor` in TypeScript, Swift
   and fixtures in one change. Updates from before the columns are `unknown` unless
   provable by joining device to account to profile.

## Contract (freeze first)

```ts
type PageChangeLine = {
  kind: "added" | "deleted" | "edited" | "added-and-deleted";
  text: string; before?: string;          // `before` for edited lines
  update: string; acceptedAt: number;     // the newest update that touched it
  until?: number;                         // when an added-and-deleted line went
};
type PageChanges = { tree: TreeID; node: string; path: LogicalPath; since: number; until: number; lines: PageChangeLine[] };

type PageVersion = {
  update: string | null;                  // null when migration 016 squashed it
  path: LogicalPath;                      // the page's path at that update
  contentHash: ObjectHash;
  acceptedAt: number;                     // Unix ms
  summary: { added: number; deleted: number; edited: number } | null; // null before history
  attribution: UpdateAttribution | null;  // step 6
};
type PageHistory = { entries: PageVersion[]; nextCursor: string | null }; // newest first
type PageVersionSource = PageVersion & { source: string }; // exact UTF-8

type LineProvenanceSpan = {
  startLine: number; endLine: number;     // one-based, inclusive
  update: string | null;                  // null for "before history"
  acceptedAt: number | null;
  holdsOlder: boolean;                    // some bytes come from earlier updates
  actor?: LineProvenanceActor;            // step 8
  attribution?: UpdateAttribution | null; // step 6
};
type LineProvenance = { tree: TreeID; node: string; path: LogicalPath; update: string; spans: LineProvenanceSpan[] };
```

```text
GET /.overstory/trees/{TreeID}/changes?path={logical-path}&since={ms}&until={ms}
GET /.overstory/trees/{TreeID}/history?path={logical-path}&cursor={cursor}
GET /.overstory/trees/{TreeID}/history/{update}?path={logical-path}
GET /.overstory/trees/{TreeID}/blame?path={logical-path}&at={accepted-update-id}
```

Freeze in `docs/overstory-spec/1.2-tree-protocol.md` and `3.2-access-control.md`:

1. The server resolves `path` in the current accepted root to the page's node, then reads
   by node id.
2. **Access:** a currently valid, authenticated **write-capable device credential** for the
   tree, for every route, since all of them reveal deleted text. Public, access-link and
   read-only callers cannot enumerate deleted source. Unknown, wrong-tree, unauthorized and
   unretained entries are indistinguishable `404`s. Known-hash object reads (for example
   sparse placement, Native 006) are not enumeration and do not widen this.
3. Bounded work everywhere: an opaque cursor and a fixed page size for History, a maximum
   range for changes; a limit returns a typed error, never a short result that looks
   complete.
4. `source` is exact UTF-8, line endings and final newline included. Non-page, invalid
   UTF-8 and missing cases fail explicitly. Blame's `at` must be the current update;
   otherwise `409 stale-update` with the current id.
5. Restore never rewinds overstoryd: the client submits the fetched source as a new edit
   through the change log and the ordinary update and conflict handling.

Changing who may enumerate history is a STOP for an explicit threat-model decision.

## Steps

0. **Measure on the live host** (read-only, over `railway ssh`). For the todos tree's root
   page: how many of its bytes have `snapshot:` or `basis:` origins, whether every retained
   entry has an index, and what its conversion to pages (2026-11-01, update 14803) did to
   it; and what `document_versions` bodies cost on disk now that they are packed. This
   settles decisions 1 and 3.
1. **Snapshots keep unchanged pieces** (decision 1): `rebindProvenance` diffs, new
   conformance vectors, `PROVENANCE_VERSION` 2, background recompute. Rehearse on a
   production copy with a cold start, never on the merge worker.
2. **Engine.** `pageChanges`, version summaries and `lineProvenance` in `@ovst/protocol`
   beside the index code, pure over a loader; `document_versions` keyed by node id
   (decision 2) with its backfill. Cases: insert, delete, replace, a reworded line,
   repeated and blank lines, LF/CRLF, moves and renames, merges, snapshots, delete and
   recreate, "before history", a range with no entries, limits.
3. **Routes.** Spec text, strict TS and Swift models and decoders, language-neutral
   fixtures both accept and reject identically, then the four routes in overstoryd with
   typed failures. Tests: wrong tree, revoked credential, read-only/public/link denial,
   pagination and bounds, stale blame.
4. **`story changes`.** The CLI command over the changes route for a page in a placed
   folder, `--day today|yesterday|YYYY-MM-DD` in the device's time zone, or
   `--since`/`--until`. Plain text: Added, Deleted, Edited, Added and deleted, each line
   with its time.
5. **History and Restore in Story.** `ProtocolClient.history`/`historyVersion`;
   `WorkingTreeProvider` sessions return overstoryd history. `recover` verifies tree, path
   and content hash, then appends the source to the change log as a new change; cover
   stale/current races and a conflict that preserves live editor text. The view: loading,
   **No accepted history yet**, offline ("History needs a connection to the host"; never a
   local fallback), error, rows labelled by acceptance time with their summary, and the
   **Restore as New Change** confirmation saying later history is kept.
6. **Updates can say an agent made them.** `1.2-tree-protocol.md`: an update gains an
   optional `attribution`:

   ```ts
   type UpdateAttribution = {
     agent: string;        // "Claude", "Codex"
     run: string;          // opaque, the same for every update of one run
     task: string;         // the task text, ≤ 280 characters
   };
   ```

   It is descriptive only: it never grants or limits anything, and access and authorship
   stay the account's and device's. The host stores it with the accepted update and
   returns it in History entries and blame spans. Story Sync's loopback API gains a way
   for the runner to say "updates from this placed tree belong to run R until I say
   otherwise" (it already holds the tree's publishing during a run, so a run publishes as
   one change); edits Joe makes in the same folder by other means during a run are
   attributed too, while the Story editor publishes on its own credential and is not.
   Models, vectors, and tests that an update with and without `attribution` round-trips,
   and that a forged one changes nothing about access. Runs `bun run test:protocol`.
7. **Agent runs in History** (Joe, 2026-10-30). A run is one History entry labelled with
   its task ("Agent: merge the duplicates and sort by aisle"), even when it touched several
   pages, listing the pages it changed. History is the task archive: the entry shows the
   task it came from. **Undo Run** (on the checked-off `[!agent-done]` block, and from the
   run's entry) restores each changed page to its version before the run, through step 5's
   restore, as new changes; a page changed by someone else since is listed and left alone,
   as the snapshot undo does today. Story Sync then stops keeping per-run snapshots
   ([agents](../../docs/architecture/story-sync/agents.md#runs)).
   **Verification:** a run touching two pages appears once in each page's history and once
   as a run; Undo Run restores both; with one page edited by hand after the run, that page
   is left alone and named.
8. **Submitter** (decision 5): columns and derivation at every acceptance path (ordinary
   updates, account configuration, boundary rewrites, tree creation), a migration step in
   `packages/overstoryd/migrations/next/` with the backfill, the portable `actor` across
   TS, Swift, fixtures and spec. Rehearse on a production copy.
9. **Line provenance view.** `ProtocolClient.blame`; the inspector gutter grouping spans,
   profile labels resolved at display time, "Joe · Claude" for attributed spans and a
   filter by agent, **Available after changes sync** while the change log has unpublished
   work for the page, and accessibility labels reading line, submitter and date.

## Use case: replaying voice recordings

Story keeps transcribed voice recordings on the device and matches blocks to them by page
and in-order words, a stopgap. With blame, Story stores the change ID that inserted each
transcript in its local recordings index and finds a block's recording through the line's
update. No recording reference ever syncs.

## Verification

`bun run typecheck`, `bun run test`, `bun run test:protocol`, the migration suite while
step 8's migration exists, `swift test` for `swift/Packages/Overstory` and
`OverstoryWorkingTree`, `swift/scripts/test-story-editor-local.sh`, macOS and iOS builds
through `swift/Story.local.xcworkspace`, `bun run check:links` and `git diff --check`.
Hands-on: `story changes` for a day on Joe's todos page matches what he remembers doing;
on Mac and iPhone, restore an older version and see the previous latest still listed
after acceptance, and offline History says the host is unreachable; two profiles editing
alternate lines on two devices show the right profile per line after sync, and a merge
keeps earlier lines' submitters.

## Out of scope

Whole-tree history, historical checkout, branching, history editing, copy detection,
collection rows or generated results, binary files, per-update profile signatures,
cross-host history transfer; Trash or crash recovery; any change to hashes, roots,
accepted order or merge policy.

## STOP conditions

- History, changes or blame would become readable by read-only, public, access-link or
  unauthenticated callers.
- Attribution would trust a caller-supplied TreeID.
- A result would expose device IDs, account IDs, credentials or link digests.
- A line would be credited to an older update without the index proving it.
- Restore cannot go through the change log without losing exact Markdown, bypassing
  conflict authority, or overwriting live text before acceptance.
- The work needs a second history store or cache on any client or daemon.
- Acceptance would have to wait for changes or blame, or background work would use the
  merge worker.
- Live migration, recompute or deployment: each needs Joe's go-ahead.
