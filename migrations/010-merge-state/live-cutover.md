# Live schema-12 cutover — 2026-09-17

Canopy and the packaged merge process are deployed to `https://arb.nxhx.org` from
initial main revision `bc97d08d53d2d7e40bf542678873aef7bfef7e0b`. Railway deployment
`3e3fba5f-1f5a-4866-a88a-de67cbbf1964` built the Linux image successfully:
`sha256:7e2925ecdcb488d245b3e2382e8e877e27adcf72c6628b0d57beceb94e072773`.

## Preservation and migration

The user closed Native on Mac and iPhone. Arbor Sync was stopped, and its complete
local state and placed Console files were copied into the private backup directory.
All four retained Native source-admission records were already acknowledged. Native's
accepted Console root matched the server at update `2558`. The filesystem daemon
had a pre-existing `EDEADLK` read error and an older accepted revision; a subsequent
read-only manifest captured all 105 files without errors. Neither client state nor
placed source was reset.

Final volume archive:
`/Users/joe/arbor-schema12-cutover-20260917/volume.tar`, also retained remotely at
`/data/backups/arbor-schema12-cutover-20260917/volume.tar`.

- Size: 52,541,440 bytes.
- SHA-256: `f88b98a9eba234da6bdc6e53fdbcf03355305c77a5e83065cf1265165f037d2e`.
- 977 accepted updates; 2,254 verified immutable objects totaling 47,647,438 bytes.
- Both an untouched schema-11 restore and an independently migrated schema-12 copy
  remain alongside the archive.
- Rehearsal preserved every existing row, passed SQLite/foreign-key checks and an
  idempotent migration rerun, then exercised accepted ambiguity, restart/replay,
  guarded resolution and original-root cleanup. Its five test writes stayed local.

Railway started the new revision in schema-mismatch maintenance mode. With exactly
one active maintenance deployment, the live migration compared all 15 existing
tables against the backup, changed the schema to 12, and repeated that comparison.
Canopy's complete retained-history integrity check passed before service restart.
Old accepted identities, roots, receipts and object bytes were preserved.

At the user's request, the older `resplendent-freedom` service was disconnected
from automatic deployments and its deployment stopped. Its service and volume
remain intact; only `canopy-arb-nxhx-org` was migrated.

## Verification

The integrated main revision passed 960 product tests, TypeScript checking and the
shared Swift/TypeScript protocol gate, including live editor admission. The
repository-wide relative-link audit found no new failures; whitespace checks passed.

The first live source request exposed excessive cold-history staging: every checkpoint
was added to the candidate map and copied/fsynced again for all later jobs. The
operator's test request timed out after three minutes before source acceptance.
Railway deployment `655b9a86-008f-4410-9f34-3fe3b3f72291` installs
`8fa90ac04c306316105d840b9894da509675fcf6`, image
`sha256:fb14766db31a43e64f6f45ad81ec7088f2d095d38553e9107740678ec19fa049`.
The fix persists each checkpoint output directly
in the shared immutable store and leaves candidate inputs unchanged. It changes no
schema or Wire behavior. All 47 source-acceptance tests passed, including a regression
checking bounded checkpoint inputs and durable restart/replay. A new cold restore of
the same 977-update backup passed the entire write/restart/integrity rehearsal in
46.55 seconds locally.

The first fix alone was insufficient on Railway: its next cold source request reached
the platform's five-minute request limit. `f05e070` additionally reuses verified
shared inputs/outputs instead of staging duplicates, and existing immutable objects
complete directory durability without creating another identical temporary inode.
Corrupt bytes still fail validation. The full product suite passed 962 tests, and
all 27 process tests passed on Bun 1.3.14. Another untouched-backup rehearsal passed
all migration/write/restart/integrity checks with these changes.

Revision `6867ca6` batches up to 64 historical checkpoints, reuses their immutable
material, and verifies their combined dependency closure once. A 128 MiB generated
object limit triggers smaller batches against the same basis; invalid worker
responses still fail. Native Bun SHA-256 preserves the portable object identities.
The full product suite passed 966 tests, the Swift/TypeScript protocol gate passed,
and all 30 process/hash tests passed on Bun 1.3.14. A fresh production-backup
migration/write/restart/integrity rehearsal completed in 9.17 seconds locally,
compared with approximately 50 seconds before batching. No further schema change
was needed.

Railway deployment `08279eeb-eb01-40b2-8000-456c60f4ad43` installed `6867ca6`, image
`sha256:e10756daf611142aef636ed92bc38bb5ae42195ea819cf01e1065348e56ed8be`.
The first live source request completed in 123.69 seconds, establishing durable
semantic state at update `2560`. The competing source edit was accepted as `2561`
with one inspectable conflict; that check completed in 11.15 seconds. After a
service restart, exact replay, guarded resolution (`2562`) and cleanup (`2563`)
completed in 13.48 seconds. Cleanup restored the exact original root, with no
remaining conflict. All 977 original accepted rows still matched their pre-cutover
hash. These timings cover operator checks as well as submissions, not isolated
merge CPU time.

The serving authority's full integrity endpoint returned `ok`. All three installed
trees passed snapshot hash and conflict-inspection reads. Arbor Sync resumed idle
at Console update `2563`; all 105 placed files matched the restored original server
snapshot. Two files differed from the older pre-cutover filesystem backup because
the previously stalled daemon caught up to the already accepted server contents;
the backup remains intact. Native's saved local and accepted roots match that same
root, with no pending additions or conflict and source mode enabled. The user
reopened both Native apps, refreshed iPhone, and confirmed both work normally.
The cutover is complete; no client upgrade or additional schema migration was needed
for the cold-history fixes. Evidence is retained in
`/Users/joe/arbor-schema12-cutover-20260917/`.
