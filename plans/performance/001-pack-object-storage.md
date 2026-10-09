# canopyd 001: Pack retained objects

**Why and when:** when size hurts: the live volume or backups grow until loose objects cost startup, audit or backup time. Space is not pressing.

Historical identifier: **canopyd storage 001**. The filename number is preserved; this plan now belongs to canopy.

## Status

- **Effort:** M (most of it built)
- **Risk:** MEDIUM. An index row pointing at the wrong bytes would corrupt reads,
  but every read is checked against its hash.
- **State:** BUILT AND OFF BY DEFAULT (`ARBOR_OBJECT_PACKING=1`). The layout is
  chosen on fixture evidence. Its live measurement, the rehearsal and the
  rollout remain.
- **Depends on:** live measurements from the copied store (prompt below).

## What is built

`ObjectStore` falls back from loose files to packs under `objects/packs/`, indexed in
`objects/packs/index.sqlite3`. The index is owned by the object store, so canopyd's
schema is unchanged and the merge sidecar opens it read-only.

- **Records.** Each index row has binary hash keys and integer pack ids, about 48 B per
  row against 164 B with text. It names one object's record, which is one of:
  - raw;
  - zstd alone;
  - a zstd delta whose dictionary is the previous version of the same document, at
    most 10 deep;
  - a member of a shared zstd frame. Objects under 4 KiB that no delta helps share
    frames of about 256 KiB, in document order.

  A table of each document's newest packed version lets later passes keep chaining.
  Deltas of a document's versions reach group-level compression without groups'
  incremental penalty, and a single read decompresses only one chain.
- **Pass.** One pass:
  1. checks every candidate's hash;
  2. writes the pack and syncs it under its content's name, then indexes it in one
     transaction;
  3. reads every object back through the index and checks its hash;
  4. records the documents;
  5. only then removes loose files.

  A crash leaves every object loose, packed or both. An unindexed pack older than an
  hour is an orphan and is removed.
- **What is packed.** `PackMaintenance` in canopyd packs loose objects older than an
  hour that lie outside every tree's current closure. The hot set stays loose, so
  current-tree reads and freshens never touch packs. Each object is keyed by its
  `document_versions` stable key, else its path in the root that holds it, else its
  tree's log.
- **Triggers.** A pass is triggered when acceptances push the loose count or bytes
  over 4,000 objects or 64 MiB (debounced 30 s), at startup, and on a 30-minute idle
  check. Passes run in batches of 4,000 objects or 64 MiB, defer when free disk is
  under twice a batch, and run one at a time. An accepted update never waits for one.
- **Collection.** Freshening a packed object updates its row's `used_at`. The
  collector drops dead packed rows under the same retention definition and grace
  period, conditional on `used_at`, and keeps every base a kept delta reads. It then
  rewrites packs that lost half their bytes by copying records unchanged.
- **Tests.** Packing is covered by `tests/unit/object-store-packs.test.ts` and the
  packed-history case in `tests/integration/canopyd/object-collection.test.ts`. That
  case covers packing, restart, integrity audit, acceptance on top, collection and
  sidecar replay.

## Evidence so far (fixture, 2026-10-09)

The tools are `tests/performance/storage/`. `git-history-fixture.ts` replays this
repository's first-parent history (1,016 commits) into a data root: 24,156 objects,
259 MB raw, 322 MB allocated as loose files. The live store was 418 MiB on
2026-10-07. `pack-experiments.ts` compared the layouts below with an 8 MiB group
cache; timings are in-container and single runs.

| Layout | Allocated | Files | History reads | Random read p95 | Incremental (every 50 / 200 updates) |
| --- | ---: | ---: | ---: | ---: | --- |
| Loose | 322 MB | 24,156 | 578 ms | 0.67 ms | — |
| Write order, 256 KiB | 88 MB | 1,122 | 580 ms | 1.05 ms | 84 MB |
| Write order, 4 MiB | 56 MB | 66 | 3,013 ms | 16 ms | 52 MB |
| Document, 256 KiB | 49 MB | 1,262 | 109 ms | 0.73 ms | 55 / 48 MB |
| Document, 1 MiB | 35 MB | 339 | 51 ms | 3.2 ms | 42 / 35 MB |
| Hybrid (hot loose), 1 MiB | 48 MB | 1,585 | 73 ms | 3.0 ms | — |
| Similarity, 1 MiB | 35 MB | 269 | 147 ms | 3.4 ms | 43 / 35 MB |
| Delta, depth 10 | 37 MB | 1 | 103 ms | 0.60 ms | same as one-shot |
| Delta, depth 50 | 33 MB | 1 | 97 ms | 2.3 ms | same as one-shot |
| Keyframe (depth 1) | 46 MB | 1 | 145 ms | 0.38 ms | same as one-shot |

What the fixture shows:

- **Write order is the worst policy at every size.** Interleaved documents defeat it.
- **Similarity sketches match document grouping in size, with worse edit locality.**
  They found no cross-document redundancy that documents miss.
- **Group compression needs large groups.** Large groups make a cold single read
  decompress up to the whole group (3 ms at 1 MiB, 10 ms at 4 MiB). They also lose
  much of their gain when packing is incremental, unless groups are periodically
  rewritten.
- **Git-style deltas against the previous version of the same document match 1 MiB
  document groups in size.** They keep sub-millisecond random reads, cost nothing
  extra when packed incrementally, and need no rewrite to stay compact. Their costs
  are base dependencies (a delta's base is kept while the delta lives) and slower
  full audits (7.4 s against 3.8 s loose on the fixture).

The September decision (independent groups, no deltas) is therefore reversed. Live
history is dominated by many versions of a few large documents: 2,683 bodies, mostly
of one 60 KB `_index.md`. A 1 MiB group holds about 17 of those versions, while a
delta between consecutive versions is a few hundred bytes. So deltas should win by
more on live data than on the fixture.

## Remaining work

1. **Measure on a copy of live data.** Run `pack-experiments.ts` on a copy of the live
   data root. Confirm or
   adjust the depth, delta threshold, small-object frame size, hot set, minimum age
   and trigger thresholds, and record the results here. Treat "Keep the loose store if
   reads regress materially" as the bar.
2. **Rehearse on a copy.**
   - Enable packing against a copy of the live data root.
   - Report objects and bytes before and after.
   - Check that the integrity audit and the merge answers are unchanged.
   - Measure:
     - warm edit latency;
     - full-history load;
     - cold start;
     - audit time;
     - backup size and time;
     - foreground latency while a pass runs, including a burst arriving
       mid-pass.
   - Inject failures at each pass step (kill between pack write, index commit,
     read-back and loose removal) and confirm a rerun converges.
3. **Update the operating material.** `packages/canopyd/deploy/README.md` (the backup
   tar already includes `objects/packs/`; the index must be copied consistently, so
   use a SQLite backup of `index.sqlite3` or stop the writer). Update
   `docs/architecture/canopyd/` storage notes and the status row.
4. **Roll out with Joe's explicit go-ahead.** That means the full verification gate, a
   rollback plan (packs can be expanded back to loose files by reading every packed
   object and storing it), then setting `ARBOR_OBJECT_PACKING=1` on the host.
5. **Open, smaller.**
   - Re-encoding a delta whose base died, so dead bases can be dropped. Today they
     are kept as bases.
   - A periodic integrity check of pack files against their names.
   - Integrity and collector counts of packed bytes in `/.arbor/integrity`.

## Non-goals

- Changing object hashes, canonical encodings, update IDs, or Overstory formats.
- Synchronizing packs between Canopies.

## Compaction obligations

Schema 9 made basis and candidate roots explicit retention dependencies of
each authored change, checked by integrity verification. Any packing or
pruning must retain those graphs together with the operation records and
inverse material, and must keep the store append-only from the point of view
of accepted receipts: historical rule results and receipts are never
recomputed. A future collector must pin job inputs, staged inputs, results
awaiting commit, hidden alternatives, and provenance dependencies; the merge
job manifest alone is not a completed lease protocol.
