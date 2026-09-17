# 009: Nested conflict locations

Offline schema 8, 9 or 10 → 11 migration. This is a server storage change, not a
Wire or client migration. The [fresh live-copy rehearsal](rehearsal.md) passed;
it has not been deployed or run against the live database.
Follow the [migration procedure](../README.md): back up the database and objects,
stop writers, rehearse on a copy, and compare history and object inventories.

```sh
bun migrations/009-nested-conflict-locations/run.ts --offline-database /copy/canopy.sqlite3
bun run test:migration migrations/009-nested-conflict-locations
```

Schema 11 permits an optional physical `parent` segment array in stored entry
decisions. Historical decisions without it remain at the root. Existing schema 10
rows, receipts, identities, source evidence and observations are not rewritten.
The new stamp prevents an old binary from treating a nested decision as a root
entry. Schema 8/9 upgrades include the previously prepared provenance/conflict
storage additions, preserving accepted history rather than resetting it.

Schema validation and stamp advancement are transactional. Unknown versions and
incomplete schemas are refused. Schema 11 reruns validate without rewriting data.
Root and alternative object hashes, object dependencies, and physical object
storage remain unchanged; this does not implement packing or pruning.

Rollback requires the complete pre-upgrade backup and its matching binary.
Never run a schema 10 writer against nested conflict data. The old migration 008
is retained as historical preparation, not retargeted to schema 11.
