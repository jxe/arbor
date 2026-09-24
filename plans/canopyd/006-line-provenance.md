# canopyd 006: Record who submitted each update and show line provenance

Historical identifier: **Smaller project 006**. Rewritten 2026-09-24 for the current
host: migration 016 squashed each tree's accepted history to its head, canopyd 016
made each accepted update an immutable log entry, and every editor is a direct
Canopy client. The earlier version (walk accepted roots backward, Arbor Sync proxy
route, full actor backfill) is in git history.

## Status

- **Priority:** P2
- **Effort:** L
- **Risk:** HIGH. It adds durable identity metadata, a schema migration, a
  public protocol change, and a read route over private history.
- **State:** PLANNED
- **Depends on:** [canopyd 007](007-document-history-routes-and-restore.md). Its
  history reader, key resolution and retention bound are what this plan walks.
  Execute after it.

## Target result

For the current source of a Markdown document, an authorized reader can ask who
introduced each line: ordered, complete line spans naming the accepted update, its
acceptance time and a safe actor. It is like `git blame`, with narrower claims:

- it names the accepted update that first introduced the current exact line;
- the actor is the person Profile TreeID bound to the submitting device's account
  at acceptance, labelled **submitted by**, never **authored by** or **signed by**;
- an automatic merge does not reattribute lines it kept from earlier updates;
- public, access-link, system and unknown actors stay distinguishable, without
  exposing device IDs, account IDs, credentials or link digests; and
- it exposes no deleted source beyond canopyd 007's History contract.

The first presentation is an optional read-only **Line provenance** view in the
native Source and Properties inspector (`ArborSourceInspector`,
`swift/CanopyApp/ArborDailyDriverViews.swift`).

## What exists

- **Per-document lineage.** `document_versions (tree_id, stable_key, update_id,
  entry_path, content_hash, accepted_at)` in
  `packages/canopyd/src/updates/entry-metadata.ts` has one row per content change of
  each Markdown document, in accepted order (rowid), keyed by frontmatter `id:` when
  unique so it follows moves. The retention definition keeps every row's body.
  This is exactly the sequence blame needs; there is no need to walk whole roots.
- **Updates since the squash.** `accepted_updates` rows accumulate again after
  migration 016, each naming its immutable log entry (`entry`) and a private
  `subject` (`device:<id>`, `public`, link subject). A version row written after
  2026-09-24 names a real row; one written before names an update migration 016
  squashed.
- **The public leak.** Portable `AcceptedUpdate` still carries the raw `subject`
  (`packages/protocol/src/updates/types.ts`), returned in update results and watch
  transitions. That is a device ID or link subject, not a safe actor.

## Decisions (freeze first)

1. **Where the actor lives.** Recommended: a server-derived column on
   `accepted_updates` (`actor_kind`, `actor_profile_tree`), set from the
   authorization context that passed `canWrite`, never from caller JSON. The log
   entry format stays the sidecar's contract and does not change. Alternative:
   add `actor` to the log entry so it is hash-chained with the update; that changes
   `overstory-log-entry-v1` and the sidecar decoder.
2. **Portable shape.** Replace `subject` with the safe `actor` in `AcceptedUpdate`
   across TypeScript, Swift and fixtures in one change (clean break; no shim).
3. **Pre-squash history.** Versions whose update was squashed get actor `unknown`
   but keep their `accepted_at`. No backfill: the device-to-profile join for
   squashed updates is gone. Rows since the squash can be backfilled from
   `subject` by joining device → account → profile, and anything unprovable is
   `unknown`.

```ts
type LineProvenanceActor =
  | { kind: "profile"; tree: TreeID }
  | { kind: "public" } | { kind: "access-link" } | { kind: "system" } | { kind: "unknown" };

type LineProvenanceSpan = {
  startLine: number; endLine: number;   // one-based, inclusive
  update: string | null;                // null when the update was squashed
  acceptedAt: number;
  actor: LineProvenanceActor;
};

type LineProvenance = {
  tree: TreeID; path: LogicalPath; stableKey: string | null;
  update: string; contentHash: ObjectHash;
  continuity: "stable-key" | "path";
  spans: LineProvenanceSpan[];          // ordered, non-overlapping, covers every line once
};
```

```text
GET /.arbor/trees/{TreeID}/blame?path={logical-path}&at={accepted-update-id}
```

`at` must be the current update; otherwise `409 stale-update` with the current id.
Access is the same as canopyd 007's history routes (a write-capable device
credential), since blame reveals when deleted-then-restored lines existed. There is
no Arbor Sync proxy: editors call canopyd directly.

## Algorithm

A pure module in `packages/canopyd/src/`, no HTTP or account lookups.

1. Resolve `path` in the current root to its body, content hash and key (canopyd
   007's resolver). Tokenize exact source into lines, keeping each terminator; a
   final unterminated line is still a line.
2. Read that key's `document_versions` rows newest first. Start every line at the
   newest version.
3. For each older version, match unchanged exact lines against the newer one and
   carry matches back; freeze unmatched lines at the newer version.
4. Duplicate lines: deterministic occurrence-aware matching; when ambiguous,
   prefer the newer attribution.
5. A merged update wrote one version compared with the one before it, so lines it
   kept stay with their earlier versions and only lines new in that version are
   attributed to the merge's submitter.
6. Restores attribute reintroduced lines to the restoring update. No copy
   detection.
7. Stop honestly at the first version, at canopyd 007's retention bound, or where
   a path-keyed document was moved. Report `continuity: "path"` for path keys.

Use a bounded-memory line matcher, with explicit limits on source bytes, lines,
versions and work, and a typed error past them; never a partial result that looks
complete. Measure a long document with long history before fixing the limits. Add
a cache keyed by `(tree, update, key, contentHash)` only if measurement justifies
it, and never on the acceptance path.

## Steps

1. **Actor recording.** Columns, derivation at every acceptance path (ordinary
   updates, account configuration, boundary rewrites, tree creation), invariant
   checks, and the next free migration (after canopyd 018's) adding the columns
   and backfilling post-squash rows. Rehearse on a production copy.
2. **Portable actor.** Replace `subject` with `actor` in TS, Swift, fixtures, spec
   (`01-tree-operations.md`) and docs together.
3. **Engine.** Direct edits, insert/delete/replace, repeated and blank lines,
   LF/CRLF/CR, frontmatter, stable-ID moves, path-only moves, merges, restores,
   squashed versions, limits.
4. **Route.** Current-only, authorized like history, typed failures for stale,
   non-Markdown, invalid UTF-8, oversized and missing objects. Spec text in
   `01-tree-operations.md` and `05-access-control.md`.
5. **Native view.** `ArborWireClient.blame`; the inspector view with a gutter
   grouping spans, profile labels resolved from the TreeID at display time,
   literal labels for non-profile actors, **Available after changes sync** while the
   change log has unpublished work for the document, and accessibility labels that
   read line, submitter and date.

## Verification

`bun run typecheck`, `bun run test`, `bun run test:protocol`, the migration suite
while the migration exists, `swift test` for `swift/Packages/Overstory` and
`CanopyWorkingTree`, macOS and iOS builds through `swift/Canopy.local.xcworkspace`,
`bun run check:links` and `git diff --check`. Hands-on: two profiles editing
alternate lines on two devices show the right profile per line after sync, and a
merge keeps earlier lines' submitters.

## Out of scope

Generic tree history, diffs, copy detection, database rows or generated results,
binary files, per-update profile signatures, cross-canopyd history transfer.

## STOP conditions

- Attribution would trust a caller-supplied TreeID.
- Blame would need to enumerate history more widely than canopyd 007 allows, or
  expose device IDs, account IDs, credentials or link digests.
- The only workable matcher would claim an older actor for a duplicate line
  without proof.
- Acceptance would have to wait for blame computation.
- Live migration or deployment: each needs Joe's go-ahead.
