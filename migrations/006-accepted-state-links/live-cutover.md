# Live accepted-state cutover — September 15, 2026

The single coordinated foundational cutover completed with Joe. Source revision
`09f83bb` was fast-forwarded to local main and deployed to Canopy; signed macOS
and physical-iPhone apps and the source-backed filesystem daemon use that revision.
No GitHub push occurred. Quagmire used clean local revision
`f61c959395e2be9f5b8678399c382b5e8d577b54`; published pins were unchanged.
Railway deployment `ccfec62e-e4cb-40c5-b9cc-f33a667b6db9` serves schema 8.

## Preservation and verification

Fresh backups and private evidence are at
`/Users/joe/arbor-cutover-20260915-0xwqlsvv/`. The server archive SHA-256 is
`fb30b8df251a2bf04c31cc582a215b76e943e7cdfff196a0ab61ad276aa86100`.
Mac copies match all 10,351 support-data files and 105 external-placement files;
SQLite integrity checks pass. The phone copy has 493 files matching its device
inventory, with a retained local SHA-256 manifest. Old Mac binaries are preserved.

The fresh archive rehearsal and live migration preserve all 276 accepted records,
observations, pre-existing accepted fields and 664 object paths/bytes. All other
tables match except two device `last_used_at` fields advanced by final authenticated
reads before deployment; exact field comparison confirmed no other differences.
The full live integrity endpoint returned `status: ok`. Its retained-history scan
took longer than initial short request timeouts; normal reads worked throughout.

After startup, authenticated descriptors/snapshots matched all three filesystem
placements and all 108 authored files. A temporary note was accepted as update
1858 with predecessor identity/root and explicit `conflicted: false`. Exact request
replay returned the same receipt without another update. Both native devices
adopted it. Filesystem removal was accepted as 1859, restoring the exact pre-test
root and every authored file hash. Phone accepted/materialized state reached 1859;
Mac native and daemon queues were clear. Joe restarted both apps and reported no
errors. Both apps and arborsync remain running.

## Discovered issue and remaining observation

Preflight found an unsent Mac Native head despite a presentation describing its
previous successful merge. Joe confirmed its intended edits. The exact saved and
filesystem versions were preserved; normal UI Sync Now accepted the intended bytes
as 1857 and cleared the record. No recovery record was manually changed or deleted.
The phone also needed Sync Now to catch up before shutdown; Joe subsequently
clarified that this was expected background suspension, not a phone sync defect.
The Mac automatic-progress cause is not established; [Reliability 012](../../plans/reliability/012-native-sync-progress.md)
owns reproduction and correction.

Live restart and round-trip checks passed. Longer ordinary-use/offline observation
remains; disposable offline/restart regression coverage passed before installation.
Keep all rollback artifacts during that observation. After new writes, reconcile
those writes before considering any restoration. Further operation/merge/review
capabilities follow server-first delivery without capability advertisement.
