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

1. **A first-appearance index.** One SQLite row per `(tree, entry path, object hash)` the
   tree has held: the `acceptedAt` of the first accepted update that put that object at that
   path. Written in the accepted update's transaction from the same tree diff
   `EntryMetadataStore.apply` walks (insert-or-ignore, so only new pairs cost a write), and
   kept while any retained root holds the pair. Lookup for a bundle: every file and page
   entry of its directories, by `(path, hash)`.
2. **Fill it from history.** One pass over retained accepted updates, oldest first, in
   batches outside the merge worker (the 2026-11-01 backfill lesson), resumable, with
   the host serving the old route meanwhile. Rehearse on a copy of Joe's real data with a
   cold start and real time limits before deploying; Railway's disk is slow, so measure
   the rows written and fsyncs.
3. **Serve `?times`** on snapshot and path reads (`times` member, ETag `;times`), and a
   conformance vector for a timed bundle. Story Sync answers it on loopback the same way.
4. **Clients move:** the TS protocol client, Story Sync's reads, and Swift
   (`ProtocolClient.entryMetadata` callers, `TreeSession`) read `times` from the bundle;
   then Protocol 001 removes `entry-metadata`.
