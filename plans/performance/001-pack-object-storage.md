# canopyd 001: Pack retained objects into compressed group files

**Why and when:** when size hurts: the live volume or backups grow until loose objects cost startup, audit or backup time. Space is not pressing.

Historical identifier: **canopyd storage 001**. The filename number is preserved; this plan now belongs to canopy.

## Status

- **Effort:** M
- **Risk:** MEDIUM — an index row pointing at the wrong bytes would corrupt reads;
  every read is checked against its hash
- **State:** READY FOR GROUPING EXPERIMENTS AND DESIGN REVIEW
- **Depends on:** nothing; measure storage, read locality, startup, audit, and
  backup cost before selecting the grouping policy. The old 6% volume baseline
  is superseded by the 2026-10-07 inspection below.

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

## Current inspection (2026-10-07)

Read-only inspection of the live Railway host found 418.0 MiB in `objects/`.
The whole volume used 1.16 GiB (26%), including 410.3 MiB of merge cache and
334.0 MiB of backups. These are separate costs: this plan packs accepted objects;
[Shared merge checkpoints](../../docs/architecture/canopyd/merge-cache.md) address the private merge cache.
The September compression numbers remain historical evidence, not a forecast
for the current retained store.

## Decision

Group files on disk, indexed in SQLite, with a process cache of decompressed
groups. Chosen over rows in SQLite so that the database stays small and hot
data stays separate from cold history by construction: the SQLite file and the
recently used group files fit in the OS page cache, and old groups become files
that are simply never read. Transactional coupling with SQLite and single-file
backup were considered and are not requirements.

Keep independent compressed groups rather than Git-style delta chains. The
September experiment supports grouping, but tested only write-order grouping;
it did not establish the best grouping policy. Joe favors the hybrid below as
the starting hypothesis, with experiments before selecting a policy. No object's
canonical bytes or hash changes, and decoding a group requires no other group.

## Grouping experiments

Compare four policies on the same copied retained store and read workloads:

| Policy | Hypothesis | Cost to measure |
| --- | --- | --- |
| Write order / acceptance batches | Objects written together may be read together during tree access or replay. | Weaker compression when unrelated documents interleave; timestamps are only a proxy for shared reads. |
| Document versions | Nearby versions of one document share bytes and favor history reads. | A whole-tree read may decompress many groups; paths change, and one hash can belong to several documents. |
| Hybrid (preferred hypothesis) | Keep recent or frequently read objects loose; group cold document versions together, and handle directories, log entries, and other objects in appropriate separate batches. | Hot/cold classification, small groups, and the cost of maintaining locality as usage changes. |
| Content similarity | Group similar canonical bytes regardless of document or write time, using inexpensive sketches or fingerprints, optionally partitioned by object kind and size. | Classifier CPU/memory, stability across incremental batches, grouping overhead, and loss of read locality. |

The fourth policy could find repeated structure across different documents,
directory objects, and log entries that document grouping misses. Treat it as
an experimental candidate, not an assumption that similarity beats locality.
Compare a similarity-based cold tier inside the hybrid too, if the standalone
results justify it. Exact duplicate bytes already share an object hash; the
opportunity is similarity among different objects.

Use document identity or retained version metadata where available, never path
alone. Specify how renamed documents, copies, shared hashes, and objects without
a document association are assigned. Store each object once; grouping metadata
is private physical organization, not a new semantic identity or retention rule.
Group membership must not imply that every member is live.

Start around 256 KiB raw per group and compare smaller and larger groups.
Large individual objects may exceed the target; define an oversize policy without
changing canonical bytes. Compare zstd levels and compression bypass for already
compressed/incompressible assets. Hold the codec, cache budget, and object set
constant when comparing grouping policies.

Measure total allocated disk bytes including index and padding, compressed bytes,
group count, classifier/packing cost, peak memory and temporary disk, and bytes
read/decompressed per requested object. Replay representative current-tree reads,
warm edits, concurrent merges, document history, full-history loads, cold startup,
full audit, and backup/restore. Include repeated-version and diverse/binary-heavy
fixtures. Report p50/p95 latency, cache hits, and incremental behavior as new
updates arrive; a one-off packing ratio is insufficient. Select the policy from
size and latency together, and retain loose storage if reads regress materially.

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
  reading and decompressing the group file. Grouping experiments must establish
  locality and cache hit rates rather than assume write order matches read order.
- **Writes.** Unchanged: new objects are written loose.
- **Trigger and scheduling.** One process-local maintenance coordinator owns
  packing, group rewrites, and orphan cleanup. Maintain incremental loose-object
  count and byte counters at publication (count newly created files, not repeated
  stores/freshens); reconcile at startup and after collection. After an accepted
  update responds, notify the coordinator when eligible loose objects cross
  configurable high thresholds. Coalesce notifications and debounce bursts;
  pack toward lower thresholds so the worker does not oscillate. Select count,
  byte, minimum-age, and idle/cooldown defaults from the experiments, recording
  them and the rationale. Recent writes may remain loose even above a threshold.
  A startup check and an internal low-frequency idle check handle leftover work
  and objects that become eligible without another acceptance. No external cron
  is needed, and an idle check performs no full scan when counters show no work.
- **Bounded background pass.** Use the selected grouping policy, with bounded
  object/byte/time batches and yielding between batches. Keep foreground requests
  independent of the maintenance queue; benchmark contention, including a burst
  arriving while compression is active. Avoid repeatedly reopening healthy groups
  to add a single new version: pack eligible batches, and rewrite only for a
  measured fragmentation or locality benefit. Defer on insufficient temporary
  disk headroom or foreground load; retain loose files and retry without a busy
  loop. Startup readiness must not wait for compression of the existing store.
- **Publication and recovery.** Write and fsync complete group files, insert their
  index rows transactionally, then remove corresponding loose files. Coordinate
  concurrent stores/freshens, reads, pruning, and group rewrites explicitly so
  neither packing nor collection can create missing references. A crash leaves
  every object readable loose, packed, or both. Startup recovers interrupted work
  and removes unreferenced groups only after excluding in-flight publications.
  Report eligible/backlog bytes, trigger reasons, deferred work, packing time,
  compression ratio, and group-cache hits.
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
  definition and honors the same freshening grace period.
- **Audit.** `verifyIntegrity` reads through the same `ObjectStore`, so it walks
  groups sequentially instead of 35k files.

## Work

1. Build the copied-store benchmark and grouping experiments above. Revalidate
   the retention closure and record the current baseline, including allocated
   disk usage and read traces. No live migration or audit is needed for this
   experimental step.
2. Record the selected grouping policy, group size, codec settings, hot/cold
   criteria, and trigger thresholds with their evidence. The hybrid is the
   preferred hypothesis, not a predetermined benchmark result.
3. `ObjectStore` gains the index, group reader, and decompressed-group cache behind
   its existing interface. Cover all read, presence, freshening, publication,
   collection, integrity, and sidecar paths; a packed object must not look absent
   to a loose-file-only existence check.
4. Implement the coordinator, bounded packing, counters, idle/startup checks,
   publication recovery, and group rewrite on prune. Do not delete retained
   objects merely because their loose files have been packed.
5. Rehearse packing the existing store on a copy with an objects/bytes before-and-
   after report, equivalent audit and merge answers, failure injection, and the
   performance measurements above. Prepare the rollout and rollback procedure;
   live migration/deployment requires Joe's explicit go-ahead and the repository's
   full verification gate.

## Verification

- Existing Overstory, canopyd, and sync suites pass unchanged.
- A fixture reads identically from all-loose, mixed, and fully packed stores.
- Killing the process at each step of a packing pass leaves every object
  readable and a rerun converges.
- A group file whose bytes do not hash to the index's claim fails the read.
- Accepted updates never await packing. Measured foreground latency and resource
  contention meet the recorded limits while maintenance is active.
- Bursts coalesce, only one maintenance pass runs at a time, thresholds have
  hysteresis, and idle/startup checks drain eligible leftovers without cron.
- Hot or newly freshened objects, collection races, insufficient disk, interrupted
  publication, and sustained writes preserve readability and bounded work.
- All four grouping experiments and the selected policy's incremental results
  are recorded before rollout; rejected policies include measured tradeoffs.

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
