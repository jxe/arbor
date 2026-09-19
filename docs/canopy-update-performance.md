# Canopy update performance

September 18, 2026: accepted-prefix reuse and Native payload omission are deployed to Canopy and installed on Mac/iPhone.
That deployed change requires no schema, Wire, client, or permissions migration.
September 19, 2026: batched durable object writes, `synchronous = NORMAL`, and per-request phase logging; no schema, Wire, or client change.

## Durable writes and live attribution (2026-09-19)

Live Railway updates measured 1.1–1.6 s (median 1.4 s, p90 4.6 s) while the
same fast-forward measured 74–76 ms on a local production copy. The difference
is the cost of `fsync` on the mounted volume, not compute: durable object
publication issued three sequential fsyncs per object (file, shard directory,
parent directory), repeated them for objects that were already durable, and a
fast-forward durably stored largely the same object set up to three times
(worker persistence, preflight, acceptance). A real update adds roughly 30–90
objects, so one acceptance issued several hundred serial fsyncs. On macOS,
Node's `fsync` does not force a full flush, which is why local samples never
showed this.

`ObjectStore.store` now writes and syncs files with bounded parallelism, syncs
each shard directory and the objects root once per batch, and remembers which
hashes this process has already made durable so a repeated durable publish of
the same object issues no fsync. Ordering is unchanged: file bytes are synced
before any directory entry, and every directory entry before `store` resolves,
so the SQLite commit that follows still only names durable objects. Scratch
`stage` remains unsynced. A staged or pre-existing object is synced once on its
first durable publish and then remembered. Unit tests count fsyncs per batch:
one per new file, one per shard directory, one for the root, and zero on a
repeat.

The Canopy database now uses `PRAGMA synchronous = NORMAL` under WAL. Commits
no longer fsync individually; the WAL is synced at checkpoints. A process crash
loses nothing. An operating-system crash can lose the most recent commits but
cannot corrupt the database; because objects are synced before the commit that
names them, a lost commit leaves only unreferenced objects.

Each update request now logs one structured line (tree, status, batch size,
total and per-phase milliseconds, objects considered, files written, fsyncs)
and returns the same phases in a `Server-Timing` header. Merge worker phase
timings, previously an unused callback, feed the same record. The log is
silent under the test runner and never contains request content, subjects, or
object identities. In the unit suite, a warm fast-forward now records about
2N+1 fsyncs for N new objects (previously 3N per store pass) and the durable
acceptance store after preflight records zero.

The removed duplicate write-permission check in the update route is a small
constant saving.

### Live attribution after the first deployment

Live phase records showed the write path at about 30 ms (roughly 65 fsyncs per
edit, down from several hundred), and two remaining costs. Warm requests spent
840–1110 ms in Canopy's validation of the worker's output state, which reads
objects from the volume; the same phase measures about 10 ms locally. The
first edit after the deployment spent about 70 s verifying the retained
history of its input states cold, and requests queued behind it; this is the
source of the earlier 40 s spikes after every restart.

Two changes follow. Canopy's object store now keeps a bounded in-memory cache
of hash-verified immutable bytes (256 MB by default, `ARBOR_OBJECT_CACHE_MB`
overrides) and the merge tool reads through the same store; read counts,
bytes, and time appear in the per-request record. Retention verification now
treats a job's input states, and every durable change record, as trusted
leaves. Input states come from Canopy's own accepted records or from output
this process already validated and published, never from a client. A state's
change map names every historical change record directly, and each record
names an older base state, so trusting the inputs alone did not bound the
walk: the first cold edit after the second deployment still read 19,414
files and 406 MB in 69.5 s. A durable change record was published into
append-only storage by a job whose own retention walk verified its base, so
it is not opened again. The requested output roots are never trusted, staged
bytes are still re-read until durable, and the full integrity audit passes no
trusted set and still walks everything.

## Tree readers and watch catch-up

Reader commit `13c78de` removes repeated work from reader endpoints without a
Wire change. Object membership follows directory edges rather than reading unrelated
file bodies, shares its visited frontier across retained roots, and queries
historical roots only after the current root misses. Authorization still precedes
membership checks, nested-tree boundaries remain separate, and the requested
object is hash-checked when served. Snapshot bundles still read their complete
contents because those bytes are the response.

On the isolated production copy, an absent-object lookup across eight retained
roots fell from 920 object reads / 77,461,548 bytes / 111 ms to 19 directory reads /
60,868 bytes / 2.5 ms. This is a local sample, not a live endpoint percentile.
A synthetic 1,000-file directory needs one directory read for membership, and
100 roots sharing a directory visit that shared directory once.

Watch delivery reads bounded pages from the durable observation log under
stream backpressure, rather than loading all history or buffering notifications.
Adjacent live updates reuse stored payloads and observation cursors. A backlog
becomes one sparse transition directly from its retained accepted basis to the
captured destination. Intermediate payloads are neither read nor transmitted;
the destination's actual predecessor remains unchanged. A 513-update same-root
backlog is tested to deliver one empty payload without loading stored transitions.
Concurrent appends follow the captured cursor. Net frames may exceed the ordinary
1 MiB frame target; Native's byte-level SSE parser scans only new bytes instead
of copying and rescanning the entire accumulated frame on every byte. Net
catch-up no longer requires a query parameter now that the apps are upgraded.
See the [transport contract](update-wire-contract.md#net-watch-catch-up).
On the fresh production copy, a 100-update Todos span produced four deltas,
7,699 encoded bytes, in 6.1 ms; reconstruction matched every destination object.
This measures local payload construction, not network or device apply latency.

Accepted-update descriptor queries select only descriptor columns. Additive
indexes on accepted tree identity and observation update identity are installed
idempotently when opening existing or new schema-13 databases; no coordinated
migration is required. The column selection alone has a small measured effect
on the current production copy (its largest transition payload is about 3 KB).

Full material integrity traversal now shares its visited set across roots while
keeping file and directory roles distinct. Reading bytes as a historical file
never discharges the obligation to traverse those bytes as a later directory.
Historical semantic audits now iterate records and share freshly validated graph
edges and history-map facts within one audit. Compact retention roots use one
union traversal; legacy explicit closures retain exact equality checks. Nothing
is trusted from a previous audit. The earlier production copy audited in 5.4 s
(17,684 reads / 689 MB across material and semantic passes). Health still performs
a full audit and remains unsuitable for lightweight liveness polling.

Verification: the full product suite passed 1,111 tests with the previously
observed private-tree CLI placement failure unchanged. TypeScript checking,
CLI build, and the live TypeScript/Swift protocol gate passed. Shared vectors
cover valid net transport and invalid basis identity/root/self/null values;
Native tests cover clean net application without snapshot fetching and exact
pending-request retry when the coalesced event has no matching digest. A 1.1 MB
byte-at-a-time SSE test passed. Fresh production-copy rehearsal evidence is
retained outside the repository in `~/arbor-net-catchup-20260918/`: 7,838 objects
were hash-checked, all 17 tables remained unchanged across two restarts, and the
full integrity audit passed in 5.4 s. The archive SHA-256 is
`6b755b94e67d3d422200f41e75ab82a3db6d0f900d1d7a1b2bb8e2c974971a6c`.
Relative-link checking reports the same 29 existing/example missing targets;
`git diff --check` passes.

## Incremental state (deployed 2026-09-18)

Implementation commit `926573c` adds typed, bounded retention
certificates, keyed immutable history maps, root-based acceptance
retention records, fast-forward preflight reuse, and one persistent queued worker.
New state readers also read legacy monolithic states. There is no SQLite schema
upgrade, but old binaries cannot read the new state objects: rollback after new
writes requires a compatible reader or coordinated restoration. The update request format is unchanged.

The latency target is **under 100 ms of server processing, ideally well under**,
including validation and durable acceptance of a small fast-forward. Comparable
small concurrent merges should not take much longer. Network time is measured
separately. Local warm fast-forward samples now meet the target; live latency
and divergent-merge latency have not yet been established.

Deployment evidence: Railway deployment `95b1209a-10bd-46c9-9d5f-0ebf4c12cf32`
succeeded for implementation commit `926573c`. The operator selected local tests
and a fresh production-copy rehearsal instead of recreating the retired Hetzner
lab. The fresh backup's 4,937 immutable objects passed hash verification; all 17
SQLite tables were unchanged across two starts. Three copied-data updates were
accepted, warm samples measured 73–76 ms, and two further starts preserved the
resulting database and 7,600 objects. No benchmark edits were sent to production.

Live verification matched the worker/source hashes to the commit, passed SQLite
integrity, and confirmed root liveness, authenticated tree/permission reads, and
anonymous private-tree denial. The existing `/.arbor/health` endpoint runs a full
historical integrity audit and exceeded a short request timeout; it is not a
lightweight readiness check. Railway checks `/`, which passed. Full-history audit
cost remains separate work.

On an isolated production-data copy, a one-byte fast-forward initially took
about 800 ms warm after removing duplicate preflight evaluation. Its worker read
approximately 10.7 MB and took about 400 ms. A CPU profile attributed about
260 ms to state serialization. Bounded size checks and a decision-free
fast-forward path reduced worker execution to about 180 ms; subsequent complete
requests remained around 0.6 seconds. These are diagnostic samples, not latency
percentiles; some later samples overlapped test execution. No benchmark writes
were sent to the live tree.

A subsequent pass separated validated graph proofs from durable availability.
Proofs remember staged dependencies and re-read those bytes until they have been
observed in durable storage. Retention also consumes the already decoded semantic
state, including all chunks read to reconstruct it. Missing/discarded staging,
corrupt overlays, cache eviction, and file-versus-metadata type checks remain
covered. On the same evolving production-data copy, warm diagnostic samples then
measured 416–430 ms, with retention totaling about 35 ms. Worker process time
remained about 250 ms and semantic state validation about 80 ms; the target is
still unmet. These caches remain process-local and do not solve cold startup or
whole-state execution.

The next pass introduced indexed history maps and an incremental execution path
for exact-basis `editSource` operations using basis references, with no lineage,
alternative bindings, resolutions, or existing decisions. It loads current
material and the relevant identity keys, executes the edits, and path-copies only
changed history buckets. Snapshot/imported states first use the full evaluator
to establish that retained deletions have already been applied. Other operations
and divergent merges retain the full evaluator.

Differential tests compare complete retained-state hashes with full execution,
including replacements, deletions, Unicode, and intervening snapshot barriers.
Increasing unrelated change history from 100 to 10,000 adds fewer than ten
worker reads; tested input bytes remain below 50 KB for the small test document.
On the production copy, worker execution fell to 83–87 ms, but still read about
9.8 MB of current material. Complete request samples were 333–345 ms.

Canopy now uses the existing sequential `serve` mode through one bounded FIFO
queue. There is no worker fan-out. Validation and staging cleanup finish before
the next queued job starts. A crash or timeout fails that job, reaps its worker,
and lets the queued successor start a replacement. Queue wait is separately
instrumented. Custom commands retain one-shot mode unless explicitly configured
for persistence; they also execute sequentially.

Warm production-copy requests with the queued worker measured 256–274 ms; the
worker round trip was 57–63 ms and Canopy semantic validation about 114 ms. The
first request after opening the process still took about 5.1 seconds, dominated
by cold retained-history verification. These are local diagnostic samples, not
production percentiles. Neither cold nor warm acceptance meets the target yet.

History validation now caches immutable semantic proofs by content hash, record
schema, and radix position. New branches and records use the existing schema and
retained-node identity checks. Current material projection and decisions are
still validated. Cache hits report every dependency to the separate retention
check; a prior uncommitted job cannot certify missing or corrupt staged objects.
The history cache has a conservative 64 MB accounting limit; eviction changes
cost, not validity. Full integrity audits remain uncached.

On the same evolving production copy, warm validation fell from about 114 ms to
41–44 ms, object reads from approximately 2,300 to 596, and complete requests to
210–217 ms. The first attempt with a 16 MB cache repeatedly evicted this working
set and provided no benefit. Cold processing still takes about five seconds.
These are local diagnostic samples, not production percentiles, and the target
remains unmet. Tests compare cached/full states and dependency sets, enforce
schema-role and radix-position isolation, exercise eviction and byte budgets,
and reject missing staged dependencies despite semantic cache hits.

### Structural diagnosis and fixes

A synthetic one-file append sequence exposed quadratic expanded history: 128
edits retained 16,640 piece occurrences, while 256 retained 66,048. Each effect
had serialized complete before/after piece arrays. Large history records now
use `arbor-state-record-v2` references to shared immutable JSON/sequence pages;
small records and old inline records remain readable. In the diagnostic,
unique state bytes read for 128/256 edits are approximately 0.71/1.49 MB instead
of 2.87/10.80 MB. The logical expanded view remains available to existing merge
algorithms, so full-history reconstruction still has its old CPU/memory cost;
ordinary validation carries record-level dependency summaries forward instead
of rescanning every historical piece occurrence. No live history was rewritten.

Projection builds a parent-to-children index once per walk instead of filtering
all nodes for every directory. Authority validation compares file nodes with the
preceding validated state and reprojects changed files. Result proofs stay
attached to the evaluation through acceptance, independently of cross-request
cache eviction; the new head takes precedence over its former input in that
optional cache. Validation no longer serializes all history merely to estimate
cache weight.

Graph validation inherits unchanged object structure from the server's accepted
Merkle graph and reads changed paths. A regression with 10 versus 1,000 unrelated
subtrees reads exactly three objects for the same nested file change. Kind and
collection-schema checks remain, including reclassification and corrupt-overlay
cases. The redundant material reachability pass before semantic retention is
removed. The old 100,000-object/1-GB tree quota checks are removed from update
acceptance; periodic storage accounting/fsck is deferred. Decoder/execution work
budgets remain separate from those removed storage quotas.

Retention now keeps the closure established by its walk instead of constructing
several overlapping closures again. Typed edges remember semantic validity
separately from durable availability; the new change envelope is visited early
to reach the preceding state before exploring historical branches. A 64-update
regression verifies bounded new reads and preserves staged-object rechecks.

Warm production-copy samples after these changes measured 103–110 ms overall,
about 10 ms semantic validation, and about 5–6 ms for output retention.
A final sequential run measured 106–109 ms with the same read count. There were
287 Canopy object-read calls (worker reads are separate), down from about 596.
Remaining work includes active-state metadata and worker material reads, durable
writes, and expanding the incremental evaluator beyond its exact-basis source
edit case.

The worker now reads shared storage first and consults staging only when an
object is absent; corrupt shared bytes still fail validation. Disposable staging
uses atomic publication without fsync. Accepted storage remains durable before
the acceptance transaction commits. The worker API and Wire are unchanged.

Within an exact-basis source-edit job, the worker reuses unchanged file
projections and captures only the targeted
node for each operation's before/after effect. Differential tests compare
multiple edits and their effects against full evaluation.

Instrumented warm worker time fell from 53–57 ms to 44–47 ms. A final run without
the worker profiler measured 92–97 ms end to end on the production copy, with
287 Canopy object reads. This is a small local fast-forward sample, not a
deployed latency guarantee or a divergent-merge measurement. The worker still
previously read roughly 9.8 MB across 300 reads to validate its starting basis.
The subsequent trusted-basis change removes that repeated validation: state/root
pairs supplied by Canopy are already validated, with no optional assertion or
untrusted-input fallback in the fast-forward path. The worker recovers unchanged
file hashes from directory metadata, reads bodies only as needed for the edit,
and still checks selectors, referenced bytes, and the complete candidate root.
The full evaluator remains for operations outside the incremental path.

Final sequential measurements after that change were 74–76 ms end to end,
with 28–29 ms in the worker. Instrumentation recorded about 0.24 MB across
210–211 worker reads, versus about 9.8 MB across 300 previously. These remain
local production-copy fast-forward samples. Directory/active-state metadata,
scratch publication, and Canopy output validation remain measurable costs.

Reproduce the synthetic growth diagnostic with
`bun tests/performance/merge-history.bench.ts`; it uses only in-memory generated
fixtures. Full-history logical sizes in that output are intentionally distinct
from unique validated bytes in the shared representation.

Verification after the structural and worker changes: 1,091 TypeScript tests passed; the previously
observed private-tree CLI placement test still failed. All 34 merge-tool tests
passed, including FIFO order, one-process reuse, discarded staging, crash and
timeout recovery, queue bounds, and shutdown. TypeScript checking, the CLI build,
and the live TypeScript/Swift protocol gate passed, including editor recovery,
copy, undo, redo, and restart against a disposable Canopy. Relative-link checking
found the same 29 existing/example missing targets; whitespace checks passed.

Remaining work is structural:

- Avoid reconstructing complete history maps after reusing validation proofs.
  Extend incremental execution to the remaining operations and divergent merges,
  preserving exact full-evaluator behavior.
- Reduce remaining active-state metadata and worker reads for a small edit.
- Reduce repeated dependency work across warm acceptances without confusing
  semantic validity with the durable presence of staged objects. Cold startup
  optimization is deferred: server and worker restarts are expected to be rare.
- Measure fast-forward and divergent merge separately at multiple history
  sizes, cold and warm, including objects/bytes read and written and durable
  commit time. A warm cache alone is not evidence of history-independent cost.

Compact Wire continuation has been deferred. Ordinary updates usually contain
only one or two unacknowledged edits; the priority is whole-state execution,
not a new request representation. The existing accepted-prefix optimization
remains in place.

The remaining sections describe the earlier deployed prefix optimization.

Native sends an authored chain whose prefix may already be accepted. Canopy
previously re-evaluated that prefix whenever a new suffix was present, even though
exact whole-request retries already used receipts. Each evaluation also verifies
retained history, so one new edit became more expensive as the chain grew.

Preflight now uses the credential-bound exact-prefix receipt and its durable
`accepted_merge_states` record to resume from the **authored** candidate state.
It does not substitute the merged accepted projection. Current write access is
still checked, and new suffixes still receive complete preflight and acceptance
validation. Unchanged receipts that refer to a different change, and historical
records without matching authored state, retain the evaluation fallback.

## Production-copy measurement

An isolated schema-12 snapshot at accepted update 2619 was advanced with five
real authored updates. Identical copies then received those five accepted updates
plus the same sixth update, using Bun 1.3.14 on the local Mac:

| Measurement | Before | After |
| --- | ---: | ---: |
| Request duration | 15.58 s | 6.15 s |
| Merge evaluations | 7 | 2 |
| Object reads in Canopy | 38,371 | 14,068 |

The final accepted ID, root, conflict flag, and request digest matched exactly.
These are local timings, not a production latency promise. Native's live logs
before the fix recorded 79- and 85-second requests with 18 and 19 updates.

Regression coverage exercises merged-prefix continuation after a restart, rejects
any attempt to execute an already accepted source prefix, and verifies that the
new suffix preserves independently created entries. Legacy snapshot-prefix
fallback, hidden candidates, guarded retries, and whole-request replay retain
existing coverage.

## Native transport

When preparing a new request, Native retains the full authored identity chain but
omits object envelopes and deltas for changes already recorded as accepted in its
durable control state. It does not rewrite a persisted in-flight request, discard
local recovery objects, or substitute the accepted projection for an authored
basis. Payload envelopes are excluded from semantic request digests.

Applying this omission to a captured 24-update request with 23 durably acknowledged
changes reduced encoded JSON from 1,956,714 to approximately 91,322 bytes. Exact
encoding varies; the remaining object payload belongs to the new edit. The queue
and coordinator tests cover unchanged digests, restart, and hidden-candidate
continuation; the HTTP test also submits a prefix without its object payload.

## Remaining cost

New evaluations still walk retained history repeatedly. One read-only check of
the snapshot's latest retained closure read 4,507 objects totaling 226,806,214
bytes. Optimizing this requires preserving closure validation, hidden material,
and corruption detection; this change does not introduce a cross-request cache
or skip validation of new worker output.

One newly accepted state in the production-copy replay occupies 1,209,489 bytes,
with 127 nodes, 64 effects, and 1,039 change entries. Its acceptance record occupies
347,153 bytes with 4,539 dependency hashes. These are retained-state sizes, not
necessarily unique bytes added: accepted and authored hashes can be identical.

The next structural work should target new-edit cost proportional to changed
material: separately address immutable history entries and effects, share unchanged
state structure, and retain verified dependency edges incrementally. A compact
continuation reference would allow clients to name a previously accepted authored
candidate without resending its entire intent prefix. That is a Wire change and
must preserve tree/credential binding, replay identity, historical authored bases,
and restart behavior in both languages. Full-history integrity auditing remains
separate from ordinary new-output validation. No such format change is made here.

## Verification

The live TypeScript/Swift protocol gate passed, including real editor recovery,
copy, undo, and restart against a disposable Canopy. The 97-test Swift working-tree
suite passed, as did focused source replay tests, TypeScript checking, and the CLI
build. The full product suite passed 1,027 tests with the previously reproduced
private-tree CLI placement failure remaining. Relative-link checking found only
existing/example targets; whitespace checks passed. Native diagnostic logging
remains enabled; these performance changes were installed and deployed with the September 18 permissions cutover.
