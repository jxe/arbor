# Performance 002: Retire the earlier merge-cache formats

**Why and when:** the shared, compressed merge cache is live and the iPhone's stuck request was accepted through it ([status](../../status.md#shared-merge-cache-deployed--2026-10-09)). The sidecar still reads two earlier formats that nothing should hold any more. Remove them once the host's cache directory is seen to hold neither; the design is in [shared merge checkpoints](../../docs/architecture/overstoryd/merge-cache.md).

Formerly "Verify the shared merge cache rollout".

## Status

- **Effort:** S
- **Risk:** LOW. This is private cache storage: removing a reader early costs a full replay from each chain's start (the 4,200-entry rebuild), never accepted data.
- **Depends on:** one read-only look at the live cache directory (Joe's go-ahead for `railway ssh`).

## Steps

1. **Look.** List the host's `merge-cache/` directory once. Record whether any `<tree>/<entry digest>.json` file or `records-v1.sqlite` remains, and the size of `records-v2.sqlite`.
2. **Whole-JSON saves (`<tree>/<entry digest>.json`).** Read by `SavedStates.read`, and written by the fallback in `Sidecar.save` when the database cannot open (`encodeRetainedState`, `decodeRetainedState`). On a read-only copy at 2026-10-09 13:43Z the tree's directory was already empty.
   - Delete the JSON read path and the write fallback; a database that cannot open becomes an empty cache, as a missing cache already is.
   - Have `savedStatesIn` delete leftover `<tree>/` directories.
   - Drop the two functions once tests and `benchmark-cache.ts` take native stores as input.
3. **`records-v1.sqlite`.** Read by `LegacyCheckpointStore` in `checkpoint-store.ts` until its checkpoints are removed, then deleted. Normal retention replaces each tree's two checkpoints after about 64 replayed entries, or as soon as a basis is saved, so step 1 should find none. Delete `LegacyCheckpointStore` and its test.
4. **Close out.** Gate: `bun run test:affected`. Record the step 1 listing and the removal in `status.md` and delete this plan.
