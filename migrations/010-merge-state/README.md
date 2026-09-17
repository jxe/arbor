# Schema 11 to 12: accepted merge-state ownership

This additive offline migration creates `accepted_merge_states`. Existing accepted
IDs, roots, receipts, observations, source evidence, conflicts and object bytes are
unchanged. No client state or Wire migration is needed. The server and merge package
must ship together. This worktree has not been deployed.

## Procedure

1. Prepare the server artifact and verify its production dependencies include the
   merge package, parsers and WASM files. Pause writers and take a fresh complete
   volume backup before touching the live database.
2. With Canopy stopped and no other volume writer, run:

   ```sh
   bun migrations/010-merge-state/run.ts --offline-database /data/canopy.sqlite3
   ```

   The migration requires the exact schema-11 source shape, validates SQLite, and
   creates the table/stamp in one immediate transaction. A schema-12 rerun validates
   the shape and changes nothing. It refuses other source versions.
3. Start the new Canopy with its merge executable. Verify integrity and unchanged
   pre-cutover accepted roots, then allow writers and check source and snapshot
   acceptance, conflict inspection, exact retry and restart.
4. Before accepting new writes, rollback may restore the backup and previous server.
   After new writes, restoring the old backup would lose accepted work: retain the
   new volume and recover forward, or explicitly preserve/replay every later update.

Run migration tests using:

```sh
bun run test:migration migrations/010-merge-state
```

## September 17 rehearsal

The archive `~/arbor-snapshot-acceptance-20260917-6xhgm4jv/volume.tar` was restored
into `~/arbor-merge-rehearsal-20260917-MggCgA`. The archive and live service were
untouched. The restored schema-11 database contained 576 accepted updates.

Before migration, every row of all 15 existing tables was fingerprinted (excluding
only the schema stamp). After migration every fingerprint and row count matched;
the new table was empty and SQLite integrity passed. Canopy's full retained-object
integrity check also passed. `before-rows.json` in that private rehearsal directory
contains hashes/counts only, not row contents or credentials.

The write rehearsal is reproducible on such a prepared restored copy:

```sh
bun migrations/010-merge-state/rehearse.ts /path/to/restored-copy
```

It opens no network listener, requires the rehearsal audit marker, adds a temporary
file, submits competing source edits, checks accepted ambiguity, restarts, replays,
resolves through guards and restores the original root. It checks all old accepted
rows for exact equality and reruns integrity. Never point it at a live volume.

The write rehearsal passed with 581 accepted rows after five temporary updates,
576 unchanged historical rows, accepted conflict, restart replay, guarded resolution,
exact original-root cleanup and full integrity. No live client or service was used.

A subsequent [fresh Railway rehearsal](fresh-rehearsal.md) fetched a new backup
containing 590 accepted updates and 1,288 objects. Migration, idempotence, exact
historical preservation, source writes, restart/replay, resolution and integrity
all passed on the local copy; production remained on schema 11.
