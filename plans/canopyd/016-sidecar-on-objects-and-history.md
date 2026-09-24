# canopyd 016: A merge sidecar built on objects and history

## Status

- **Priority:** P2
- **Effort:** M remaining
- **Risk:** HIGH at cutover: migration 018 changes the stored data model (schema 19),
  though not the wire protocol clients speak.
- **State:** IMPLEMENTED on `claude/dazzling-keller-29kiss`, 2026-09-24: steps 1 to 7
  and the documentation; not deployed. What was built, and its evidence, is in
  [status](../../status.md#log-entries-and-one-merge-question--2026-09-24); the design
  is [writing a sidecar](../../docs/architecture/canopyd/writing-a-sidecar.md) and
  [the merge sidecar](../../docs/architecture/canopyd/merge-tool.md). What remains is
  the cutover, the measurements the plan required before shipping, and the sidecar's
  per-file cache.
- **Depends on:** the merge boundary, also undeployed on this branch, so
  [check 017](../../packages/canopyd/migrations/017-resource-policy-only/README.md)
  runs against a restored backup before this deploy.

## Why

Anyone should be able to write their own sidecar with their own merge rules, against a
small API. That API is now the object store (which holds the accepted history as log
entries) and one merge question, and plain edits on the head no longer ask a sidecar.

## Remaining work

1. **Rehearse and run migration 018** from Joe's laptop, following
   [its runbook](../../packages/canopyd/migrations/018-log-entries/README.md): back up,
   rehearse on restored copies (including `rebuild-check.ts`, the cold-rebuild
   measurement below), deploy with check 017 clean, migrate in place, verify. Record the
   rehearsal and the live run in that README and in `status.md`.
2. **Cold rebuilds, measured on a copy of production.** `rebuild-check.ts` reports, per
   tree, the time for a fresh sidecar to rebuild its head from the chain's start (the
   first merge after a restart). If a tree is too slow, add a snapshot entry that lets a
   chain start later; not a persistent cache.
3. **A differential run on production history.** The plan asked for every accepted
   update replayed through the old worker and the new sidecar with equal roots and
   equivalent decisions. Migration 016 cut history to 2026-09-24, so the useful form is
   the 016 replay check's: on the rehearsal copy, re-submit the last client updates of
   each ordinary tree through this build and compare each root and conflict flag with the
   recorded one. Adapt `016-squash-history/replay-check.ts` (it needs the schema-18 code
   it shipped with) or write it against this build's acceptance path.
4. **The sidecar's cache per file.** Step 6 kept the engine's tree-wide state: every
   replayed plain edit loads, clones and stores the whole active state, so the cost
   moves from canopyd's request to the next question. Split the retained state so a plain
   edit touches only its file's state and its directories. Measure with
   `FILES=1000 bun tests/performance/snapshot-acceptance-cost.ts` and the `replayed`
   count in the sidecar's timings.
5. **Latency at 1,000 files.** A plain traced edit on the head takes about 155 ms of
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
