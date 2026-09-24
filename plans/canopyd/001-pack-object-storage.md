# canopyd 001: Pack retained objects into compressed group files

Historical identifier: **canopyd storage 001**. The filename number is preserved; this plan now belongs to canopy.

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** MEDIUM — an index row pointing at the wrong bytes would corrupt reads;
  every read is checked against its hash
- **State:** READY FOR DESIGN REVIEW
- **Depends on:** nothing; space is not pressing (6% of the live volume), so this
  is taken up for read locality, startup, audit, and backup cost

## Baseline (2026-09-19)

Measured on the post-013 rehearsal copy (`~/arbor-013-compact-20260919/migrated`),
which matches live within a few dozen updates:

| | Disk | Files | Random read, uncached group |
|---|---|---|---|
| Loose files (today) | 212 MB | 34,109 | 14 µs |
| SQLite blobs | 152 MB | 1 | 17 µs |
| SQLite rows of zstd groups | 24 MB | 1 | 85 µs |
| zstd group files + index | 24 MB | 364 | 79 µs |

The objects hold 107 MB; the median is 739 bytes and 90% are under 4 KiB, so
half the disk is block padding. Compressing objects one at a time gains only
1.6×; compressing groups of objects written together (256 KiB groups, zstd
level 3) gains 9× against disk, because successive versions of the same files
and state chunks are near-duplicates. A long-window zstd-19 of the whole store
(10.9 MB, a stand-in for ideal deltas) is only 30% smaller than the grouped
result, which does not justify delta chains.

On Railway the full integrity audit reads every object and takes minutes;
downloading a 590 MB volume archive took about twenty minutes.

## Decision

Group files on disk, indexed in SQLite, with a process cache of decompressed
groups. Chosen over rows in SQLite so that the database stays small and hot
data stays separate from cold history by construction: the SQLite file and the
recently used group files fit in the OS page cache, and old groups become files
that are simply never read. Transactional coupling with SQLite and single-file
backup were considered and are not requirements.

Git-style deltas, pack generations, and geometric repacking are out: grouping
captures most of the redundancy, and without deltas no object depends on
another, so there are no base chains to protect when pruning.

## Design

- **Group file.** `objects/packs/<group-hash>.zst`: one zstd frame of the
  concatenated canonical bytes of the objects it holds, named by the hash of
  its compressed bytes. Target about 256 KiB raw; tune by measurement against
  read cost (smaller groups read faster and compress less).
- **Index.** A SQLite table `packed_objects(hash PRIMARY KEY, pack, offset,
  length)`. A hash still names canonical object bytes; the index only says
  where they are. Every read is checked against the hash, as loose reads are
  today.
- **Reads.** `ObjectStore.load` checks loose first, then the index, then a
  small LRU of decompressed groups (sized in bytes, a few MiB to start) before
  reading and decompressing the group file. Objects written together are read
  together, so an edit's ~260 reads should mostly hit the cache.
- **Writes.** Unchanged: new objects are written loose.
- **Packing pass.** Runs after an accepted update's response, never on its
  path, at most one at a time, when loose objects exceed a count or byte
  threshold, or at startup. It takes loose objects in write order, fills
  groups, writes and fsyncs each group file, inserts its index rows in one
  transaction, then deletes the loose files. A crash at any point leaves each
  object readable loose, packed, or both; startup deletes group files that no
  index row references.
- **Pruning.** When retained objects are deleted (as migration 013 did), a
  group whose live share falls below a threshold is rewritten with its live
  objects and the old file removed after the index moves. Nothing else
  references a group, so this is local.
- **Pinning before any deletion** (from canopyd 009). Pruning or collection must
  first pin every accepted and authored semantic root, all transitive hidden
  and undo dependencies, staged inputs, and results awaiting commit. The
  retention audit's closure is the pin set; an object outside it is the only
  candidate. That closure is `packages/canopyd/src/retention.ts`, which the
  loose-object collector already uses; a group rewrite deletes by the same
  definition and honors the same freshening grace period. Coordinate with [fragment storage](002-composable-conflict-fragments.md).
- **Audit.** `verifyIntegrity` reads through the same `ObjectStore`, so it walks
  groups sequentially instead of 35k files.

## Work

1. `ObjectStore` gains the index, the group reader, and the decompressed-group
   cache behind its existing interface; callers do not change.
2. The packing pass and its trigger, with startup orphan cleanup.
3. A one-off migration packs the existing loose store, rehearsed on a copy
   with the usual report (objects, bytes before/after, audit identical).
4. Group rewrite on prune.
5. Measure on the rehearsal copy: warm edit latency, the full-history load
   (currently ~9,000 reads, 1.3 s), cold start warm-up, and audit time, each
   before and after. Keep the loose store if reads regress materially.

## Verification

- Existing Overstory, canopyd, and sync suites pass unchanged.
- A fixture reads identically from all-loose, mixed, and fully packed stores.
- Killing the process at each step of a packing pass leaves every object
  readable and a rerun converges.
- A group file whose bytes do not hash to the index's claim fails the read.
- Accepted-update latency does not depend on a packing pass in progress.
- The measurements in step 5 are recorded here.

## Non-goals

- Changing object hashes, canonical encodings, update IDs, or Overstory formats.
- Deltas between objects.
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
