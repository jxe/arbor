# Migration 002 rehearsal

## Local synthetic rehearsal — 2026-09-02

- `bun run typecheck`: passed.
- `bun test migrations/002-collection-file-wire`: 2 passed, 0 failed, 23
  assertions.
- The fixture contains CSV, JSON, and JSONL collection directories below an
  ordinary ancestor, with pre-existing identical `schema.ts` entries.
- The positive case checks ancestor re-rooting, ordinary source reachability,
  exact source-hash reuse, one schema entry, schema stamp 4, restored history,
  current-server reopening, and refusal to rerun.
- The negative case checks that a conflicting existing schema entry aborts
  before changing the tree ref or schema stamp.

This is a migration-runner rehearsal against complete synthetic schema-3 data,
not evidence that the live volume has been inspected or changed.

## Live-volume rehearsal

### 2026-09-02

- Created `/data/backups/2026-09-02-collection-file-wire/volume.tar` while the
  schema-3 image remained healthy. The vacuumed database matched the live
  database on every checked row count: 9 trees, 11 accepted updates, 11
  observations, 11 reflog rows, 2 accounts, and 11 devices.
- Downloaded the archive to
  `/Users/joe/arbor-migration-2026-09-02/collection-file-wire/volume.tar`; its
  checksum matched the value produced on the volume.
- Restored independent `before` and `migrated` copies. Migration 002 advanced
  only the copy from schema 3 to 4. The live data contained no legacy
  collection-file directory: all 9 roots were unchanged, 0 objects were
  rewritten, 128 reachable objects were retained, and 2 history-only objects
  were pruned from the migrated copy.
- `compare-canopy-roots.ts` reported every root unchanged and completed with
  `OK`. A schema-4 server over the migrated copy passed `verify.ts` against all
  current public roots and the five idle Mac placements.
- With every Mac placement idle, wrote an authored manifest covering 111 files
  and copied the complete Arbor data home to `dot-arbor.before`. Do not deploy
  until the iPhone migration-001 closeout and quiescence gate is confirmed.

## Live cutover — 2026-09-02

- Confirmed the iPhone had completed migration 001 and was closed. The Mac had
  no pending/conflict journals before Arbor Sync stopped.
- Deployed the schema-4 build. It reported `maintenance` and returned 503 for
  ordinary routes while the volume still carried schema 3.
- Ran migration 002 against `/data`. Its parsed report exactly matched the
  rehearsal: 9 unchanged roots, 0 rewritten objects, 128 retained objects,
  and 2 pruned history-only objects. Redeployment reopened the volume at
  schema 4 with health `ok`.
- Restarted Arbor Sync. Its private-state version advanced from 2 to 3 and all
  five placements returned to idle. `verify.ts` passed against the live server
  and local daemon; the post-placement 111-file authored manifest had no
  changes from the pre-cutover manifest.
- Created a temporary Drift page. The tree advanced from accepted update 34 to
  41 and its canonical URL returned 200. Deleted it; the tree advanced to 42,
  the URL returned 404, and the placement returned to idle. A final authored
  manifest again reported no changes. Both resulting persisted transition
  payloads contain explicit `objects` and `deltas` arrays.
- Keep `/data/backups/2026-09-02-collection-file-wire/volume.tar` and
  `/Users/joe/arbor-migration-2026-09-02/collection-file-wire/` through at
  least 2026-09-16. The iPhone must install the migration-002 build and verify
  a format-3 replica re-placement before closeout.
