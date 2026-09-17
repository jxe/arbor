# Schema 8 → 11 live-copy rehearsal — September 17, 2026

Passed against a fresh backup of `canopy-arb-nxhx-org`, using source revision
`87554c0e68fa93b2262413b366fd7526dc981612`. No live migration, deployment, app
restart or client upgrade occurred. The server remains on schema 8.

## Backup and private evidence

Local archive, unmodified restore, migrated restore, copied phone control record,
rehearsal script and machine-readable report are retained under:

`/Users/joe/arbor-schema8-to11-20260917-3ryyl970/`

The server copy is on `canopy-arb-nxhx-org-volume` at:

`/backups/arbor-schema8-to11-20260917-3ryyl970/volume.tar`

The 37,785,600-byte archive was made with SQLite `VACUUM INTO` followed by a tar
of that database and immutable `objects/`. Every backup table count matched the
live database at capture. The downloaded archive matched the server SHA-256:

`289628da3552ed72974a6d8f5ac0b183567a3d257dcee1557d581e9791129fc6`

Apps and writers were not stopped for this read-only rehearsal. The SQLite snapshot
is consistent, and subsequent verification checks every object needed by its
retained roots. This is a rehearsal backup, not a claim that future live writes
are covered; take a fresh backup at the eventual deployment boundary.

## Verification

- Migration 009's five focused tests passed.
- The restored schema 8 database migrated to 11; a second invocation validated it
  without rewriting it (`migrated: false`).
- Exact comparison of every existing column and row passed for every original
  table, excluding only the intended `meta.schema_version` value change.
- All 493 accepted updates, 493 observations and 493 reflog entries were preserved,
  together with 5 tree rows, 3 boundaries, 4 devices, 4 access rows, 4 pairing rows,
  1 account and all 490 other metadata rows. Empty tables remained empty.
- New `authored_changes` and `accepted_conflicts` tables are empty. All historical
  `change_id` values are null: the migration invented no snapshot provenance.
- All 1,090 object paths and their exact bytes were preserved (35,629,683 bytes).
- SQLite integrity and foreign-key checks passed.
- The current Canopy build served the migrated copy on a dynamically allocated
  loopback port while retaining the real public origin. Its HTTP health endpoint
  completed the full retained-history/object integrity check with `status: ok`.
- Its public community descriptor returned the unchanged root and accepted update
  identity. Post-shutdown comparison again found no row or object changes beyond
  the intended schema migration.
- A final read-only live query confirmed schema 8 and 493 accepted updates.

## Client compatibility inventory

Both active Mac coordinator records and the active iPhone coordinator record had
no retained conflict, hold, pending head, attempted request or next-base override.
The phone reported `acceptedConflicted: false` and presentation `current`.
Historical recovery archives were left untouched. This checks persisted coordinator
state, not uncommitted editor memory or every historical recovery copy.

## Next live step

Coordinate the server deployment and migration separately. Preserve installed
snapshot-client compatibility; the storage rehearsal does not itself enable source
emission or prove every future client operation. Use a fresh backup if writes have
continued. Do not restore this older backup over later accepted work.
