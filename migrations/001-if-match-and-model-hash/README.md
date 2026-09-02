# 001: `ifMatch`, merge rules, `modelHash`, and `_index.md` precedence

**Status:** code complete, not yet run against real data. `run.ts` migrates a data root from
schema 2 to 3 and `migrate.test.ts` proves it on a bootstrapped Canopy. Runs once, then this
directory is deleted.

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
