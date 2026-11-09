---
name: data-oriented-performance
description: Use for any speed or memory work in this repo (overstoryd, the merge sidecar, object store, Story Sync, Swift clients), and before adding a cache, an fsync, a file per record, or a background pass. Data-oriented design for CPU, plus the rules for Railway's slow disk.
---

# Data-oriented performance

Speed work here goes in this order: measure, find the data that moves, redesign
how it is laid out and how often it moves, then measure again. Aim for 10x, not
1%. A change that saves 1% is rarely worth its code; a change that removes a
whole pass, a whole decode, or a whole fsync usually is.

## 1. Measure first, and keep the numbers

- Every overstoryd update logs one `event=update` line and returns the same
  phases in `Server-Timing` (`packages/overstoryd/src/updates/timing.ts`). Read
  phases, `objects`, `written`, `fsyncs`, `reads`, `read-files`, `read-ms`.
- Local harnesses: `tests/performance/snapshot-acceptance-cost.ts` (whole
  updates through a real host), `benchmark-merge-tool.ts` (sidecar engine),
  `tests/performance/provenance/*` (index cost, fsync counts, cold reads).
- Profile CPU with `bun --cpu-prof --cpu-prof-dir=DIR script.ts`, then sum
  self and inclusive time by function. To profile the merge sidecar, point
  `OVERSTORYD_MERGE_EXECUTABLE` at a wrapper that runs it under `--cpu-prof`
  and shut the host down cleanly so the profile is written.
- Model Railway's disk locally with the fsync-delay shim
  (`/mnt/project-files/perf004/fsdelay.c`, `LD_PRELOAD`, ~4 ms per fsync). Local
  disks hide exactly the costs that hurt in production.
- Count, don't guess: how many times per request is the same object read,
  hashed, decoded, re-encoded, validated? A counter in the hot function for
  one run answers it. (2026-11-02: a one-byte traced edit decoded the same
  root directory 9 times, about 12 of its 27 ms.)
- Before a host-side deploy, rehearse on a copy of Joe's real data with a cold
  start and real time limits.

## 2. CPU: lay the data out for the work

Ask these of every hot structure:

- **Can this be a flat array?** Replace `Map<string, T>` keyed by hash or path
  with an array indexed by a small integer. Intern each 32-byte hash once into
  one `Uint8Array` arena and pass `u32` ids around, not `"sha256:<hex>"`
  strings (71 bytes, a string compare, a hash-table probe each time).
- **Can the pointer be an index?** Trees of objects (`{ name, entries: [...] }`)
  become parallel arrays: `parent[]`, `kind[]`, `nameStart[]`, `nameLen[]`,
  `hash[]`. Children are a contiguous range when nodes are laid out in
  directory order. Walking is a loop over integers, not a recursion over
  objects.
- **Can hot data ride in the index's upper bits?** A node id can carry its kind
  (file, page, directory, tree) in the top 2 bits so most checks never touch
  the node table.
- **Structure of arrays or array of structures?** If a pass reads one field
  across many records (every entry's name to binary-search, every piece's
  length to find an offset), store that field contiguously. In TS that means
  typed arrays (`Uint32Array`, `Int32Array`), not arrays of objects.
- **Is this list heap-allocated per call?** In TS, avoid `map`/`flatMap`/
  spread/`Object.entries` chains in hot loops; preallocate a typed array and
  fill it, or reuse a scratch buffer across calls. In Go, use a fixed-size
  array with a length (`[8]T` plus `n`) before falling back to a slice; in
  Rust, `SmallVec`/`ArrayVec`.
- **Array of booleans?** Use a bitset (`Uint32Array`, one bit per node): visited,
  changed, touched, needs-validation.
- **Decode once, at the edge.** Bytes arrive once per request. Scan them once
  into the flat form, validating canonical encoding in the same forward pass.
  Never decode to generic JS objects and re-encode to check canonicality: that
  costs ~13x a direct scan (1.36 ms vs 0.11 ms for a 200-entry directory). Keep
  names as byte ranges into the original buffer; compare bytes, not strings.
- **Compute the diff once and hand it down.** Validation, policy checks,
  provenance, entry changes and profile facts should all consume one list of
  changed nodes, not each re-walk the old and new roots.
- **Never do the same check twice in one request.** If a preflight proves
  something, carry the proof (or the computed diff) to acceptance.
- **Allocation is time.** In Bun/JSC a short-lived object per entry per pass
  is GC pressure that shows up as `copyDataProperties`, `slice`,
  `flatIntoArray`, `TextDecoder` in the profile. Those names mean a design
  problem, not a missing micro-optimization.

## 3. Caching is cope

Do not add a cache to make a slow path fast. Delete the redundant work instead:
decode once, diff once, carry results forward. Before adding one, ask what
work it hides and why that work happens more than once.

The test for anything kept in memory or on disk beyond the durable log: it must
be rebuildable from durable data and correct when empty. Then it is a
**working form** (the head tree as flat arrays, the provenance index), not a
cache. Treat it as non-durable: never fsync it, never hash-chain it, rebuild it
on a miss. An LRU of raw bytes that still get re-decoded on every hit, or a
cache whose budget needs tuning by environment variable, is a smell.

## 4. Disk: Railway's volume is slow

Measured on the production volume: ~3-5 ms per fsync, and ~8 ms to create a
small file even without fsync (metadata-bound). Small reads are slow too.
Lessons from Performance 004 (2026-11-01/02):

- **Count fsyncs per request and drive it to one.** The object journal
  (`ObjectStore.store`, ce775c7) took a fast-forward from 9 fsyncs to 1 and
  ~28 ms to ~15 ms in rehearsal. Everything accepted in a request goes in one
  append and one `fdatasync`, then one SQLite commit (WAL, `synchronous =
  NORMAL`).
- **Never create a file per record.** Append records to a journal or a pack
  and index them in SQLite. Loose files, temp-file-plus-rename, `mkdir -p` per
  write: each one is a metadata operation the volume makes you wait for.
- **Write nothing before acceptance.** Preflight works from memory; only the
  accepted result is written, once.
- **Durable before referenced, and only once.** The journal is synced before
  the row that names it commits; a lost commit leaves only unreferenced
  records that recovery (`Packs.recover`) re-indexes.
- **Rebuildable data is never fsynced.** Indexes, provenance records, and
  checkpoints are written without sync; if lost they are recomputed. If you
  catch yourself checkpointing a cache, delete the cache instead (merge-cache
  checkpoints were removed, ~1,200 lines, 56e57b0).
- **Batch and read in parallel.** Read independent objects concurrently
  (8ad9455); read a pack's range once instead of many small reads; group
  several objects into one record when they are read together.
- **Scratch goes to memory or tmpfs, not the volume.** Staging between
  overstoryd and a sidecar should go over the pipe or to `/tmp`, never as
  loose files on the data volume.
- **Background work never takes the single merge worker or the request
  path's locks.** The 2026-11-01 backfill blocked merges for over an hour.
  Pace background passes, defer them under load, and keep them off the
  accept path.
- Minimize `stat`/`exists` probes; ask SQLite (in page cache) instead of the
  filesystem.

## 5. Language is the last lever

Measure the design gain before reaching for a rewrite. On the directory scan,
the same flat algorithm was ~2.4x faster in Go than in TS, while the redesign
alone was ~13x. Redesign first, in the current language; port a component only
when it is already carved along a narrow, conformance-tested boundary (the
merge sidecar's question/answer protocol is one) and its profile is still
CPU-bound after the redesign.

## 6. Prove it

Every speed change states its before and after from the same harness (median
and p90, plus fsyncs and objects per request), keeps behaviour identical
(existing tests, plus a differential test against the old path when a format
or algorithm changes), and is rehearsed on real data before a host deploy.
