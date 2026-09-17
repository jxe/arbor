# Schema 8 → 11 live server cutover — September 17, 2026

Canopy at `https://arb.nxhx.org` now runs source revision `38abbf1` with schema 11.
Railway service `canopy-arb-nxhx-org` reports deployment
`7e71fb4c-b565-4985-84cf-023272b51df7` successful. This was a server-only
upgrade: installed clients remain unchanged and snapshot-only. Client source
emission and retirement of Native's legacy conflict machinery remain future work.

## Recovery evidence

Private local evidence is retained at
`/Users/joe/arbor-live-schema11-20260917-47aearbm/`; remote originals are at
`/data/backups/arbor-live-schema11-20260917-47aearbm/` on the service volume.
The self-contained final rollback archive is `final-volume.tar.gz`, SHA-256:

`563b354e98f8fdfe4c722d9a34f28e3b1a044ea81435620b3c35ea26e1b45168`

It contains the final schema 8 database and verified immutable objects. The final
SQLite backup (`final.sqlite3`) has SHA-256:

`3c06c740080b1be331a961209c73b0576bb9b911f2f06d4822ca4b9699192fb8`

The original volume archive download was retried after a deployment interrupted
transport; its completed checksum matched. An initial pre-migration comparison
refused to proceed because a device's `last_used_at` changed after backup. Exact
table comparison confirmed that was the only change. The final SQLite snapshot
was then captured and checked before migration. No history was overwritten.

Mac private state is copied in `dot-arbor.before`; consistent SQLite backups made
after stopping the LaunchAgent are in `mac-sqlite-quiesced`. The prior
[rehearsal](rehearsal.md) contains the phone coordinator inventory and copy.
Rollback requires the complete backup and matching old server binary, and must
account for accepted work since this backup; do not blindly restore over later work.

## Verification

- User closed Mac and iPhone apps. Arbor Sync's LaunchAgent was unloaded to keep
  writers quiet, then restored after server checks.
- Every old table row and column was preserved exactly, excluding the schema stamp:
  493 accepted updates and observations survived. Migration rerun was a no-op.
- All 1,090 pre-upgrade objects (35,629,683 bytes) matched the backup exactly.
- SQLite integrity and foreign-key checks passed. New conflict/provenance tables
  were empty; migration invented no historical source intent.
- Deployed migration, schema and Canopy source hashes matched the local revision.
- Full retained-history/object integrity passed directly on the server across all
  five trees. The HTTP health request hit a Railway proxy timeout; the direct
  check bypassed that timeout and completed successfully.
- All three active placement descriptors and snapshot roots matched pre-upgrade
  state before the smoke write.
- A temporary snapshot-only write was accepted as update `2075`; an uncertain
  timeout was retried with the exact same request identity and returned the same
  accepted update. Cleanup was accepted as `2076` and restored the exact original
  root. No temporary file remains.
- Restored Arbor Sync reached update `2076` for Console; all three placements
  reported idle and not conflicted. A pre-cutover filesystem `EDEADLK` error cleared
  after restoration; its cause was not established by this deployment.

The user confirmed Mac and iPhone both load normally after reopening and phone refresh. No new client
binary, source-operation emission or live conflict experiment was introduced.
