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
`bunfig.toml` therefore excludes all of `migrations/` from default `bun test`
discovery, including the active migration. Run the migration being authored or
rehearsed explicitly with `bun run test:migration migrations/NNN-<name>`; that
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
   deployed image predates the migration and has no `migrations/` directory,
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
   timeout.

   ```sh
   railway volume files --volume resplendent-freedom-volume download /backups/<name>/volume.tar ~/arbor-migration-<date>/<name>/volume.tar --overwrite
   ```

   Check the sha256 against the one printed on the volume.
3. **Rehearse.** Run the migration's focused suite, restore two copies with
   `restore-canopy`, run the migration on one, and compare:

   ```sh
   bun run test:migration migrations/NNN-<name>
   bun run migrations/tools/restore-canopy.ts volume.tar before
   bun run migrations/tools/restore-canopy.ts volume.tar migrated
   bun run migrations/NNN-<name>/run.ts migrated | tee report.json
   bun run migrations/tools/compare-canopy-roots.ts before migrated
   ```

   Then serve the migrated copy with the new build and verify it. The server
   checks that its `--url` matches the community's canonical host, so pass the
   real public origin and listen locally:

   ```sh
   bun run canopyd migrated --url https://<public-domain> --port 4399 --hostname 127.0.0.1
   bun run migrations/tools/verify.ts http://127.0.0.1:4399 report.json --sync http://127.0.0.1:4317
   ```

   Record the result in the migration's README. Repeat until green.
4. **Snapshot the Mac.** With every placement `idle` in `GET /v1/trees`, write
   the authored manifest over every placement path and copy `~/.arbor`:

   ```sh
   bun run migrations/tools/authored-manifest.ts write authored-before.json <placement paths…>
   cp -a ~/.arbor dot-arbor.before
   ```
5. **Quiesce writers.** `bun run arbor daemon stop`; make sure Arbor is not
   running on the iPhone.
6. **Deploy once.** `railway up --detach -y`, then poll `railway deployment
   list` until the build succeeds (a few minutes). The new server finds the
   old schema stamp and serves maintenance mode by itself: health reports
   `maintenance`, every other route is 503, and ssh keeps working. No
   environment variable is involved.
7. **Migrate in place.**

   ```sh
   railway ssh -- bun run migrations/NNN-<name>/run.ts /data | tee live-report.json
   ```

   The report must match the rehearsal's roots exactly. The CLI prefixes its
   own notices to the output; `verify.ts` skips anything before the first `{`.
   Then `railway redeploy -y` and poll health until it is `ok`, about a
   minute.
8. **Bring the Mac back.** `bun run arbor daemon start`. If the migration
   changed any root, the daemon's private-state stamp makes it discard
   rebuildable state and re-place every tree from a snapshot; if roots are
   unchanged it only advances each placement to the restored update id.
   Placements should be idle within seconds. Then:

   ```sh
   bun run migrations/tools/verify.ts https://<public-domain> live-report.json --sync http://127.0.0.1:4317
   bun run migrations/tools/authored-manifest.ts write authored-after.json <placement paths…>
   bun run migrations/tools/authored-manifest.ts diff authored-before.json authored-after.json
   ```
9. **Round trip one edit.** Create a small file in a placed tree, watch the
   tree's `update` advance in `GET /.arbor/trees/{id}`, fetch its canonical
   page, delete the file, and see the page go away.
10. **iPhone last.** Update the app whenever convenient; an old build cannot
    sync against a server whose routes changed. A replica whose wire format
    changed is deleted and re-placed on launch.
11. **Close out.** Keep the archive, the local copies, and `dot-arbor.before`
    for two weeks, then delete them and this migration's directory. The
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

## Writing the next migration

Copy `001-if-match-and-model-hash/` as the template: a `README.md` with the
change, the exact order, and the rehearsal log; a `run.ts` that takes a data
root and is idempotent (it checks the schema stamp and refuses to run twice);
a `migrate.test.ts` runnable with
`bun run test:migration migrations/NNN-<name>`. Batch wire changes into one
migration whenever they are ready together.
