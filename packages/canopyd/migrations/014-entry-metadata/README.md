# Migration 014: entry metadata and the document-version index (15 → 16)

Carries [canopyd 013](../../../../plans/canopyd/013-entry-metadata.md) and the
storage half of [canopyd 007](../../../../plans/canopyd/007-canopy-document-history.md).
Additive: two new tables, nothing rewritten. Tree roots, accepted updates,
objects, observations, merge states and conflicts are untouched, so the
report's roots equal the backup's.

- `entry_metadata (tree_id, path, modified_at, update_id, data_json)`: every
  file entry of each tree's current root and the `accepted_at` of the update
  that last wrote it there. Served by `GET /.arbor/trees/{id}/entry-metadata`.
- `document_versions (tree_id, stable_key, update_id, entry_path,
  content_hash, accepted_at)`: one row per accepted content version of each
  Markdown document, keyed by `id:<PageID>` or `path:<entry path>`. No route
  reads it yet; canopyd 007's history routes will.

canopyd now fills both inside every accepted transaction
(`AcceptedUpdateStore.insertWithinTransaction` → `EntryMetadataStore.apply`),
from `entryChanges(previousRoot, root)` computed before the transaction. The
migration replays exactly that over each tree's accepted updates in insertion
order. `migrate.test.ts` proves the backfill equals what the accepting host
wrote for the same history.

The same deploy also carries canopyd 012 (effect piece deltas; no stored
history changes) and canopyd 011 (`addEntry`; server accepts it before any
client emits it). Neither needs migration.

## History boundary

Each tree's first retained accepted update is its boundary: every file it
holds is dated there. Live history begins at the 2026-09-02 cutover, so pages
untouched since then read as that date. `prunedHistory` counts trees whose
first retained update names a pruned predecessor. A missing accepted root, or a
chain that breaks after the first row, stops the run at schema 15.

## Offline run

After the archive backup and with writers quiesced:

```sh
bun packages/canopyd/migrations/014-entry-metadata/run.ts /data | tee live-report.json
```

Progress goes to stderr as JSON events; the report is the single JSON line on
stdout. Order: stamp and `quick_check` → replay every accepted update's entry
changes (object reads) → one transaction (tables, rows, stamp 16) → schema
check. A crash before the transaction leaves schema 15 untouched; a rerun after
it reports `migrated: false`.

## Verification

```sh
bun run test:migration packages/canopyd/migrations/014-entry-metadata
```

Then serve the migrated copy with the new build, confirm it opens, read
`/entry-metadata` for a tree, and run `verify.ts` against the report once
(it calls `/.arbor/health`, a full audit: never poll it).

## Rehearsal log

Pending.
