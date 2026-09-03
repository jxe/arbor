# Canopy storage 001: Pack retained objects and accepted history efficiently

## Status

- **Priority:** P2
- **Effort:** XL
- **Risk:** HIGH — packing and pruning can make a retained root unreconstructable
- **State:** NEEDS BASELINE AND DESIGN REVIEW
- **Depends on:** no product milestone; promote implementation only after
  representative Canopy data shows material storage, inode, startup, integrity,
  or transfer cost

## Target result

Canopy keeps the same content-addressed object hashes, accepted update IDs,
per-tree observation order, previous and target roots, transition payloads, and
Wire behavior while storing retained data substantially more efficiently.
Loose objects remain a safe ingestion format; background maintenance may pack
immutable objects and transition payloads into indexed files with bounded
delta chains and periodic full bases, similar in spirit to Git packfiles.

The physical encoding is private Canopy state. A hash continues to identify
canonical object bytes, not a pack entry, compression choice, or delta.

## Trigger and scheduling model

Every successfully committed accepted update is a cheap opportunity to check
maintenance state, but the request must not perform or await packing. After
the accepted update and its observation are durable and the response can be
returned, Canopy increments approximate loose-object count and byte counters
and asks one process-local maintenance coordinator whether work is due.

Start a loose-object pack when any configured limit is crossed:

- the number of loose objects;
- the total bytes held as loose objects; or
- the age of the oldest loose object, so a low-traffic Canopy eventually packs
  without needing another burst of writes.

Start pack consolidation when either the number of packs exceeds its limit or
their object counts no longer form the configured geometric progression. As
with Git's geometric repacking, combine the smallest recent packs needed to
restore the progression and avoid repeatedly rewriting the largest historical
pack. Freeze initial thresholds only after the baseline in step 1; keep them
operator-configurable and expose the observed values in diagnostics.

A startup check and a periodic idle check provide recovery and low-traffic
fallbacks. At most one maintenance run may be active. New accepted updates may
request another pass, but they neither start overlapping writers nor wait for
the current pass.

## Railway execution

The reference Railway deployment runs maintenance within the one long-lived
Canopy service that exclusively owns its persistent `/data` volume and SQLite
database. Do not add a second Railway service, cron deployment, or replica that
opens the same state. The supported reference topology remains one Canopy
replica per volume.

The service schedules maintenance only after the accepted-update response is
no longer dependent on it. CPU-heavy compression may run in a bounded Bun
worker, while one process-owned coordinator controls filesystem publication,
generation selection, and cleanup. Apply explicit CPU, memory, I/O, batch-size,
and elapsed-time budgets so maintenance yields to request traffic and can
continue in later passes.

Railway may terminate the process during a deployment, restart, or resource
event at any point. Every pack generation is therefore resumable or safely
discardable from durable state alone; correctness must not depend on an
in-memory job queue or graceful shutdown. Startup selects only a completely
written, fsynced, atomically published, and verified generation, then removes
or resumes abandoned temporary work under the same single-writer lock.

Before building a generation, estimate peak temporary disk use and require
enough volume headroom for the new pack plus the still-active old generation.
Insufficient space defers maintenance with a diagnostic; it must not endanger
accepted updates or delete the previous generation.

## Work

1. Measure representative and synthetic Canopies: total bytes, loose-object
   count, filesystem overhead, duplicate transition bytes, complete-snapshot
   latency, object-read latency, integrity-check cost, and backup/restore cost.
   Record the threshold that justifies implementation.
2. Specify one crash-safe pack and index format with versioning, checksums,
   bounded entry and delta sizes, bounded delta depth, full bases/checkpoints,
   and deterministic validation. Corrupt or unsupported packs fail closed.
3. Implement the trigger counters, one maintenance coordinator, startup and
   periodic checks, geometric pack selection, and bounded execution described
   above. Prove that accepted-update latency and success do not depend on the
   maintenance run.
4. Put loose and packed reads behind `ObjectStore` without changing callers.
   Prefer loose objects during ingestion and permit an atomic background
   compaction step to publish a complete pack/index generation.
5. Keep the old generation until the new generation and every retained root
   verify. Interruption before the generation switch must leave the prior
   store readable; interruption after it must leave one complete selected
   generation and recoverable unselected files.
6. Define reachability and retention from current refs plus every explicitly
   retained accepted root. Pruning may remove neither a required full base nor
   any delta dependency. Request-digest replay and watch replay must retain
   their promised windows independently of object packing.
7. Decide whether accepted transition payloads belong in SQLite, in a separate
   packed log, or reference packed object entries. Preserve transactional
   correspondence among accepted updates, observations, and replayable
   transition data.
8. Add offline verify, repack, backup, restore, and rollback tooling. A backup
   is accepted only after SQLite, selected pack generations, loose objects, and
   all retained roots pass an end-to-end integrity check.

## Verification

- Existing Wire, Canopy, synchronization, retry, observation, and migration
  suites pass unchanged at the public boundary.
- A fixture can be read identically from all-loose, mixed loose/packed, and
  fully packed stores.
- Fault injection at every pack write, fsync, rename/generation switch, and
  prune boundary preserves the last verified generation.
- Corrupt indexes, pack entries, deltas, bases, and checksums are detected
  before bad bytes are returned.
- Repacking is idempotent, concurrent readers remain safe, and a retained root
  never becomes incomplete.
- Threshold checks do no graph walk or pack work on the accepted-update request
  path; packing starts after the response and never overlaps another run.
- Railway restart fault injection throughout packing proves startup selects the
  last complete generation and accepted updates remain readable.
- Low-traffic age checks eventually pack old loose objects; high-traffic runs
  respect resource budgets and do not cause health-check or request failures.
- Insufficient volume headroom defers packing without deleting loose objects or
  the selected pack generation.
- Benchmarks show the accepted improvement against the recorded baseline; if
  they do not, keep the loose-object design.

## Non-goals

- Changing object hashes, canonical encodings, update IDs, or Wire formats.
- Exposing accepted history or historical objects to clients.
- Making storage packs synchronize between Canopies.
- Adding a general storage-plugin framework, production HA, or a retention
  subsystem unrelated to the measured packing problem.
