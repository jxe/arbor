# 008: Accepted conflict state

Offline schema 8 or 9 → 10 migration. Stop Canopy writers and retain verified database
and object backups. Rehearse on a copy before changing the offline database:

```sh
bun migrations/008-accepted-conflicts/run.ts --offline-database /path/to/canopy.sqlite3
bun run test:migration migrations/008-accepted-conflicts
```

Existing accepted history, receipts, observations and authored provenance are
unchanged. A new accepted-state conflict table starts empty. Schema 8 also gains
the empty authored-provenance table, so the deployed server can upgrade directly. Accepted change identities gain a tree-scoped uniqueness constraint. Existing
operation identities are backfilled; old snapshot identities are not guessed.
Unknown versions and
unresolved flags without retained decision evidence are refused. Table creation,
schema validation and stamp advancement form one transaction; schema 10 reruns
validate without rewriting state. See the [migration procedure](../README.md).

This is a server storage upgrade. Clients require no migration. Deployment and
live-data rehearsal remain pending. Do not roll back to a binary that discards
accepted alternatives; rollback requires the complete pre-upgrade backup.
