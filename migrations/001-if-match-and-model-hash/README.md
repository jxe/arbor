# 001: `ifMatch`, merge rules, `modelHash`, and `_index.md` precedence

**Status:** run on 2026-09-02 against the Railway volume and the Mac. Delete this directory
once the backups named below have aged out (about 2026-09-16) and the iPhone has been
updated.

## What changes on disk

- Every wire directory object that carries a rollup entry: the field `modelHash` becomes
  `modelHash`. That changes the object's bytes and hash, so every ancestor directory object
  and every affected tree's root changes too. The migration re-encodes those objects, rewrites
  each affected tree's ref and its single restored accepted update, and deletes the old
  objects.
- Accepted history resets to one `restored` update per tree, so watch cursors restart; the
  observation log and reflog are cleared with it.
- `meta.schema_version` advances from 2 to 3. Canopy refuses to serve a version-2 root, and
  arborsync's private-state stamp (`.state/version`) makes the Mac discard its rebuildable
  state and re-place every tree on first start.
- No account, device, boundary, or access row changes. No authored file changes.

## Order

Follow [the procedure](../README.md#the-procedure). Specific to this migration:

- Rehearsal must show `compare-canopy-roots` equal after decoding (model-equivalent trees,
  different roots for rollup-bearing trees only) and `verify` green against the local server.
- The Mac daemon's re-place is exercised by the private-state stamp; confirm authored files
  are untouched with `authored-manifest diff`. Every placement must be idle before the daemon
  is stopped, since pending sync journals are discarded.
- The iPhone's rollup-bearing replicas are deleted and re-placed on launch (commit `ac695b4`).

## Rehearsal log

- 2026-09-02, archive `/data/backups/2026-09-02-if-match/volume.tar` (sha256 7286…74f, 92.7 MB),
  downloaded with `railway volume files --volume resplendent-freedom-volume download`, which
  takes about ten minutes; `railway ssh -- cat` does not stream binary. The vacuumed database
  matched the live one on every row count (9 trees, 20 updates, 2 accounts, 11 devices).
- Migration on the copy: no tree carries a rollup, so 0 objects rewritten and all 9 roots
  unchanged; 128 objects retained, 2,347 history-only objects pruned; stamp 3.
- `compare-canopy-roots before migrated`: every root unchanged, OK.
- Served the migrated copy with the new build under the real public origin: health ok,
  `GET /.arbor/trees/{id}` returns `{ tree, observedThrough }` with `root`, the snapshot is
  flat with `tree.root === root`, `verify.ts` green against local placements, `/~joe` 200.

## Live run (2026-09-02)

1. Backup `/data/backups/2026-09-02-if-match/volume.tar` on the volume; local copies under
   `~/arbor-migration-2026-09-02/if-match/` (`volume.tar`, `before/`, `migrated/`,
   `dot-arbor.before/`, `authored-before.json`).
2. Stopped the Mac daemon with every placement idle. The iPhone app was not running.
3. `railway up --detach -y` deployed commit `82a717f`; the new build found stamp 2 and served
   maintenance mode (deployment `90dd5c32`).
4. `railway ssh -- bun run migrations/001-if-match-and-model-hash/run.ts /data`: identical
   report to the rehearsal (0 rewritten, 128 retained, 2,347 pruned, stamp 3).
5. `railway redeploy -y`; health `ok` after about a minute.
6. `arbor daemon start`; all five placements idle within seconds, refs advanced to the restored
   update ids, `verify.ts` green, authored manifest unchanged (111 files).
7. Round-trip edit on the Drift tree accepted and visible at its canonical URL, then removed.

Caveat: `~/.arbor/.state/version` had already been stamped "2" earlier the same day by a test
that touched the real data home, so the daemon's stamp-triggered re-place did not fire. It was
not needed, since no root changed. The old iPhone build cannot sync against the new server
(it reads `/ref`); update the app.
