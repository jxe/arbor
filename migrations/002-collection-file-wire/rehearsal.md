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

Not run. Do not perform the live cutover until the archive restore, root
comparison, served verification, and authored-manifest checks in the runbook
are recorded here.
