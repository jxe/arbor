# Migration 005: raw file objects and typed directory entries

This is an offline schema-6-to-7 migration. It preserves current file bytes,
empty directories, nested TreeIDs, account identities, policies, and placements.
It resets accepted history to one `restored` update per tree, clears observations
and reflog history, and prunes objects outside current trees. Detailed conflict
storage is not introduced by this migration.

## Gate

Joe authorized a history reset only with synchronized clients. Before live use,
prove all clients (including the phone) have no unpublished edits, admissions,
pending requests, or unresolved conflict evidence. Compare exact materialized
content and boundaries with Canopy. Pause writers and retain verified backups of
Canopy, all local state, and authored files. An old or absent client must
rebootstrap before publishing; preserve its previous state for recovery.

## Rehearsal and cutover

Use the backup/download/restore procedures in [the migration guide](../README.md).
Those tools handle archive transfer; do not use the old generic root-comparison
script for this format, because its decoder belongs to an earlier format.
`run.ts` compares legacy and new manifests internally before changing roots.

```sh
bun run test:migration migrations/005-file-bytes-are-the-object
bun migrations/tools/restore-canopy.ts volume.tar before
bun migrations/tools/restore-canopy.ts volume.tar migrated
bun migrations/005-file-bytes-are-the-object/run.ts migrated --writers-quiesced > report.json
```

Serve the migrated copy with the new build, the existing canonical public origin,
and a disposable loopback port. Check integrity, authenticate, retrieve a complete
snapshot of each tree, and compare it to the migration report. Repeat from a
second restored copy and require identical new roots. Compare the current Mac
placements without using the object index:

```sh
bun migrations/005-file-bytes-are-the-object/check-local.ts local-descriptors.json report.json
```

`local-descriptors.json` is the snapshot array returned by `GET /v1/trees`.
The check includes physical and canonical tree boundaries and refuses a root
mismatch. Collection descriptors need their provider callback if collections
are present; this checker fails safely on an unmatched collection root.

Record evidence in
[rehearsal.md](rehearsal.md).

After the synchronized-client gate and successful rehearsal, deploy the new build
(the old schema enters maintenance), run the same command against the offline
live data root, and restart Canopy. Require the same roots as rehearsal.

The daemon's private-state format is 5. On restart it archives refs and journals
under `.state/format-recovery/`, clears rebuildable indexes, and compares current
filesystem trees to Canopy before adopting new accepted state. Native direct
replicas use working-tree format 5, archiving their old working tree and sync
state under `FormatRecovery/` before fetching a fresh placement. No separate
local migration command is needed; do not launch either new client before the
Canopy cutover and synchronized-client gate.

Verify every placement is idle at its reported new root, exact authored manifests
are unchanged, and Mac and phone can round-trip an edit. Retain the archive and
local recovery copies through the rollback window. Before allowing new writes,
rollback means restoring both old Canopy storage/build and old client state/build.
After new writes, reconcile those writes before restoring old state.

The runner is restart-safe: schema 7 verifies current graphs and prunes residual
objects without resetting accepted history again. All new graph bytes are stored
and validated before the SQLite transaction switches roots. The report contains
identifiers, roots, and counts only.
