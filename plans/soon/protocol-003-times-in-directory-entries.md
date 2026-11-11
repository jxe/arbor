# Protocol 003: times in directory entries, one date encoding, history dropped

**Why and when:** Joe decided on 2026-11-11, in the spec review, that times belong in the
tree. A file or page entry now carries `created` and `modified`, stamped from the update's
`at` (the editor's time), the same way rows already carried theirs. Row `Date` values are
tagged like page dates. The spec says this now
([data model §6](../../docs/overstory-spec/1.1-data-model.md#6-entry-times),
[updates and merging §1](../../docs/overstory-spec/1.3-updates-and-merging.md#1-the-update-request),
[data model §7](../../docs/overstory-spec/1.1-data-model.md#7-cbor-and-hashes),
[collections §2](../../docs/overstory-spec/1.4-collections.md#2-rows-and-values)).
The code lags it until this plan is done. Soon.

This changes the hash of every directory and row object, so it is a flag day rather than a
both-forms move. Joe: drop history in the migration, and he will have Oliver update his app at
the same time.

## Status

- **Effort:** L.
- **Risk:** HIGH. It rewrites every tree on the live host, and old clients stop working.
- **Depends on:** nothing. It replaces Protocol 002's index, and it is a good moment to finish
  Protocol 001 and Filesystem 026, because every client updates at once.

## Steps

1. **Object format** in `packages/protocol` and Swift StoryKit: directory entries with
   `created`/`modified` (Unix ms) on file and page entries; row `created`/`modified` as Unix ms;
   row `Date` values as tags 1004/0; `CandidateUpdate.at` and request digest domain
   `overstory-update/1` (was `arbor-update/2`; the TreeID derivation domains
   `arbor-person-profile-v1` and `arbor-tree-config-v1` stay, since TreeIDs outlive history). Regenerate the conformance vectors.
2. **Stamping:** every writer sets `at` and stamps the entries it creates or changes (a folder scan may use each file's earlier mtime, never later than `at`; the host checks `created <= modified <= at`): Story
   (Swift), Story Sync, the CLI and working-tree. Renames, moves and file-page conversions keep
   both times. Derived candidates derive with `at`.
3. **Merging:** overstoryd and the merge helper apply the §1.1.2a rule (later `modified` when
   both sides changed an entry; earliest `created`).
4. **Story Sync:** write `modified` to the disk file's mtime; its local API answers times from
   the entries.
5. **Remove Protocol 002:** the entry-times index (`entry-times.sqlite3`), `?times`,
   `TimedBundle`, `entry-metadata` and the `entry_metadata` table, and `timedSnapshot` in TS and
   Swift.
6. **Migration tool** in `tools/` (not the `story` CLI): for each tree, write its current head
   in the new format as a fresh first accepted update, dropping older history. `modified` comes
   from the Protocol 002 index (first appearance of the current object at its path); `created`
   is the earliest time that path appears in the index. Rows convert their times to Unix ms and
   their `Date` fields to tags using their schema. Trees still holding Markdown as files convert
   to pages in the same pass. Rehearse on a copy of Joe's data with a cold start and real time
   limits.
7. **Flag day** (Joe's go): back up `/data`, deploy, run the migration, release Story (Mac and
   iPhone) and `@ovst/cli` together; Joe and Oliver update right away. The same release
   carries every move [Protocol 001](protocol-001-spec-review-route-changes.md) still lists
   (flat watch frames, `AcceptedRef`, flat `Ref`, objects as bytes, no `observedThrough`, and
   the rest) with no period of answering both forms, and deletes every old form.

## Settled

- No `by` on entries (Joe, 2026-11-11): who changed what stays in history.
