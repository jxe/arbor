# overstoryd 001: Pack retained objects

**Why and when:** when size hurts: the live volume or backups grow until loose objects cost startup, audit or backup time. Space is not pressing.

Historical identifier: **overstoryd storage 001**. The filename number is preserved; this plan now belongs to overstoryd.

## Status

- **Effort:** M (most of it built)
- **Risk:** MEDIUM. An index row pointing at the wrong bytes would corrupt reads,
  but every read is checked against its hash.
- **State:** BUILT. Off on main (`OVERSTORYD_OBJECT_PACKING=1` to enable). The
  branch `claude/blissful-maxwell-r3sys4` turns it on by default
  (`OVERSTORYD_OBJECT_PACKING=0` to disable) and awaits the rehearsal below. The
  layout was chosen on a copy of live data.

## What is built

`ObjectStore` falls back from loose files to packs under `objects/packs/`, indexed in
`objects/packs/index.sqlite3`. The index is owned by the object store, so overstoryd's
schema is unchanged and the merge sidecar opens it read-only.

- **Layout.** A pack holds zstd frames of about 1 MiB raw. Each frame holds one
  document's versions in acceptance order; documents follow each other in a frame,
  and a frame ends where a document ends once it is half full. An object of 1 MiB or
  more is packed alone, as zstd or raw. No object depends on another. Index rows use
  binary hash keys and integer pack ids, about 48 B per row.
- **Pass.** One pass:
  1. checks every candidate's hash;
  2. writes the pack and syncs it under its content's name, then indexes it in one
     transaction;
  3. reads every object back through the index and checks its hash;
  4. only then removes loose files.

  A crash leaves every object loose, packed or both. An unindexed pack older than an
  hour is an orphan and is removed.
- **What is packed.** `PackMaintenance` in overstoryd packs loose objects older than an
  hour that lie outside every tree's current closure. The hot set stays loose, so
  current-tree reads and freshens never touch packs. Each object is keyed by its
  `document_versions` stable key, else its path in the root that holds it, else its
  tree's log.
- **Triggers.** A pass is triggered when acceptances push the loose count or bytes
  over 4,000 objects or 64 MiB (debounced 30 s), at startup, and on a 30-minute idle
  check. Passes run in batches of 4,000 objects or 32 MiB, defer when free disk is
  under twice a batch, and run one at a time. An accepted update never waits for one.
- **Collection.** Freshening a packed object updates its row's `used_at`. The
  collector drops dead packed rows under the same retention definition and grace
  period, conditional on `used_at`, then rewrites packs that lost half their bytes by
  copying frames unchanged.
- **Tests.** Packing is covered by `tests/unit/object-store-packs.test.ts` and the
  packed-history case in `tests/integration/overstoryd/object-collection.test.ts`. That
  case covers packing, restart, integrity audit, acceptance on top, collection and
  sidecar replay.

## Evidence

`tests/performance/storage/pack-experiments.ts` was run on a copy of live data taken
read-only on 2026-10-09 at 13:43Z: 22,370 objects, 380 MB raw, 431 MB loose on APFS
(442 MB on the host). One document (`id:zvjr20`) holds 4,849 versions and 272 MB
raw. The root directory has 4,245 versions and the log has 4,402 entries. The run was
on an Apple M4 with an 8 MiB frame cache; these are single runs.

| Layout | Allocated | Files | History reads | Random read p95 | Audit (hash order) | Incremental, every 50 / 200 updates |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Loose | 431 MB | 22,370 | 251 ms | 0.03 ms | 0.6 s | — |
| Write order, 1 MiB | 23.0 MB | 390 | 95 ms | 0.84 ms | 5.2 s | 25.5 / 22.5 MB |
| **Document, 1 MiB** | **21.8 MB** | **452** | **74 ms** | **0.58 ms** | **4.9 s** | **24.6 / 22.0 MB** |
| Document, 4 MiB | 14.7 MB | 115 | 54 ms | 1.46 ms | 15.5 s | 17.8 / 14.8 MB |
| Similarity, 1 MiB | 20.4 MB | 389 | 97 ms | 0.56 ms | 5.4 s | 23.5 / 20.6 MB |
| Hybrid (7-day hot set loose), 1 MiB | 141 MB | 7,174 | 176 ms | 0.42 ms | 3.2 s | — |
| Keyframe (depth 1) | 36.2 MB | 1 | 126 ms | 0.09 ms | 0.6 s | same as one-shot |
| Delta, depth 10 | 49.7 MB | 1 | 136 ms | 0.20 ms | 1.1 s | same as one-shot |
| Delta, depth 50 | 40.5 MB | 1 | 70 ms | 0.46 ms | 3.1 s | same as one-shot |

**Decision: document frames of 1 MiB.** On live data, grouping beats per-version
deltas by 2–2.3×. Versions of the heavily edited document compress against the
dozens of other versions in their frame, not just the previous one. That reverses the
call made on the repository-history fixture (where deltas matched groups); the live
copy is the authority.

- **Size.** 4 MiB frames save another 7 MB, but cost 2.5× the single-read latency and
  3× the audit time.
- **Incremental penalty.** Packing every 50 updates costs 2.8 MB at 1 MiB, well under
  the ~10 MB the tested range of 50–200 updates would allow.
- **Hot set.** It must be the current closure plus a short minimum age, as built. A
  7-day hot set kept 6,874 objects (141 MB) loose, because the busy document's recent
  versions are all within it.
- **Write order and similarity** were within 10% of document order on live data.
  Document order is kept for its history locality.

The fixture results (`git-history-fixture.ts`, 259 MB raw) remain in git history
under this plan's earlier revisions.

## Rehearsal on a copy of live data (2026-10-09, `d6b6ada1`)

Joe's rehearsal used a read-only copy taken at 14:31:55Z: 22,379 objects, 431 MB.

| Step | Result | Pass/fail |
| --- | --- | --- |
| Pack | 22,220 objects (388.5 MB → 12.4 MB of packs) packed in 7 packs, 4.4 s, peak 583 MB. `objects/` went from 431 MB to 25 MB; 159 loose files remained (current trees, and objects under an hour old). | — |
| Packed audit | `verifyIntegrity` passed in 1.8 s, against 4.1 s loose. At zero grace, the same 18,932 live and 3,447 collectable objects as before packing. | Pass |
| Second pass | Nothing to pack. | Pass |
| Serving with packing on | Ready in 0.085 s (0.089 s with packing off). Reads during and after the pass matched an unpacked server; the pass settled in about 12 s. | Pass |
| `--unpack` | 22,220 objects back loose in 5.1 s. Integrity passed with the baseline's counts. | Pass |
| Interrupted passes | 4,159 objects stayed both loose and packed. | Fail |
| `object-store-packs.test.ts` | Intermittent. | Fail |

**Fixes since that rehearsal:**

- **Interrupted passes.** A pass killed after its index commit but before removing
  loose files left them for good, because later passes skipped already-indexed
  objects before the removal step. Every pass now reads such candidates back from
  their pack and removes their loose files.
- **Intermittent test.** `removeOrphans(0)` compared file times against the clock.
  It now ignores age entirely.
- **Grace period.** Packing restarted each object's collector grace period, and so
  did unpacking. A packed object now keeps its loose file's time as `used_at`, and
  unpacking restores it.
- **Memory.** Batches are 32 MiB instead of 64 MiB. On the repository-history
  fixture this took peak memory from about 371 MB to 324 MB.
- **Collector report.** Its `live` and `scanned` tallies count loose files only.
  Packed objects are reported under `packed`.

## Remaining work

1. **Measure the integrity audit and backup on a packed copy.** The harness audit read
   objects in hash order (4.9 s against 0.6 s loose). `verifyIntegrity` walks the
   retained graph, whose order is closer to document order. If it is still slow, give
   the audit a larger frame cache or read packs sequentially.
2. **Rehearse on a copy.**
   - Enable packing against a copy of the live data root.
   - Report objects and bytes before and after.
   - Check that the integrity audit and the merge answers are unchanged.
   - Measure:
     - warm edit latency;
     - full-history load;
     - cold start;
     - backup size and time;
     - foreground latency while a pass runs, including a burst arriving mid-pass.
   - Inject failures at each pass step (kill between pack write, index commit,
     read-back and loose removal) and confirm a rerun converges.
3. **Update the operating material.** In `packages/overstoryd/deploy/README.md`: the
   backup tar includes `objects/packs/`, and the index must be copied consistently
   (a SQLite backup of `index.sqlite3`, or a stopped writer). Update
   `docs/architecture/overstoryd/` storage notes and the status row.
4. **Roll out with Joe's explicit go-ahead.** That means the full verification gate, a
   rollback plan (packs can be expanded back to loose files by reading every packed
   object and storing it), then setting `OVERSTORYD_OBJECT_PACKING=1` on the host.
5. **Open, smaller.**
   - A periodic integrity check of pack files against their names.
   - Packed bytes in the integrity and collector reports.
   - The harness keeps every object in memory (4 GB RSS on the live copy); stream it
     if the store grows much further.

## Non-goals

- Changing object hashes, canonical encodings, update IDs, or Overstory formats.
- Synchronizing packs between hosts.

## Compaction obligations

Schema 9 made basis and candidate roots explicit retention dependencies of
each authored change, checked by integrity verification. Any packing or
pruning must retain those graphs together with the operation records and
inverse material, and must keep the store append-only from the point of view
of accepted receipts: historical rule results and receipts are never
recomputed. A future collector must pin job inputs, staged inputs, results
awaiting commit, hidden alternatives, and provenance dependencies; the merge
job manifest alone is not a completed lease protocol.
