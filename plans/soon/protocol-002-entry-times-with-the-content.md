# Protocol 002: entry times with the content

Joe wants one route for a page and its times, answerable for any retained root, not only
the current one, and not by replaying history (spec review, 2026-11-09). Tree operations
§1.1.2a now defines an entry's time as when its content first appeared at its path, a
function of the root alone, served as `times` beside the objects of a snapshot or path read
(`?times`). Joe: content restored to an earlier version may keep its first date. Comes
before [Protocol 001](protocol-001-spec-review-route-changes.md) retires `entry-metadata`.

Today overstoryd keeps times only for the current root (`EntryMetadataStore`, filled per
accepted update in `packages/overstoryd/src/updates/entry-metadata.ts`), keyed by path and
moved forward on every write, so it cannot date an older root.

## Steps

Built and deployed 2026-11-10 (791ca391; the live backfill indexed 12,921 updates in
5.2 s). Swift reads `?times` since the commit after it:

- The index is a rebuildable cache, `entry-times.sqlite3` beside the host database
  (`packages/overstoryd/src/updates/entry-times.ts`): one row per `(tree, entry path,
  object hash)` with its first `acceptedAt`, and each tree's last indexed update. It
  follows from accepted history alone, so it is written just after each acceptance
  commits (WAL, batched, no fsync of its own), and the backfill is the same catch-up
  from update 0, in the host process, sliced, never on the merge worker. A lost or
  stale index catches up on the next start; a timed read of a root it has not reached
  waits if close, else answers 503 retryable. `tests/performance/rehearse-entry-times.ts`
  rehearses it on a copy of a data root.
- Kind changes (file to page and back) keep their time. A tree's first retained root
  (history squashed by migration 016) takes earlier dates from `document_versions`
  and `entry_metadata`.
- Clients: TS `timedSnapshot` / `timedPathRead`; Story Sync passes the host's timed
  read through on loopback; Swift `ProtocolClient.timedSnapshot`, which
  `TreeSession.refreshEntryDates` reads for the current root.

Left: once a Story release with the Swift change is out and adopted (Joe, 2026-11-10:
wait for adoption), Protocol 001 removes `entry-metadata`, `ProtocolClient.entryMetadata`
and `EntryMetadataStore`'s `entry_metadata` table, then this plan closes.
