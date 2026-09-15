# Preserved-backup rehearsal — September 15, 2026

Preparation checkpoint only. No live installation, server migration or app restart
occurred. This rehearsal used the preserved September 14 backup, not current live
state.

## Evidence

Original backup: `/Users/joe/arbor-protocol-backup-20260914.sFnsIx`.
The verified `volume.tar` SHA-256 is
`5ac11d888cd763e35705e454cae89ec03aba161f772271c5f07bca2fc398ecd8`.
A fresh restore at `/Users/joe/arbor-cutover-006-pak0mzjn` was migrated with:

```sh
bun migrations/006-accepted-state-links/rehearse.ts --disposable-copy /Users/joe/arbor-cutover-006-pak0mzjn
```

The tool compared every pre-existing database field (excluding the schema version)
and all object paths/bytes before and after migration and local service reads.
All 70 accepted records, 70 observations, 5 trees and 250 stored objects were
preserved. The only schema additions are predecessor identity and conflict flags.
Integrity validation and loopback community descriptor/snapshot reads passed.
This does not claim authenticated HTTP coverage for every restored private tree.
The private report is `rehearsal-report.json` inside the disposable restore.

Read-only queue audits of `dot-arbor.before`, its `.state` directory, and
`phone.before` found 2, 3 and 1 records respectively, with no errors or blockers.
Their report is `client-preflight.json` in the disposable restore. These historical
queues do not establish that today's live queues are empty.

Native compatibility tests read both preserved `Native Placement.json` files,
validated adapted descriptors and checked that the original bytes were unchanged.
Legacy missing `conflicted` flags become false only in memory; explicit flags are
preserved, malformed values rejected, and network decoding remains strict. Visits
and singleton placement compatibility were tested with synthetic records; the
preserved backups had no visit cache. No pending/rejected request translation occurs.

## Verification

- CanopyClient: 11 tests passed with the preserved-backup check enabled through
  `ARBOR_SAVED_DESCRIPTOR_REHEARSAL`.
- macOS and iOS unsigned app builds passed using `Arbor.local.xcworkspace` and the
  local Quagmire override. No app was launched or installed.
- Type checking, both migration tests and the full protocol gate passed, including
  58 WorkingTree Swift tests.

## Remaining joint cutover gate

Audit current live synchronization and every pending/rejected queue, then take
fresh consistent backups. Prepare signed artifacts and coordinate Canopy, Mac,
iPhone and filesystem-client upgrades. Compare accepted identities, roots and exact
bytes, and verify offline/restart convergence before releasing rollback artifacts.
Follow the [migration procedure](README.md#rehearsal-and-live-gate); do not restore
an old backup over new writes. Subsequent capabilities follow server-first delivery.
