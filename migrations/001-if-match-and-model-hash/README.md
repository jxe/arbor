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

_(date, archive name, report summary, compare result, verify result)_
