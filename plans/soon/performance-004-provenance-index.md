# Performance 004: a provenance index kept at acceptance

**Why and when:** Joe chose this on 2026-10-21 instead of Performance 003, and moved it to soon on 2026-10-28. After the
iPhone's catch-up on 2026-10-09 took about five minutes to rebuild some 4,200 entries,
Performance 003 set out to make replay cheaper and rarer (more checkpoints, less
work per entry). This plan removes most replay. overstoryd already works out
which bytes every fast-forward inserted and removed (to check the trace) and then
throws that away; the sidecar recomputes it later by replaying each entry. Instead,
every acceptance leaves a **provenance index** behind: for each file, which change
and operation inserted each run of its bytes. The engine reads the index for the
states it needs instead of rebuilding them, and line provenance (History 006)
reads the same index for exact blame. It replaces Performance 003, whose deployed
first steps are in [status](../../status.md#historical-catch-up-improvements--2026-10-09).

Evidence, 2026-11-01: after a redeploy, the first change to the Telocracy tree
waited about 30 seconds: the sidecar's in-memory history was gone, and loading the
saved state for 1 of 22 entries used its whole 10-second replay budget, so the host
answered "retry to continue". Every deploy makes each tree's next change slow this
way until this plan lands.

## Status

- **Effort:** L
- **Risk:** HIGH. It adds to the sidecar contract (log entry, question, answer), and
  two programs must agree exactly on piece semantics: if overstoryd's index ever
  differs from what the engine would have computed, later merges go wrong with no
  error.
- **State:** Steps 1 to 5 done and deployed (2026-11-01/02, below); open
  choices settled as decision 6. Left: canonical contribution order, step 6.
- **Depends on:** nothing. History 006 should build on it (see below).

## What the engine keeps late

The engine's state per entry (`IntentState` in
`packages/overstoryd-merge/src/intent-model.ts`; kept as persistent hashed maps in
`retained-state.ts`) is one provenance model of the whole tree, shared by every
format rule. The rules themselves keep nothing.

- **Nodes:** stable identities for files and folders that survive renames and moves.
- **Pieces:** each file as a piece table; a piece names its `origin` (the change and
  operation that inserted it, or an imported node), its start within that origin,
  and the object and offset its bytes are in.
- **History maps:** `outputs`, `effects`, `origins`, `alternatives` and `changes`,
  one record per operation.
- **Decisions.**

A fast-forward (accepted by overstoryd without a question) is only `moveSource` and
`editSource` over basis material, plus `addEntry` of a new name: what
`checkPlainTrace` in `packages/protocol/src/updates/source-trace.ts` executes through
`executeExactSourceEdits`. Executing those operations already computes, per file, the
ranges removed and the bytes inserted, which are exactly the piece edits. The
sidecar learns of a fast-forward only when a later question walks past it, and then
replays it into all of the above.

## Target result

- Every accepted entry has a provenance index: nodes (path to node identity) and
  each file's pieces, stored as content-addressed objects with structural sharing,
  so an entry writes only records for the files it touched and their ancestors,
  as a root does. Old entries without one are still answered by replay.
- overstoryd writes the index itself for every fast-forward, through one pure module
  in `@ovst/protocol` that the engine also uses for its piece edits. One
  implementation of piece semantics, not two that must agree.
- For a sidecar-asked entry, the answer carries the index of the accepted root.
  overstoryd checks its closure as it checks roots and stores it.
- The engine loads the index for `base` and `head` lazily, per path a question
  touches. It builds the history records it needs (effects for undo and deletion
  enforcement, outputs, origins) only for the files and operations the question
  reaches, from the index difference and the traces in the log, not by replaying
  every entry.
- Line provenance becomes a lookup: the current file's pieces name their origins,
  each origin names a change, and each change names its accepted update.

Carry over Performance 003's targets, measured the same way (fixed host CPU and
memory, filesystem-cold and process-cold runs separate, the real client retry
schedule included):

- Warm merge of a returning device's request: p95 below 1 second.
- Empty private cache, the incident-sized 4,200-entry workload: no more than 30
  seconds end to end, and at least 10 times less active reconstruction than the
  baseline. With the index, the aim is that history length does not matter at all.
- At fixed document and edit size, growing unrelated history from 1,000 to 10,000
  entries changes median work per edit by at most 2x.
- Fast-forward acceptance stays under its 100 ms server target on Railway. Index
  records go into the same object write as the root; count added fsyncs and
  bytes.

Preserve everything Performance 003 preserved: original request and change
identities, exact bytes, attribution, operation lineage, conflict alternatives and
resolution semantics. Accepted history stays the authority; nothing replaces a
missing state with today's snapshot, skips unproved history or prunes it.

## Decisions (freeze first)

**Principle (Joe, 2026-11-01): the format overstoryd and the merge tool share must
be really robust and as simple as possible.** The merge tool itself can be
rewritten; the shared format outlives it. So the shared index holds only facts
any merge engine needs and overstoryd can compute exactly (which node each path
is, and which change and operation inserted each run of bytes), with no engine
data structures in it. Anything else an engine wants, it keeps in its own
private, discardable cache, as the saved checkpoints are today.

- The format belongs to overstoryd, not the engine: specified with the protocol,
  written by one shared module, with conformance tests a rewritten merge tool can
  check itself against.
- It holds only facts that follow from the accepted bytes and traces, nothing a
  merge tool decides.
- It is versioned, one meaning per version: no optional fields whose absence
  means something.
- It fits on one page. If a measurement would push it past that (copy and move
  lineage, say), the default is to leave that out and let the engine work it out.

1. **Where the index lives.** Recommended: beside history, not in it. An
   index is derived: replay over the same entry produces the same object. So it
   is a cache, not a fact of history. Store it beside the entry, keyed by the
   entry's hash and an index format version, and do not chain it into the entry's
   hash. A wrong or outdated index can then be deleted and recomputed, and the
   format can change later without touching accepted history (history is never
   rewritten, so an index chained into it would make any format mistake
   permanent). The sidecar finds it by the entry it already reads; the contract
   change is only "an entry may have an index of version N", recorded in
   [writing a sidecar](../../docs/architecture/overstoryd/writing-a-sidecar.md) and
   `@ovst/merge-protocol`. What the entry's hash no longer covers is made up by
   overstoryd's closure check on what the sidecar returns and by sampled
   differential checks against replay (Verification).
2. **What the index holds.** Nodes (path to node identity) and each file's pieces,
   which is the engine's own model saved instead of rebuilt. Whether copy and move
   lineage (`origins`) belongs in it is **decided by measurement, not up front**:
   step 1 computes, on a production copy, how often questions need lineage, what
   deriving it from traces costs per question, and what storing it costs per
   entry (records written, bytes, and the effect on the 100 ms fast-forward
   target). Put it in the index if deriving it would keep history length
   mattering; otherwise leave it engine-derived. By the principle above, the bar
   for putting it in the shared format is high: if it goes anywhere, the engine's
   private cache comes first.
   **Measured (step 1): engine-derived.** A question reads 7 lineage records
   typically (p95 62), each derivable from one `editSource` and its basis's
   pieces, and no answer changed without lineage at all.
3. **Encoding: records shaped like the tree** (Joe, 2026-11-01). One record per
   folder mirroring the directory, so an entry writes only the files it touched
   and their ancestor folders, sharing everything else as roots do.
4. **Long piece lists are chunked** (Joe, 2026-11-01). A file edited many times
   fragments into many pieces, and a single record per file would be rewritten
   whole on every edit. Split a file's piece list into content-defined chunks,
   like collection `rows` (step 6), so an edit rewrites only the chunks it
   touches. Step 1 measures piece counts on the most-edited real files to set the
   chunk size.
5. **Entries from before the index.** No backfill migration. The sidecar's first
   replay over an old entry writes its index, so coverage grows on its own; an
   index computed by replay is the same object overstoryd would have written.

6. **Choices continue from what the log records** (Joe, 2026-11-01, over
   keeping choice detail in the engine's cache and replaying from where a
   choice opened, or putting choice material in the shared format). Every
   state the engine needs is the index plus the entry's decisions as the log
   records them: a range choice's placement is its recorded range on that
   entry's root, and its identity is the index's pieces there. The engine's
   cache is then only about speed. Answers need to resolve right, not
   identically to the old engine (Joe). This is also what
   [Merge 015](merge-015-resolve-reconciled-choices.md) traces through later
   edits: the range from the log, the identity from the index.

## Step 1 results (2026-11-01)

Measured on the 2026-10-28 production backup (`.backups/railway/20261028T180216Z`),
todos tree `tr_owozr6aegt5z7x6qyllvzljl5u`: 9,561 entries, of which 8,954 are
fast-forwards, 538 asked on the head, 28 asked on an older basis (window up to
128 entries, p90 42), 38 asked snapshots. Scripts are in
`tests/performance/provenance/`; a probe hook (`historyProbe` in
`retained-state.ts`) records which history records an evaluation reads.

**What questions read.** Every history read of every asked question falls into
one of: the incoming change itself, changes accepted between the question's base
and head (the window), or lineage (`origins`) of pieces in files the question
touches. Old-basis questions also read thousands of old `effects` and `changes`
records, but only because `since()` compares two whole maps point by point; the
records it returns are the window's.

**Answers from the index alone.** Each asked question was answered again by a
fresh sidecar whose states at or before the base held only nodes and pieces
(every history map emptied); window entries were replayed from there.

| States at the base | Same as full history | Differ |
| --- | --- | --- |
| Nodes, pieces, engine's decisions | 597 of 604 | 7, contribution order only |
| Nodes, pieces, decisions imported from the log entry | 595 of 604 | the same 7 by order; 2 (updates 12002, 12003) where an open choice's alternative gains one contribution |

- Full-history replay itself differs from the accepted entry on 15 questions
  (engine drift since acceptance; replay aligns to the entry). The index-only
  runs differ from history on exactly those.
- Contribution order inside a choice follows the history map's bucket order,
  an implementation detail. The engine must sort contributions canonically
  (acceptance order) before the index path can give byte-equal answers.
- **Open choices.** An engine-retained choice carries detail its log record
  lacks (alternative nodes, contexts). 238 of the 604 questions start with
  open choices (5 distinct choices in the tree's history, open at most 109
  entries). Rebuilt from the log, 2 answers (updates 12002, 12003) first
  differed: an edit far outside a choice's range counted as continuing it,
  because the imported selected alternative had fresh pieces of its own.
  Fixed on the branch: it now holds the file's own pieces in its range. See
  decision 6.

**Lineage (decision 2).** 111 of 308 questions on the full evaluator read
lineage: 7 records typical, p95 62, max 133, up to 2,087 entries old.
Answers without any lineage were the same as with it in all 604 questions.
Every lineage record comes from one `editSource` operation and its basis's
pieces, so the engine can derive it from the index and the log (about four
object reads each). Recommendation: leave lineage out of the shared format;
the engine derives and caches it.

**Index size and cost** (tree-shaped records, piece lists in content-defined
chunks of about 32 pieces):

- Pieces per file stay small: the most-edited file (`/_index.md`) peaked at 708
  pieces; the whole tree now holds 1,947 pieces in 121 files. Chunks of about
  32 pieces mean a typical file is a few chunks.
- Per accepted change: 3 new records (p95 5, max 19), 11.9 KB (p95 24 KB,
  max 80 KB) before compression, written in the same batch as the root, so no
  added fsync.
- All 9,561 indexes: 30,856 records, 123 MB as loose JSON, 3.1 MB in
  zstd frames of 1 MiB as packs store them (today's object store: 49 MB, 32 MB
  of it packs). Folder records, not pieces, are most of the bytes; interning
  origins and objects saves only 18%.
- Recomputing every index by replay: 12 to 20 minutes for this tree on a cloud
  machine.

**Other findings.**

- Old-basis questions are slow in evaluation itself, not in replay: updates
  6657, 6658, 8670, 8671 and 11926 take 23 to 83 seconds with any state, more
  than the 20-second budget, so a cold rebuild of this tree on today's engine
  fails at update 6657. The index does not fix this.
- 37% of asked questions reach lineage, but a typical question reads 7 records.

**Step 2, first part (2026-11-01).** `packages/protocol/src/updates/provenance.ts`
holds the index's piece semantics: `importProvenance`, `advanceProvenance`
(a plain frame) and `rebindProvenance` (a snapshot or property trace). A piece
is only `(origin, start, length)`; its bytes are the file's at that root.
Hand-checked cases and language-neutral vectors
(`docs/overstory-spec/conformance/provenance.json`) also check the engine
reaches the same index. Over the production copy
(`tests/performance/provenance/differential.ts`), the module's index equals the
engine's on 8,947 of 8,954 fast-forwards. The other 7 are move-heavy entries
the engine's replay could not follow, so it aligned to the root and lost the
file's whole history to one snapshot piece; the module's pieces hold exactly
the root's bytes in all 7. Rebuilt from the index and the log after the
imported-choice fix, 597 of 604 questions answer as full history does, the
other 7 differing only in contribution order.

Remaining in step 2: the engine's own operation executor still computes
pieces separately (`apply`); it moves onto the module when the engine reads
the index (step 4), since the engine's pieces then lose `object`/`offset`.
Until then the vectors' engine check and the differential guard agreement.

**Step 3 (2026-11-01).** overstoryd writes each entry's index in the entry's
own object batch, then its pointer file (`ProvenanceStore`,
`packages/overstoryd/src/updates/provenance-store.ts`): fast-forwards,
snapshots and property traces computed from the previous entry's index
(`entryProvenance`), an asked entry from its answer, which now carries
`provenance` (the sidecar's `stateProvenance`). A failure to compute never
fails the entry. A background backfill from startup fills missing indexes
(asking the sidecar again for answered entries within 128 of the head,
rebinding older ones); `OVERSTORYD_PROVENANCE_FILL=0` turns it off. The
collector keeps every retained entry's records. On the production copy
(`tests/performance/provenance/backfill.ts`), a cold backfill of the todos
tree's 9,561 entries takes 52 seconds without the sidecar (64,334 records
written), and a warm writer computes an entry's index in 2 ms (7 records,
13.7 KB). Not deployed.

**Incident (2026-11-01, 18:16 to 19:29).** Step 3's first deploy re-asked the
single merge worker old questions from its backfill; they ran past the 45 s
worker timeout, so merges were refused, and the worker's saved states were
evicted (two kept per tree). baeed27 took the sidecar's part out and made
the backfill index answered entries as snapshots without the worker; an
out-of-band catch-up (`/mnt/project-files/perf004/todos-merge-catchup.sh`)
rebuilt the todos states. Background work must never use the merge worker.

**Step 4, first part (2026-11-01).** A cold sidecar starts a question's
basis from its entry's index (`indexedIntent`, aligned to the entry's
decisions from the log) when nothing cached or saved is within 128 entries,
and replays only the entries after it. Rehearsal
(`tests/performance/provenance/rehearse.ts`): every one of the 604 asked
todos questions on the 2026-10-28 copy, each by a fresh sidecar with nothing
cached or saved, under the live budgets, with the indexes the backfill
writes (answered entries rebound): 591 answer as accepted. The other 13 are
the cases full history also misses: 7 answered as today's engine answers
with full history, 6 over the evaluation budget with any state. Median 92 ms
per cold question, p95 468 ms; no question needed a retry. Answers need not
carry their index.

**Step 4, rest (2026-11-02).** After a restart the live helper restored a
checkpoint 75 entries back and replayed through a 12.8 s entry, so the first
merge took a retry. Joe: why ever replay? Now:
- The sidecar starts an entry from its index unless a cached state is within
  8 entries, and a head replays only the entries after its basis, starting
  the head from its index if that runs past `OVERSTORYD_MERGE_REPLAY_MS`. No
  "retry to continue", no saved checkpoints (`merge-cache/`, the checkpoint
  store and its save rules are gone), and an index overstoryd lacks is
  computed by the sidecar as the backfill computes it.
- Answers carry their index (`stateIndex`, the inverse of `indexedIntent`),
  so merged entries keep the engine's lineage; overstoryd stages the carried
  records instead of storing them with the entry.
- Index records and pointers are staged without fsync (the index is a
  cache; fsyncs per fast-forward back from 13.4 to 7.5,
  `tests/performance/provenance/fsync-count.ts`).
- A cold question's reads (about 280 index records and 155 tree objects)
  run concurrently: 1.1 s to 0.18 s at 2 ms a read
  (`tests/performance/provenance/cold-reads.ts`).
- Rehearsal with no replay at all on the Oct 28 copy (answered entries'
  indexes rebound, the worst case): 591 of 604 as accepted, median 57 ms,
  p95 109 ms. So past entries' indexes need no rebuild.
- overstoryd writes nothing for a request before acceptance, and an accepted
  update's new objects are appended to one object journal (a growing pack):
  one write and one `fdatasync` per fast-forward instead of 7 to 9 file and
  directory syncs (the deployed 64aa8f7 only moved that cost from preflight
  to acceptance in production). Packing compresses journaled objects as it
  did loose ones; recovery re-indexes records a lost index commit left out.
  Locally, with 4 ms added per fsync: accepted-store about 18 to 8 ms.
- Replay stays only for a head's entries after its basis: with no replay,
  14 engine tests of moves, nested and hidden decisions after the basis
  failed, because the index keeps nodes and pieces, not the engine's
  decision history.

## Steps

1. **Spike: can the engine evaluate from the index?** On a production copy, take
   real old-basis questions (the iPhone's catch-up is the reference) and evaluate
   each one from the base and head indexes plus the traces of entries that touch the
   affected files. Compare roots, decisions, alternatives, contributions and evidence
   with full replay. Record which history records each question actually needed.
   If evaluation needs history the index cannot give cheaply, stop and bring the
   measured limit to Joe before going further.

   Before the spike, calculate, with a read-only script over a production copy of
   accepted history, and write the numbers into this plan:
   - pieces per file over time on the most-edited files (sets decision 4's chunk
     size and how fast piece lists grow);
   - index records and bytes written per accepted change, against the 100 ms
     fast-forward target;
   - total index size against today's object store;
   - time to recompute every index by replay (what decision 1's "delete and
     recompute" would cost);
   - how often real questions reach copy/move lineage, what deriving it from
     traces costs per question, and what storing it costs per entry (decision 2).
2. **Shared piece module.** Move piece-edit computation for `editSource`,
   `moveSource` and `addEntry` into `@ovst/protocol` beside `checkPlainTrace`, and
   make the engine's exact-basis path call it. No behavior change; the existing
   differential and incremental tests must pass unchanged.
3. **Index format and writer.** The decisions above, the encoding, and the writer
   for both paths (fast-forward in overstoryd, answer from the sidecar). Retention
   and the object collector keep an entry's index exactly as long as its root.
4. **Engine reads the index.** Lazy per-path loading of base and head, history
   records built on demand, replay as the fallback for entries without an index.
   Saved checkpoints become optional; keep the cache only where measurement shows a
   gain.
5. **Measure and deploy.** The targets above, on the host-class benchmark
   (`tests/performance/provenance/rehearse.ts`, `cold-reads.ts`, `fsync-count.ts`), then
   an actual older-device catch-up after deployment.
6. **Collections: cost by edit, not by size.** Moved from Schema language 005
   milestone 4 (Joe, 2026-10-24: the merge sidecar is already too slow; combine
   this with the other merge improvements). A logical collection is a `table`
   object per model listing content-defined `rows` chunks (spec 06 §2.1), but
   `collection-fields-v1` (`packages/tree-merge/src/merge-rules.ts`) and row
   replay load and re-encode whole tables, and the engine holds a collection as
   one opaque value, so steps 1 to 5 don't help. Instead:
   - Merge compares table hashes, then chunk hashes. Chunks all three sides
     share appear in the same order on each, so the rows between two shared
     chunks are the only ones to decode and merge.
   - Replay decodes only the chunks holding the keys an operation names.
   - Re-encoding reuses every unchanged chunk, re-chunking from the first
     changed one until a boundary lines up again; a reused chunk is emitted
     as is only where the chunker would start a fresh chunk.
   - Benchmark (new, in `tests/performance/`): a 50,000-row collection with
     one concurrent edit on each side, and a one-row fast-forward on it,
     against the same edits on a one-chunk collection. It doesn't need the
     index, so it can be done first.

## Verification

- Differential: for every entry of a production copy, the index overstoryd or the
  sidecar wrote equals the one full replay produces. In production, recompute a
  sample of indexes by replay and compare, since the entry's hash does not cover
  them, and every question answered
  from indexes equals its full-replay answer. Cover source edits, moves and copies,
  snapshot barriers, delete/edit choices, root choices and guarded resolutions.
- Extend `tests/unit/overstoryd-merge/history-differential.test.ts`,
  `incremental.test.ts` and `saved-states.test.ts`. Force a restart and an empty
  cache at every step; deleting the cache may change speed only.
- Deterministic visit and allocation counters for complexity; timing distributions
  from repeated fixed-environment runs, not unit-test deadlines.
- Step 6: on the benchmark, a concurrent one-row edit to a 50,000-row collection
  merges, and a one-row fast-forward accepts, in time close to a one-chunk
  collection; the merged root equals the whole-table merge's on randomized edits.
- `bun run test:affected`, `bun run test:protocol` for any contract change,
  `bun run check:links`.

## History 006

Line provenance currently plans to match lines across `document_versions`. With the
index it reads the current file's pieces instead: exact, including moved and
merged text, with no matching heuristics. Its actor recording, portable actor and
route stay as planned; when it is taken up, replace its algorithm section with the
index lookup.

## STOP conditions

- The spike (step 1) shows evaluation needs history the index cannot give without
  replay.
- overstoryd and the engine would compute pieces with two implementations.
- Fast-forward acceptance would have to wait on the sidecar.
- Live deployment, or any change to accepted history: each needs Joe's go-ahead.
