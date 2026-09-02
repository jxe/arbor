# 001: `ifMatch`, merge rules, `modelHash`, and `_index.md` precedence

**Status:** not started. Waits on the code in [Data 009](../../plan/data/009-update-if-match.md)
and [Data 010](../../plan/data/010-index-body-precedence.md). Runs once, then this directory
is deleted.

## What changes on disk

- Every wire directory object that carries a rollup entry: the field `modelDigest` becomes
  `modelHash`. That changes the object's bytes and hash, so every ancestor directory object
  and every affected tree's root changes too. The migration re-encodes those objects, rewrites
  each affected tree's ref and its single restored accepted update, and deletes the old
  objects.
- `accepted_updates`: the `merge` column is null for merges that ran no rule.
- `meta.schema_version` advances.
- No account, device, boundary, or access row changes. No authored file changes.

## Order

Follow [the procedure](../README.md#the-procedure). Specific to this migration:

- Rehearsal must show `compare-canopy-roots` equal after decoding (model-equivalent trees,
  different roots for rollup-bearing trees only) and `verify` green against the local server.
- The Mac daemon's re-place is exercised by the schema stamp; confirm authored files are
  untouched with `authored-manifest diff`.
- The iPhone's rollup-bearing replicas are deleted and re-placed on launch (commit `ac695b4`).

## Rehearsal log

_(date, archive name, report summary, compare result, verify result)_
