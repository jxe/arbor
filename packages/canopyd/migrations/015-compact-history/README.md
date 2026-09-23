# Migration 015: entry metadata and one accepted history (15 → 17)

One cutover from the live schema 15. It carries two changes:

1. **Entry metadata** ([canopyd 013](../../../../plans/canopyd/013-entry-metadata.md) and the
   storage half of [canopyd 007](../../../../plans/canopyd/007-canopy-document-history.md)).
   Migration 014 was written and rehearsed for this but never ran live. It is folded in
   here unchanged, and its directory is deleted.
2. **One accepted history.** Stored copies of accepted history are removed. The data now lives
   only in `accepted_updates`.

The migration accepts a schema-16 copy too, such as a 014 rehearsal copy. It then
does only the second step.

## What changes

- **`entry_metadata` and `document_versions`** (15 only). These are created and filled by
  replaying each tree's accepted updates in order, exactly as canopyd does inside every
  accepted transaction (`AcceptedUpdateStore.insertWithinTransaction` →
  `EntryMetadataStore.apply`).
- **`observations` is removed.** Its rows move into `accepted_updates.ordinal`, which is the
  `INTEGER PRIMARY KEY AUTOINCREMENT` rowid:
  - An accepted update's cursor is now `String(ordinal)`. The row keeps its `id`, which
    new rows spell as the same number.
  - Each accepted update keeps its old observation ordinal, so every cursor a client holds for
    an accepted update still resolves.
  - The sequence continues past the old observation sequence, so no ordinal is reused.
  - Legacy `tree.status` observations (`update_id IS NULL`) are dropped. A client anchored on
    one gets `resync-required`, which is the protocol's ordinary answer for a cursor the
    host no longer retains.
  - Writing an update used to take four statements (insert, re-spell the cursor, re-select,
    bind the update). It now takes one insert.
- **`reflog` is removed.** It was written in six places and read in none. Its rows repeated
  `accepted_updates (tree_id, root, previous_root, accepted_at)`.
  - `trees.ref` stays as the materialized head. `AcceptedUpdateStore.advance` is now the only
    thing that moves it, always together with the new accepted row.
  - `AcceptedCommitInput.expectedRoot` is gone, because it always equalled `previousRoot`.
- **`authored_changes` is reduced to `(accepted_id, trace_json, evidence_json)`.** Its tree,
  change, basis and candidate were copies of the owning accepted update's columns, and the
  store checked on every insert that they matched.
  - Reads now join `accepted_updates`. The `(tree_id, change_id)` uniqueness is still enforced,
    by `accepted_updates_change`.
  - The run stops if any copy disagrees.
- **`accounts.token_digest` is removed.** It was written at account creation and on token
  reset, but nothing read it. Authentication reads only `devices.token_digest`, and every
  account keeps its devices.
  - `accounts` is rebuilt, because SQLite cannot drop a `UNIQUE` column in place.
  - The run stops if any account has no device, since that account would lose its only
    stored credential. Startup already refuses that state.
- **Indexes.** `accepted_updates_tree` becomes part of the schema; it was an "additive read
  index" before. There is a new `accepted_updates_root (tree_id, root)`. The snapshot route's
  retained-root check used to scan a tree's whole history.

Unchanged: tree roots, update ids, objects, merge states, conflicts, devices, and every other
account column. The report's
roots equal the backup's. No wire format changes, and no client needs an update.

## History boundary (entry metadata)

Each tree's first retained accepted update is its boundary, and every file it holds is dated
there. Live history begins at the 2026-09-02 cutover, so pages untouched since then read as
that date. `prunedHistory` counts trees whose first retained update names a pruned predecessor.
A missing accepted root, or a chain that breaks after the first row, stops the run with the
database unchanged.

## Offline run

After the archive backup and with writers quiesced:

```sh
bun packages/canopyd/migrations/015-compact-history/run.ts /data | tee live-report.json
```

Progress goes to stderr as JSON events. The report is the single JSON line on stdout.

The run happens in this order:

1. Check the stamp and run `quick_check`.
2. Run the read-only checks. Every accepted update has exactly one observation. Each tree's
   insertion order equals its observation order. No observation is orphaned. Every
   `authored_changes` copy matches its accepted update. Every account has a device.
3. From 15 only, replay the entry changes (object reads).
4. With foreign keys off, run one transaction. It fills the entry tables, rebuilds
   `accepted_updates`, drops `observations` and `reflog`, rebuilds `authored_changes` and
   `accounts`, sets the sequence, stamps 17, and runs `foreign_key_check`.
5. Run the startup schema check.

A crash before the transaction leaves the database untouched. A rerun afterwards reports
`migrated: false`.

In the report:

- `statusObservations` should be small. It counts the legacy rows that were dropped.
- `respelledCursors` should be 0. It counts accepted updates whose old cursor text was not
  their decimal ordinal.
- `nextOrdinal` is the next cursor the host will assign.

The database is not vacuumed. The freed pages are reused.

## Verification

```sh
bun run test:migration packages/canopyd/migrations/015-compact-history
```

The test builds history with the schema-17 host, then rewrites it into the schema-15 layout (and
the 16 layout). That layout includes a legacy status observation, an observation sequence
that ran ahead, the reflog, and a full `authored_changes` row.

It checks that:

- the migration reproduces every accepted row (ordinal, id and all columns), every tree, the
  entry tables and the merge states exactly;
- it runs once;
- the migrated root serves;
- old cursors still resolve and the legacy status cursor does not;
- the next accepted update takes an ordinal past the old sequence;
- accounts and devices are unchanged apart from the dropped column, and the migrated host
  accepts an update authenticated by a device token;
- a disagreeing authored copy, an account without a device, or a missing accepted root stops
  the run with nothing changed.

Then serve the migrated copy with the new build, confirm that it opens, read
`/entry-metadata` for a tree, and run `verify.ts` against the report once. `verify.ts` calls
`/.arbor/health`, which is a full audit, so never poll it.

## Rehearsal log

Not yet rehearsed as 015.

For reference, the entry-metadata half was rehearsed as migration 014 on 2026-09-22.

- **Backup:** `.backups/railway/20260922T190204Z/volume.tar` (sha256 f49146fb…, matching the
  volume). Both the live database and the vacuumed copy held 2,515 accepted updates, 5 trees and
  1,533 merge rows at schema 15.
- **Report:** 2,515 updates replayed, 113 entry rows, and 2,569 document versions over 90
  documents. `prunedHistory` was 0. The replay took 1.3 s and the commit 49 ms.
- **Roots:** `compare-canopy-roots` showed all five roots unchanged.
- **Serving:** the schema-16 build opened the copy and warmed in 5.1 s. `/entry-metadata`
  answered 200 for public trees and 404 without credentials for private ones.
  `verify.ts --no-sync` passed.
- **Console tree dates:** 97 of 106 entries sit at the tree's history boundary (2026-09-13).
  The rest are dated on the days they were last edited.

That backup can be reused to rehearse 015. It is still at schema 15.
