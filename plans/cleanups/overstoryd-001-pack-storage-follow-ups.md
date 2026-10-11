# overstoryd 001: Pack storage follow-ups

**Why and when:** object packing is live ([status](../../status.md#object-packing-deployed--2026-10-09)). What is left is documentation and three small checks. Take them when the store is next worked on, or sooner if a pack is ever suspected.

Historical identifier: **overstoryd storage 001**, formerly "Pack retained objects". The layout decision, the measurements on a copy of live data and both rehearsals are in status; earlier fixture results are in this file's git history.

## Status

- **Effort:** S
- **Risk:** LOW. Nothing here changes how objects are packed or read.
- **State:** DEPLOYED 2026-10-09 at `3514eaf4`, on by default (`OVERSTORYD_OBJECT_PACKING=0` stops packing; packs stay readable).

## Remaining work

1. **Architecture notes.** `docs/architecture/overstoryd/README.md` describes retention and collection but not packs. Add the layout, the pass and its crash states, what stays loose, and how the collector treats packed rows, from the status entry and the [deployment guide](../../packages/overstoryd/deploy/README.md#packed-objects), which already covers backup and rollback.
2. **A periodic integrity check of pack files against their names.** Every read is hash-checked, so a damaged pack is found only when one of its objects is read.
3. **Packed bytes in the integrity and collector reports.** The collector reports packed objects under `packed`; neither report gives their bytes.
4. **Stream the experiment harness.** `tests/performance/storage/pack-experiments.ts` keeps every object in memory (4 GB RSS on the live copy). Only if the store grows much further.

Not measured on the live host: backup size and time with packs, and foreground latency while a pass runs under a burst. Measure them with the next backup rather than as a task of their own.

## Non-goals

- Changing object hashes, canonical encodings, update IDs, or Overstory formats.
- Synchronizing packs between hosts.

## Obligations for any later packing or pruning

Schema 9 made basis and candidate roots explicit retention dependencies of
each authored change, checked by integrity verification. Any packing or
pruning must retain those graphs together with the operation records and
inverse material, and must keep the store append-only from the point of view
of accepted receipts: historical rule results and receipts are never
recomputed. A future collector must pin job inputs, staged inputs, results
awaiting commit, hidden alternatives, and provenance dependencies; the merge
job manifest alone is not a completed lease protocol.

## Close out

Record the changes in `status.md`, move the obligations above into the architecture notes, and delete this plan.
