# canopyd 016: A merge sidecar built on objects and history

## Status

- **Priority:** P2
- **Effort:** M remaining
- **Risk:** Low: the cutover is done; what remains is measurement and performance.
- **State:** DEPLOYED 2026-09-24 at schema 19 by migration 018 (build `dd5313c8`), with
  steps 1 to 7 and the documentation. What was built, the cutover and its evidence are in
  [status](../../status.md#log-entries-and-one-merge-question--2026-09-24); the design
  is [writing a sidecar](../../docs/architecture/canopyd/writing-a-sidecar.md) and
  [the merge sidecar](../../docs/architecture/canopyd/merge-tool.md). What remains is
  the differential replay, the sidecar's per-file cache and 1,000-file latency.

## Why

Anyone should be able to write their own sidecar with their own merge rules, against a
small API. That API is now the object store (which holds the accepted history as log
entries) and one merge question, and plain edits on the head no longer ask a sidecar.

## Remaining work

1. **A differential run on production history.** The plan asked for every accepted
   update replayed through the old worker and the new sidecar with equal roots and
   equivalent decisions. Migration 016 cut history to 2026-09-24, so the useful form is
   the 016 replay check's: on the rehearsal copy, re-submit the last client updates of
   each ordinary tree through this build and compare each root and conflict flag with the
   recorded one. Adapt migration 016's `replay-check.ts` (deleted; it is
   `packages/canopyd/migrations/016-squash-history/replay-check.ts` at `d15ddce`, and needs
   the schema-18 code it shipped with) or write it against this build's acceptance path. The pre-cutover
   backup `.backups/railway/20260924T131328Z/volume.tar` is the copy to use.
2. **The sidecar's cache per file.** Step 6 kept the engine's tree-wide state: every
   replayed plain edit loads, clones and stores the whole active state, so the cost
   moves from canopyd's request to the next question. Split the retained state so a plain
   edit touches only its file's state and its directories. Measure with
   `FILES=1000 bun tests/performance/snapshot-acceptance-cost.ts` and the `replayed`
   count in the sidecar's timings.
3. **Latency at 1,000 files.** A plain traced edit on the head takes about 155 ms of
   server time with 1,000 files in one directory, not the 20 ms targeted: canopyd's graph
   validation, candidate validation, entry diff and the plain-trace check each decode the
   1,000-entry directory. A snapshot beside an open choice is about 25% slower than
   before (338 ms against 267 ms at 1,000 files), mostly from expressing entry-choice
   alternatives as whole roots. Profile and cut these, or record that the target does not
   hold for flat directories.

## Decided (2026-09-24)

1. **Entry encoding:** canonical JSON.
2. **Decisions in SQLite:** no copy. Rows keep the entry hash and the `conflicted` flag.
3. **Cache:** memory only; a restart means cold rebuilds, bounded by each chain's start.
4. **Fast-forward scope:** `editSource` and `addEntry`.
5. **Reference sidecar:** in test support as the proof that the API is sufficient; not
   published.

Settled while implementing, beyond the plan's shapes: an entry records the question
that produced it (`asked`), so replay asks it again rather than approximating; a source
choice is a range with each alternative's bytes, so presentation is unchanged; snapshot
choices moved from canopyd into the sidecar; a batch suffix carries earlier candidates as
`prefix`; canopyd's own acceptances ask the sidecar only when decisions are open; an
alternative's `revision` names its value, not the sidecar's state.
