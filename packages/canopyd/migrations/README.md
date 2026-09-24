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

Migration tests are lifecycle checks, not part of the product test suite.
`bunfig.toml` therefore excludes all of `packages/canopyd/migrations/` from default `bun test`
discovery, including the active migration. Run the migration being authored or
rehearsed explicitly with `bun run test:migration packages/canopyd/migrations/NNN-<name>`; that
command overrides the default discovery exclusion for the requested path while
retaining the repository's normal test preload.

A completed migration is immutable while it is retained for rollback. Its test
may only run with the revision and schema it shipped against. Never retarget old
code to a newer schema merely to make it pass current discovery; delete the
whole migration directory after its rollback window closes.

## The procedure

Joe is the only user, so the writers are quiesced, not the server. Every
`railway` command below must run from the linked repository directory (a
`cd` elsewhere loses the project link). The whole live portion takes about
fifteen minutes; the rehearsal is where the time should go.

1. **Back up as one archive, while the old image is still running.** The
   deployed image predates the migration and has no `packages/canopyd/migrations/` directory,
   so the backup is an inline command over ssh: `VACUUM INTO` for the database
   plus a tar of `objects/`.

   ```sh
   railway ssh -- sh -c 'set -e; D=/data/backups/<name>; mkdir -p $D; bun -e "const {Database}=require(\"bun:sqlite\"); const db=new Database(\"/data/canopy.sqlite3\",{readonly:true}); db.run(\"VACUUM INTO \x27$D/canopy.sqlite3\x27\"); db.close()"; tar -cf $D/volume.tar -C $D canopy.sqlite3 -C /data objects; sha256sum $D/volume.tar'
   ```

   Compare row counts between the live database and the vacuumed copy before
   trusting it (the copy is much smaller because it has no free pages).
2. **Download the archive.** `railway ssh -- cat` does not stream binary, and
   `base64` in the container lacks `-w`. Use the volume command, from the repo
   directory, with the mount-relative path, and run it in the background: it
   takes about ten minutes for 100 MB and is silently cut off by a foreground
   timeout. A deploy or restart also cuts it off, so let it finish before
   step 6. Local copies live in the repository's ignored `.backups/railway/`,
   one directory per backup named by its UTC time, with a `source.txt` naming
   the migration:

   ```sh
   railway volume files --volume canopy-arb-nxhx-org-volume download /backups/<name>/volume.tar .backups/railway/<YYYYMMDDTHHMMSSZ>/volume.tar --overwrite
   ```

   Check the sha256 against the one printed on the volume.
3. **Rehearse.** Run the migration's focused suite, restore two copies with
   `restore-canopy`, run the migration on one, and compare:

   ```sh
   bun run test:migration packages/canopyd/migrations/NNN-<name>
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
   bun run packages/canopyd/migrations/NNN-<name>/run.ts migrated | tee report.json
   bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
   ```

   Then serve the migrated copy with the new build and verify it. The server
   checks that its `--url` matches the community's canonical host, so pass the
   real public origin and listen locally:

   ```sh
   bun run canopyd migrated --url https://<public-domain> --port 4399 --hostname 127.0.0.1
   bun run packages/canopyd/migrations/tools/verify.ts http://127.0.0.1:4399 report.json --sync http://127.0.0.1:4317
   ```

   Record the result in the migration's README. Repeat until green.
4. **Snapshot the Mac.** With every placement `idle` in `GET /v1/trees`, write
   the authored manifest over every placement path and copy `~/.arbor`:

   ```sh
   bun run packages/canopyd/migrations/tools/authored-manifest.ts write authored-before.json <placement paths…>
   cp -a ~/.arbor dot-arbor.before
   ```
5. **Quiesce writers.** `bun run arbor daemon stop`; make sure Canopy is not
   running on the iPhone.
6. **Deploy once.** The service builds from GitHub `main`: push the verified
   revision, then poll `railway deployment list` until the build succeeds (a few
   minutes). `railway up` uploads are not configured for this service and fail. The new server finds the
   old schema stamp and serves maintenance mode by itself: health reports
   `maintenance`, every other route is 503, and ssh keeps working. No
   environment variable is involved.
7. **Migrate in place.**

   ```sh
   railway ssh -- bun run packages/canopyd/migrations/NNN-<name>/run.ts /data | tee live-report.json
   ```

   The report must match the rehearsal's roots exactly. The CLI prefixes its
   own notices to the output; `verify.ts` skips anything before the first `{`.
   Then `railway redeploy --from-source -y` (a plain `redeploy` rebuilds the
   latest deployment, which may be a failed one) and poll `/` or a tree route
   until it serves, about a minute. Never poll `/.arbor/health`: it is a full
   audit and repeated calls exhaust the server's memory.
8. **Bring the Mac back.** `bun run arbor daemon start`. If the migration
   changed any root, the daemon's private-state stamp makes it discard
   rebuildable state and re-place every tree from a snapshot; if roots are
   unchanged it only advances each placement to the restored update id.
   Placements should be idle within seconds. Then:

   ```sh
   bun run packages/canopyd/migrations/tools/verify.ts https://<public-domain> live-report.json --sync http://127.0.0.1:4317
   bun run packages/canopyd/migrations/tools/authored-manifest.ts write authored-after.json <placement paths…>
   bun run packages/canopyd/migrations/tools/authored-manifest.ts diff authored-before.json authored-after.json
   ```
9. **Round trip one edit.** Create a small file in a placed tree, watch the
   tree's `update` advance in `GET /.arbor/trees/{id}`, fetch its canonical
   page, delete the file, and see the page go away.
10. **iPhone last.** Update the app whenever convenient; an old build cannot
    sync against a server whose routes changed. A replica whose Overstory format
    changed is deleted and re-placed on launch.
11. **Close out.** Keep the backup directory under `.backups/railway/` (the
    archive, the rehearsal copies, and `dot-arbor.before`) for two weeks, then
    delete it and this migration's directory. The
    backup directory on the volume is deleted by a person.

Rollback before step 8 is `restore-canopy` from the archive onto the volume
and `railway redeploy` of the previous deployment. After step 8 it also means
restoring `~/.arbor` from its copy.

Do not let anything write the private-state stamp early: a test that touches
the real `~/.arbor` before the cutover stamps it and the re-place in step 8
will not fire.

## Railway facts that outlive any migration

- Every `railway` command needs the linked repository as its working
  directory; from anywhere else it reports no linked project.
- `railway scale` does not stop a service; it is not needed under this
  procedure, and stopping is `railway down`, which only a person may run.
- Volume commands need a running deployment; `railway ssh -- <command>` gives
  a shell in the running container with `bun` and `tar` available, streams
  text but not binary, and prefixes its own notices to the output.
- `railway volume files --volume <name> download <mount-relative> <local>` is
  the way to fetch a file; it is slow, so background it.
- Uploading a directory onto an existing remote directory nests it. Prefer one
  archive and `restore-canopy`.
- Agents are refused deletes on Railway; deletion steps are for a person.
- Never put credentials, digests, or content in a report or shell history.

## Schema history

canopyd stamps its SQLite schema version and refuses to serve a newer stamp
than it understands. The stamps that have shipped:

| Schema | Change |
|---|---|
| 8 | Accepted records store predecessor IDs and unresolved flags; retention may remove a predecessor without changing its successor's link. |
| 9 | `authored_changes`: exact operations and evidence stored atomically with the accepted record, ref, and observation; owning accepted records protected by a foreign key; basis and candidate roots are explicit retention dependencies. Compaction must keep those graphs and the operation records together. |
| 10 | `accepted_conflicts`: competing entries retained as whole-entry choices. |
| 11 | Optional physical parent path on the private entry encoding; missing parents keep the historical root meaning. |
| 12 | `accepted_merge_states`, owned by the accepted update ID: accepted and authored state hashes, public inspections, the complete immutable dependency closure, original intent and validation evidence. The accepted row, inspection ownership, and transition commit in one transaction; objects are hash-verified and durably stored first; schema-11 records stay readable. |
| 13 | Resource policy: governed rule index persisted in the accepted transaction, plus a durable account format marker (set by migration 011 even for all-private configurations) that rejects old privilege writes after conversion. Required matching Mac and iPhone clients. |
| 14 | Operation frames: authored changes carry `trace` frames (migration 012). |
| 15 | Compact merge evidence and v3 merge states (migration 013). |
| 16 | `entry_metadata` (per file entry: last accepted change) and `document_versions` (per Markdown document: accepted content versions), both written inside the accepted transaction and backfilled by replaying accepted history (migration 014). No wire change is required of clients; the new `entry-metadata` read is additive. |
| 17 | One accepted history (migration 015): `observations` folds into `accepted_updates.ordinal` (the `INTEGER PRIMARY KEY AUTOINCREMENT` cursor; every accepted update keeps its old cursor, legacy status cursors resync); `reflog` is dropped; `authored_changes` keeps only the trace and evidence beside its `accepted_id`; `accepted_updates_tree` and `accepted_updates_root` are schema indexes; the unread `accounts.token_digest` is dropped (authentication reads device digests only). No wire change. |

Client-side formats have their own ladders, recorded in [the local system
reference](../../../docs/architecture/arborsync/data-home.md): iOS working-tree format marker 4, local
update-control schema 3 (source mode), and admission journal schemas 2 to 4.

## Writing the next migration

Copy the most recent migration directory (today `015-compact-history/`; `016-resource-policy-only/`
is a read-only pre-deploy check, not a migration) as the template: a `README.md` with the
change, the exact order, and the rehearsal log; a `run.ts` that takes a data
root and is idempotent (it checks the schema stamp and refuses to run twice);
a `migrate.test.ts` runnable with
`bun run test:migration packages/canopyd/migrations/NNN-<name>`. Batch wire changes into one
migration whenever they are ready together.
