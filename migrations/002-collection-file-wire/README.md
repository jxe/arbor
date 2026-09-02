# 002: collection-file Wire descriptors

**Status:** implemented and locally rehearsed; live cutover has not run.

## What changes on disk

- Schema-3 directory entries that embed a legacy collection descriptor become
  ordinary `_store.csv`, `_store.json`, or `_store.jsonl` and `schema.ts` hash
  entries plus one directory-level `childrenSource` descriptor.
- `codec` becomes `format`, `schema` becomes `schemaFingerprint`, and the old
  child-set value called `modelHash` becomes `childSetHash`. The update setting
  `ifMatch: "modelHash"` is unrelated and remains unchanged.
- Every affected directory and ancestor gets a new Wire hash. Exact collection
  and schema file objects are reused byte-for-byte. Stable keys, logical child
  names, child properties, TreeIDs, accounts, devices, boundaries, and access
  rows do not change.
- Accepted history resets to one `restored` update per tree; observations and
  reflog rows reset. `meta.schema_version` advances from 3 to 4.

## Safety and order

Follow [the common procedure](../README.md#the-procedure). Migration 001 is
already running in deployed data and must not be edited, rerun, or folded into
this migration.

The runner refuses any source stamp other than 3, refuses to run twice, checks
that the build expects target stamp 4, verifies a migration-only logical
fingerprint before writing refs, stores new objects before its database
transaction, verifies every reachable new graph, and reports only tree IDs and
roots. It stops on multiple legacy descriptors, conflicting source/schema
entries, mixed immediate-child backings, or malformed legacy fields.

Before live deployment:

1. Confirm every relevant client finished migration-001 closeout.
2. Back up and download the live volume using the common procedure.
3. Restore `before` and `migrated` copies, run this migration on `migrated`,
   compare logical roots, serve the copy, and run `verify.ts`.
4. Record live-volume counts, root comparison, served verification, and an
   authored-manifest comparison in [rehearsal.md](rehearsal.md).
5. Quiesce Mac and iPhone writers before deploying and running against `/data`.

Rollback uses the schema-3 archive and previous image. After local clients
re-place, also restore the saved local Arbor data home. Keep backups for two
weeks; deleting backups and this migration directory is a person-owned step.
