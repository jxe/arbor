# Migrations

A migration is a one-off. It carries one wire-format or schema change from the
current deployment to the next, is rehearsed on copies until its verification
passes, runs once against real data, and is then deleted. Nothing under
`packages/` imports from this directory, and the `arbor` command never grows
a migration subcommand.

Two things live here:

- `tools/`: the small reusable scripts every migration uses: backup, restore,
  compare two data roots, snapshot authored files, and verify a cutover.
- one directory per migration, `NNN-<name>/`, holding its runbook, its
  migration script, its test, and its rehearsal report. Delete the directory
  when the cutover is verified on every host and its backups have aged out.

## The procedure

Joe is the only user, so the writers are quiesced, not the server. The Canopy
keeps serving reads throughout, and no maintenance mode or environment
variable toggle is needed.

1. **Rehearse.** Download one backup archive (step 3 below, run against the
   live volume over `railway ssh`), restore it locally, run the migration
   against the copy, run `compare-canopy-roots` and `verify --report`, and
   record the result in the migration's README. Repeat until green. This is
   where the time should go.
2. **Quiesce writers.** `arbor daemon stop` on the Mac after `GET /v1/trees`
   shows every placement `idle`; close Arbor on the iPhone. Nothing else
   writes.
3. **Back up as one archive.** Over `railway ssh`, in the running container:
   `bun run migrations/tools/backup-canopy.ts /data /data/backups/<name>.tar`.
   This is `VACUUM INTO` for the database plus a tar of `objects/`. Download
   that one file with `railway volume` or `scp`; never the object tree file
   by file.
4. **Deploy once.** The image built from the migration commit contains both
   the new server and `migrations/`. Deploy it. The server starts, asserts its
   schema stamp against the volume, and refuses to serve until migrated; that
   is expected and brief.
5. **Migrate in place.** Over `railway ssh`:
   `bun run migrations/NNN-<name>/run.ts /data`. The script writes new objects
   first, rewrites the SQLite database in one transaction, stamps the new
   schema version, and prints a report of tree ids and roots only, never
   digests or tokens. Restart the service once.
6. **Bring the Mac back.** Install the build and `arbor daemon start`. The
   daemon sees a schema stamp older than its own, discards its rebuildable
   state, and re-places every tree from a snapshot; authored files are
   compared byte for byte and rewritten only if they differ.
7. **Verify.** `bun run migrations/tools/verify.ts <origin> <report.json>`
   checks health, every public tree's ref against the report, every local
   placement idle, and the authored manifest unchanged. Then make one edit on
   the Mac and see it at the canonical URL.
8. **iPhone last.** Update the app whenever convenient. A replica whose wire
   format changed is deleted and re-placed on launch.
9. **Close out.** Keep the archive and the pre-migration `~/.arbor` copy for
   two weeks. Then delete them and this migration's directory.

Rollback before step 6 is `restore-canopy` from the archive and redeploying
the previous image. After step 6 it also means restoring `~/.arbor` from its
copy.

## Railway facts that outlive any migration

- `railway scale` does not stop a service; it is not needed under this
  procedure, and stopping is `railway down`, which only a person may run.
- Volume commands need a running deployment; `railway ssh` gives a shell in
  the running container with `bun` available.
- Uploading a directory onto an existing remote directory nests it. Prefer one
  archive and `restore-canopy`.
- Agents are refused deletes on Railway; deletion steps are for a person.
- Never put credentials, digests, or content in a report or shell history.

## Writing the next migration

Copy `001-if-match-and-model-hash/` as the template: a `README.md` with the
change, the exact order, and the rehearsal log; a `run.ts` that takes a data
root and is idempotent (it checks the schema stamp and refuses to run twice);
a `migrate.test.ts` runnable with `bun test migrations/NNN-<name>`. Batch wire
changes into one migration whenever they are ready together.
