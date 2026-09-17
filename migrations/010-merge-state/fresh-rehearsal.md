# Fresh Railway schema-12 rehearsal — September 17, 2026

A new online backup was fetched from Railway service `canopy-arb-nxhx-org`
(`https://arb.nxhx.org`) and rehearsed locally with worktree revision `04cc363`
and Bun 1.3.14. The live service was neither migrated nor restarted.
At capture it ran deployment `ad235392-4201-4fcf-8378-f6a8530eddda`, source
`1db70451b021d9c383208de111daf299dda8f66d`.

## Backup and preservation

The deployed backup helper used SQLite `VACUUM INTO` followed by an archive of
immutable objects. The archive is retained at:

- Railway: `/data/backups/arbor-schema12-fresh-20260917-g3iu23f2/volume.tar`
- Local: `~/arbor-schema12-fresh-20260917-g3iu23f2/volume.tar`

The remote and downloaded SHA-256 matched:
`3a97e56b27d257939131739890bc4cc632b42784b4c9e8febbe016755a62e2fb`.
The archive is 43,202,560 bytes. Independent `before/` and `migrated/` restores
are retained beside it; the original archive and `before/` copy remain unchanged.

## Results

- Source schema 11 migrated to schema 12; an immediate rerun was a no-op.
- All 15 existing tables retained exactly the same rows, excluding only the schema
  stamp. This includes 590 accepted updates, receipts and observations.
- The newly created `accepted_merge_states` table was empty immediately after migration.
- SQLite integrity and foreign-key checks passed.
- All 1,288 immutable object files matched their address hashes and were identical
  between the two restores: 40,613,458 bytes of objects.
- The [write rehearsal](rehearse.ts) passed source conflict acceptance, restart,
  exact receipt replay, guarded resolution, cleanup to the original root, and full
  Canopy retained-object integrity.
- After five temporary accepted updates, the local rehearsal had 595 accepted rows;
  every one of the original 590 accepted rows was still exactly unchanged.

Private local evidence files are `migration-report.json`, `migration.log`,
`before-rows.json` and `write-rehearsal.log` in the backup directory. The audit
contains hashes/counts rather than row contents or credentials.

This verifies the migration against freshly fetched production data. A live cutover
still requires a new final backup and the [offline deployment procedure](README.md).
