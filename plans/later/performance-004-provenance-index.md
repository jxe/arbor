# Performance 004: a provenance index kept at acceptance

**Why and when:** Joe chose this on 2026-10-21 instead of Performance 003. After the
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

## Status

- **Effort:** L
- **Risk:** HIGH. It adds to the sidecar contract (log entry, question, answer), and
  two programs must agree exactly on piece semantics: if overstoryd's index ever
  differs from what the engine would have computed, later merges go wrong with no
  error.
- **State:** PLANNED
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

1. **Where the index is named.** Recommended: a `provenance` field on the log entry,
   hash-chained with it, so the sidecar finds it from the entry it already reads and
   no question changes shape. Alternative: a private overstoryd column passed in each
   question. Either way it is a sidecar contract change, recorded in
   [writing a sidecar](../../docs/architecture/overstoryd/writing-a-sidecar.md) and
   `@ovst/merge-protocol`.
2. **What the index holds.** At minimum nodes and pieces. Whether `origins` (copy
   and move lineage) belongs in it, or stays engine-derived from traces, follows from
   step 1's spike.
3. **Encoding.** The engine's persistent bucket layout, or a directory-shaped record
   per folder mirroring the tree. Choose by write cost per fast-forward and lazy-read
   cost per question.
4. **Entries from before the index.** Recommended: no backfill migration. The
   sidecar's first replay over an old entry writes its index, so coverage grows on
   its own; an index computed by replay is the same object overstoryd would have
   written.

## Steps

1. **Spike: can the engine evaluate from the index?** On a production copy, take
   real old-basis questions (the iPhone's catch-up is the reference) and evaluate
   each one from the base and head indexes plus the traces of entries that touch the
   affected files. Compare roots, decisions, alternatives, contributions and evidence
   with full replay. Record which history records each question actually needed.
   If evaluation needs history the index cannot give cheaply, stop and bring the
   measured limit to Joe before going further.
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
   (`tests/performance/benchmark-catch-up.ts`, `benchmark-history-maps.ts`), then
   an actual older-device catch-up after deployment.

## Verification

- Differential: for every entry of a production copy, the index overstoryd or the
  sidecar wrote equals the one full replay produces, and every question answered
  from indexes equals its full-replay answer. Cover source edits, moves and copies,
  snapshot barriers, delete/edit choices, root choices and guarded resolutions.
- Extend `tests/unit/overstoryd-merge/history-differential.test.ts`,
  `incremental.test.ts` and `saved-states.test.ts`. Force a restart and an empty
  cache at every step; deleting the cache may change speed only.
- Deterministic visit and allocation counters for complexity; timing distributions
  from repeated fixed-environment runs, not unit-test deadlines.
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
