# Performance 002: Share and compress saved merge states

**Why and when:** Joe requested this work on 2026-10-07 after the live merge cache reached 410 MiB for two checkpoints of one tree. Reduce repeated storage and save/restore work while preserving computed merge states across restarts and memory eviction. Prototype and measure before choosing the final storage layout; no deployment date is set.

## Current behavior and evidence

The sidecar keeps persistent map buckets and interned immutable values in memory,
but saving expands them into independent JSON snapshots. Each save includes the
head state, states its decisions reference, and base64 bytes for named objects
not present in canopyd's accepted object store. It saves after 32 replayed entries
and retains two saves per tree. Save runs after the response, but the worker
awaits it before reading the next request.

Relevant implementation:

- [State sharing and serialization](../../packages/canopyd-merge/src/retained-state.ts).
- [Save, restore, and replay](../../packages/canopyd-merge/src/sidecar.ts).
- [Filesystem saved-state adapter](../../packages/canopyd-merge/src/saved-states.ts).
- [Worker request loop](../../packages/canopyd-merge/src/cli.ts).
- [Existing save/restart tests](../../tests/unit/canopyd-merge/saved-states.test.ts).
- [Identity and key-order tests](../../tests/unit/canopyd-merge/retained-state.test.ts).

Read-only live inspection on 2026-10-07 found two saves for
`tr_owozr6aegt5z7x6qyllvzljl5u`: 200,655,718 bytes (October 5) and
229,582,897 bytes (October 6). Each contains one state and no open decisions.
The newer state's history is 212,688,576 bytes, including 184,466,157 bytes
of effects (before/after node records); its current nodes are only 337,691 bytes.
This is repeated historical data, not a failure to remove old snapshots.

A local experiment on copies of those files, preserving object key order:

| Representation | Combined bytes | MiB |
| --- | ---: | ---: |
| Original snapshot JSON | 430,238,615 | 410.3 |
| Each original snapshot gzip-compressed | 72,921,461 | 69.5 |
| Shared nested state records, compressed bundle | 22,277,635 | 21.2 |
| Cache-only object bytes deduplicated by hash, compressed JSON bundle | 5,290,904 | 5.0 |
| Shared states plus cache-only objects | 27,568,539 | 26.3 |

The prototype represented arrays, ordered object members, and strings of at
least 256 characters as content-addressed records. It found 115,724 unique state
records across both saves. Adding the newer save required 8,803,640 additional
uncompressed record bytes rather than another full snapshot. Cache-only objects
collapsed to 12,848 hashes / 11,643,183 raw bytes across both saves.

Reconstruction produced exactly the same serialized state JSON for both files.
These are representation measurements, not an implemented cache or proof of merge
conformance or faster restart. They exclude database/page/index overhead and use
gzip, not zstd. The experiment script and source copies are temporary local files,
not durable fixtures; recreate the benchmark from a fresh copy during implementation.

## Proposed direction

Keep the cache separate from the accepted object store. Use that store read-only
for objects it already contains, as today. Do not publish private cache records
into accepted storage or change accepted-history retention to keep a cache alive.

1. **Immutable shared records.** Persist map branches and nested immutable values
   once, with content-addressed references. Preserve array order, object key order,
   map bucket shape, and semantic state identity. Encoding-record hashes are
   distinct from the existing semantic hashes unless their equivalence is proved.
   Deduplication must work within one state, across decision-dependent states,
   across checkpoints, and across trees when the encoded values are identical.
2. **Checkpoint manifests.** Small manifests bind a tree and log entry to computed
   state roots, decisions, and cache-only object dependencies. Preserve acceptance
   boundaries: a computed candidate is not an accepted log entry. Checkpoint only
   verified entry/state associations; retain solved-question results separately
   if that reuse is useful.
3. **Private object bytes.** Store cache-only objects once by their existing hash,
   as binary bytes rather than repeated base64. Continue referencing accepted
   objects through the shared store. A missing dependency invalidates the cache
   checkpoint and falls back to replay; it must not change a merge answer.
4. **Compressed indexed storage.** Prototype a separate cache SQLite database
   containing manifests, record indexes, and batched compressed record payloads.
   Compare with compressed group files plus an index. Do not create a loose file
   per tiny record: block padding and file count could erase the savings.
5. **Direct restoration.** Load each shared record once and reconstruct the
   interned values and persistent buckets directly. Do not expand a giant JSON
   snapshot only to walk and intern it again. Verify content and state identities;
   trust no persisted derived hash without verifying its dependencies. The engine
   currently uses synchronous map access, so initially hydrate the needed state
   graph eagerly and fetch object bytes on demand; asynchronous map loading would
   be a separate, broader design change.

## Remaining work

1. Build a repeatable local benchmark for the current snapshots and a fixture with
   unresolved decisions referencing multiple states. Include highly overlapping
   and mostly disjoint histories. Measure compressed snapshots as the simple
   baseline, shared records without compression, and shared records with compression.
2. Implement experimental codecs and adapters. Compare size including indexes,
   record count, cold restore, memory peak, warm merge latency, incremental save
   cost, and time until the worker can process its next request. Avoid traversing
   and rehashing unchanged in-memory branches on every save; reuse verified facts
   and a bounded index of published records.
3. Choose the layout and record granularity from those results. Small independent
   records enable deduplication; batched compression and reads should preserve
   locality. Record the measured tradeoff before committing to either backend.
4. Decide which computed entries to checkpoint and a byte-based cache budget.
   Small manifests may allow keeping old bases needed for concurrent edits and
   more recent heads, reducing replay after restart/eviction. Measure save-on-entry
   against periodic saves; do not promise replay-free access to uncached entries.
5. Publish dependencies before atomically committing each manifest. Keep the last
   usable checkpoint on interrupted writes. Collect private records unreachable
   from retained manifests, protecting in-flight saves/restores; serialize cache
   writers/collection or provide explicit leases. Bound orphan records and old
   checkpoints, and expose bytes, records, restores, replay counts, and save costs.
6. Keep a codec/engine compatibility version and an explicit fallback for old or
   corrupt cache data. Replacing this disposable format needs no semantic host
   migration. Rehearse against a copied host and only deploy with Joe's go-ahead.

## Verification

- Exact state identities, bucket shapes, values, and iteration order survive a
  fresh-process round trip, including large records and integer-like keys.
- Warm, restored, and fully replayed sidecars return identical answers, objects,
  decisions, and evidence for edits, concurrency, open choices, and resolution.
- Shared records are loaded and decoded once per restore, without expanding
  repeated subgraphs. Unchanged records are not rewritten on incremental saves.
- Restoring an older cached basis avoids replay of that cached prefix; later
  uncached entries still replay correctly within the existing retry budget.
- Missing/corrupt records, incompatible formats, crashes at publication steps,
  and interrupted collection fall back safely or preserve a usable checkpoint.
- Cache reads/writes never mutate accepted objects or accepted receipts. Wiping
  the cache changes performance only, and the main object collector remains
  independent of cache retention.
- Run affected checks for the implementation and record measured size, cold and
  warm latency, replay counts, memory, and save throughput before rollout.

## Boundaries

This is independent of [object-store packing](001-pack-object-storage.md).
It changes private cache representation and reuse, not merge semantics, accepted
object encodings, semantic state identities, or history retention. Compression
alone is a benchmark baseline; direct shared-state restoration is the intended
way to reduce both repeated bytes and reconstruction work.
