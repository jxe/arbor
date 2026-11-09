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

1-3 are built (`packages/overstoryd/src/updates/entry-times.ts`), waiting on the
rehearsal and a deploy:

- The index is a rebuildable cache, `entry-times.sqlite3` beside the host database:
  one row per `(tree, entry path, object hash)` with its first `acceptedAt`, and
  each tree's last indexed update. It follows from accepted history alone, so it is
  written just after each acceptance commits (WAL, batched, no fsync of its own), and
  the backfill is the same catch-up run from update 0, in the host process, sliced so
  requests keep flowing, never on the merge worker. A lost or stale index catches up
  on the next start. A timed read of a root the index has not reached waits for it if
  it is close, else answers 503 retryable.
- Kind changes (file to page and back) keep their time. A tree's first retained
  root (history squashed by migration 016) takes earlier dates from
  `document_versions` and `entry_metadata` where they have them.
- `?times` on snapshot and path reads; TS client `timedSnapshot` / `timedPathRead`;
  Story Sync answers `?times` on loopback by passing on the host's timed read.
  Conformance vector in `protocol-snapshot-bundles.json` (`timed`).

Left:

1. **Rehearse** with `tests/performance/rehearse-entry-times.ts <copy of /data>` on a
   copy of Joe's real data (cold start, rebuild, comparison with `entry_metadata`),
   then deploy with Joe's go.
2. **Clients move:** Swift (`ProtocolClient.entryMetadata`, `TreeSession.refreshEntryDates`)
   reads `times` from the bundle; then Protocol 001 removes `entry-metadata`.
