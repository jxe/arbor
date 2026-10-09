# Shared merge checkpoints

The private cache in `--cache DIR` stores computed merge states, not accepted
history. canopyd's object store remains read-only to the sidecar. Deleting the
cache changes performance only; no receipt, authored change, accepted root or
merge rule changes with this format.

## Representation and publication

`records-v1.sqlite` contains checkpoint manifests, content-addressed state
records, compressed record packs and compressed binary cache-only objects.
Persistent map branches, ordered object members, arrays and long strings are
shared by record hash within and across checkpoints and trees. Small scalar
values stay inline. Encoding-record hashes are distinct from semantic state
identities. The codec preserves bucket shape and object iteration order,
including integer-like keys, and recomputes semantic identities on restoration.

Packs hold approximately 1 MiB of uncompressed records before gzip compression.
An indexed database amortizes filesystem and compression overhead across small
records. Frozen values and persistent branches have weakly memoized encoding
identities, so an incremental save need not traverse or rehash unchanged state
branches. Binary objects are verified and stored once, without snapshot base64.
Object dependency discovery visits each shared in-memory value once per save;
presence checks against the accepted store run in batches of 64.

Dependencies and the manifest publish in one SQLite transaction. A failed save
leaves the preceding checkpoint intact. Reads use a transaction snapshot;
writers and collection serialize with immediate transactions. External writes
invalidate a writer's encoding memo before its next publication. Collection
marks the records reachable from retained manifests using a sequential scan of
compressed packs and a compact adjacency index. It deletes unreachable records
and objects, drops empty packs and repacks groups with at least 25% dead records.
SQLite reuses freed pages; the database's allocated size can retain its previous
high-water mark. Restore keeps at most 16 MiB of decompressed packs, plus the
hydrated state graph and decoded cache-only objects.

The database filename and manifest format version isolate incompatible codecs.
Legacy `<tree>/<entry digest>.json` checkpoints remain readable. A successfully
published replacement removes its matching legacy duplicate; superseded saves
are collected through normal retention. If the database cannot open or list,
the sidecar falls back to legacy checkpoints and replay. A corrupt shared record
or missing dependency invalidates the private graph together, preventing later
saves from reusing damaged dependencies. Every record and private object is
hash-checked, every state identity is recomputed, and the restored head's root
and log decisions are checked against its accepted entry before use.

## Replay progress

The default in-memory budget remains 512 MiB; the default replay budget remains
10 seconds per question. A completed replay saves the head after 32 entries as
before. An interrupted replay saves its latest verified accepted-entry frontier
even below that threshold. If rebuilding an older authored basis after reaching
the head, it keeps the head alongside the two newest replay frontiers. Other
questions retain two checkpoints per tree. A retry can therefore continue after
memory eviction or process replacement without importing a partial state or
changing merge semantics. Publication remains after the answer; the worker
awaits it before reading the next question.

## Measurements and regression evidence

Performance 002 began on 2026-10-07 with two expanded checkpoints totaling
410.3 MiB. The earlier representation prototype compressed shared records and
cache-only objects to 26.3 MiB, but did not implement persistence or restoration.

On 2026-10-09 the iPhone's queued `todos` request repeatedly received retryable
503s while the deployed worker rebuilt an old basis. Logs showed partial replay
of about 4,200 entries followed by a restart of that same rebuild. The production
cache had grown to two approximately 354 MiB expanded snapshots. The new codec
was measured on read-only copies; live host and phone state were not modified.

The repeatable benchmark is:

```sh
bun packages/canopyd-merge/scripts/benchmark-cache.ts CHECKPOINT.json CHECKPOINT.json
```

It writes only a fresh temporary cache, verifies exact serialized state shape
and key order against each original, and launches fresh processes for cold
restore measurements. See the implementation evidence in [status](../../../status.md)
for the recorded results. Timing depends on the machine and filesystem cache;
local measurements are not a production latency guarantee.

Tests cover identical cold/warm answers with open decisions, wide buckets and
integer keys in a fresh process, interrupted replay across process replacement,
old concurrent bases with a protected head, legacy fallback, corrupt/missing
records, aborted publication, incremental sharing, collection and a second
writer's collection. The actual queued iPhone merge question was also replayed
against copied accepted objects with its original candidate bytes and identity.
It finished and retained one conflict choice. This is sidecar validation, not
proof that the live host accepted the request or that the iPhone converged.
