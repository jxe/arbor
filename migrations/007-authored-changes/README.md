# 007: Authored change retention

Offline schema 8 → 9 migration. Stop Canopy writers and retain a verified database
and object-store backup before running against a copy, then the offline database:

```sh
bun migrations/007-authored-changes/run.ts --offline-database /path/to/canopy.sqlite3
bun run test:migration migrations/007-authored-changes
```

This adds an empty private provenance table. Existing accepted history, identities,
observations, request receipts and objects are unchanged; no operations are inferred
from snapshots. Re-running on schema 9 validates the schema without changes.
Failure rolls back the table and stamp together. Use this migration with its
shipping source revision, following the [migration procedure](../README.md).

This is a server-only storage upgrade, with no client protocol change. Operation
submission remains disabled. Deployment and live rehearsal have not been performed.
Rollback requires restoring the complete pre-upgrade backup with the prior binary;
do not discard provenance after operation acceptance is eventually enabled.
