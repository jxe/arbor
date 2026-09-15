# Accepted-state links: one foundational cutover

Status: PREPARATION ONLY. Schema 7 → 8. No live data has been migrated.
Coordinate the live client/server upgrade with Joe after the remaining client
compatibility gates in [Reliability 011](../../plans/reliability/011-compatible-accepted-ambiguity.md).

## What changes

Add `accepted_updates.previous_id` and `conflicted`. Backfill predecessor identity
from retained per-tree insertion order, checking its root against `previous_root`.
Existing schema-7 accepted states are resolved; initialize the signal to false.
Preserve accepted IDs, roots, timestamps, subjects, request digests, observations,
transition bytes, private merge provenance and the entire object store. Once links
are stored, pruning a predecessor cannot change the identity of its successor.
Incomplete legacy chains fail before any schema change; restore complete history
instead of inventing a predecessor from equal bytes. This backfill assumes the
schema-7 history is complete; a root check cannot prove that no same-root record
was previously deleted. Verify retention history as part of rehearsal.

The new binary refuses a schema-7 database. No startup conversion or history reset
is provided. Re-running this migration on schema 8 validates the schema and does
nothing. Old binaries cannot safely open the new schema.

## Rehearsal and live gate

1. Inventory every filesystem/native queue, including rejected requests and saved
   conflict responses. Settle old-format requests with their original build and
   bytes. Preserve unresolved recovery work; do not translate or silently discard it.
2. Follow the [backup procedure](../README.md#the-procedure). Preserve a consistent
   database and complete objects together. Stop writers while migrating.
3. Restore a disposable copy and run:

   ```sh
   bun run test:migration migrations/006-accepted-state-links
   bun migrations/006-accepted-state-links/run.ts --offline-database /absolute/copy/canopy.sqlite3
   ```

4. Compare all pre-existing accepted-record fields and observation rows exactly,
   plus tree refs, object inventory and authored file bytes. Serve only the copy
   with the new build and run the protocol/client convergence gates.
5. Finish client disk-format rehearsal: native saved placement/visit descriptors
   from the installed build may omit the now-required `conflicted` field. These
   caches need an explicit disk upgrade or refresh path before installation. Audit
   durable rejected responses as well. The server migration does not alter them.
6. Only after those gates, coordinate backups, upgrades and verification on the
   Mac, iPhone, filesystem daemon and Canopy. Retain rollback artifacts until exact
   state/byte comparisons and continued offline/restart syncing pass.

Rollback before new writes restores the matching old binaries and complete backup.
After new writes, preserve and reconcile those writes before any restoration; never
replace newer accepted state with an old backup as an automatic fallback.

## Verification so far

Two disposable SQLite tests pass: exact history/provenance preservation with
same-root links and idempotent rerun, and transactional refusal of incomplete old
history. A migrated successor retains its predecessor identity after the predecessor
is pruned. This is a synthetic migration rehearsal, not a live-backup rehearsal.
