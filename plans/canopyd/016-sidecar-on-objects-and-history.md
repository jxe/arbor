# canopyd 016: A merge sidecar built on objects and history

## Status

- **Priority:** P2
- **Effort:** L
- **Risk:** HIGH. It replaces how merge state is kept and changes the stored
  data model (a migration), though not the wire protocol clients speak.
- **State:** PLANNED, 2026-09-24. Joe agreed the direction: two canopyd-managed
  APIs (objects and history), one merge question, sidecar state as a cache.
- **Depends on:** migration 016's history squash, which ran on 2026-09-24
  ([status](../../status.md#one-merge-state-model-and-history-squash--2026-09-24)),
  so every tree's history starts at its head then; and the merge-boundary work
  (`@overstory/merge-protocol`, canopyd no longer reading or validating sidecar
  state; [status](../../status.md#merge-boundary--2026-09-24)).
- **Supersedes:** the "merge state on every accepted row" model that canopyd
  015 introduced. Rows keep their decisions; they stop carrying sidecar state.

## Why

Anyone should be able to write their own sidecar with their own merge rules,
against a small API that is easy to understand. Today a sidecar must also
maintain an exact retained model of each whole tree and advance it on every
accepted update, in a format canopyd stores for it. That is a large
requirement, and it is also why plain edits are slow: profiling on 2026-09-24
put a one-line edit at about 18 ms of server time with 1 file, 35 ms with 200
and 97 ms with 1,000. The worker load, clone, re-projection and store of the
tree-wide active state grow with the file count; applying the edit itself stayed
under 4 ms. The process round trip is about 1.5 ms.

canopyd cannot send a sidecar everything a merge might need with each question,
because that could be a lot of data. So the sidecar reads what it needs from
two APIs canopyd manages:

1. **Objects.** The content-addressed store, as today.
2. **History.** Each tree's accepted log: the facts canopyd accepted, in order.

With both, a sidecar is a deterministic function of history and objects.
Whatever it keeps is a cache it can rebuild. canopyd stores no sidecar state,
and a plain edit on the head needs no sidecar at all: canopyd checks it and
appends it to the log.

## The design

### History: the accepted log

One entry per accepted update, per tree, all protocol data canopyd already has:

```ts
interface LogEntry {
  id: string;                 // the accepted update id (its ordinal)
  tree: string;
  previous: string | null;    // null only for a tree's first entry, or the squash point
  root: ObjectHash;           // the accepted projection
  change: string;
  trace: Frame[] | null;      // the authored frames; null for a snapshot
  resolves: string[];         // decision keys this update resolved
  decisions: LogDecision[];   // decisions open after this update
}
interface LogDecision {
  key: string;                // the sidecar's key; canopyd derives public ids from it
  path?: string[];            // the entry it concerns; absent for the whole root
  dependencies: string[];
  selected: number;
  alternatives: Array<{ object: ObjectHash; contributions: Array<{ change: string; operation: string | null }> }>;
}
```

`LogDecision` is today's checkpoint decision shape, so replaying an entry
gives a sidecar the same information a checkpoint does now.

Calls (read-only):

- `history.head(tree) → LogEntry`
- `history.entries(tree, after: string | null, limit ≤ 256) → LogEntry[]` in
  accepted order
- `history.entry(id) → LogEntry`

### Objects

- `objects.get(hash) → bytes`, hash-checked.
- `objects.put(bytes) → hash`, into this question's staging; canopyd makes an
  object durable only if the answer is accepted.

The reference binding stays the shared directory read plus a staging
directory, because it is fast. The contract is the two calls.

### The merge question

canopyd asks one kind of question:

```ts
interface MergeQuestion {
  tree: string;
  base: string;          // log entry id the candidate was authored on
  head: string;          // current log entry id
  candidate: { root: ObjectHash; change: string; trace: Frame[] | null; resolves: string[] };
  rules: { id: string; revision: number; config?: unknown };
}
interface MergeAnswer {
  root: ObjectHash;        // the projection to accept
  objects: ObjectHash[];   // new objects it put
  decisions: LogDecision[];// open after this update
  evidence: unknown;       // recorded, never interpreted by canopyd
}
```

Typed refusals stay (`invalid`, `unsupported`, `limit`, `missing-context`), as
does the retryable `unavailable` for a worker that cannot answer. Checkpoints,
`retention-audit`, decision reports with node paths, and every request that
carries sidecar state go away. Snapshot merges and account configuration are
not special: account configuration stays merged in canopyd, and a snapshot is
a question with `trace: null`.

### Transport

Today's stdin/stdout JSON lines, made two-way: while answering a question the
sidecar may send `{ id, call, args }` requests, and canopyd replies
`{ id, result | error }` before the sidecar's final answer. One question at a
time, as now. A sidecar may also be given a private cache directory, which
canopyd may delete at any time; it is not an API.

### Determinism and upgrades

A sidecar must answer as a deterministic function of the log, objects and its
rules. Log entries are facts: when a sidecar replays history to rebuild its
cache, it applies each entry's trace and then aligns to the accepted root and
decisions (today's checkpoint behavior), rather than trusting its own replay.
So a sidecar upgrade never rewrites the past; it only needs a cold rebuild,
bounded by the squash point.

### Fast-forward

A single update on the current head, with no open decision on any file it
touches, whose frames are all plain `editSource` (and later `addEntry`)
operations that canopyd reproduces exactly, is accepted by canopyd without a
question. Its entry records the trace. The check (today's `validateSourceTrace`,
now test support) moves into `@overstory/protocol` beside `composeSourceEdits`,
because it is protocol behavior, not merge policy. Anything canopyd cannot
check goes to the sidecar, which remains the authority on validity. The fast
path never rejects.

## Work

1. **Contract.** Define `LogEntry`, `LogDecision`, the history and object
   calls, the question and answer, and the two-way framing in
   `@overstory/merge-protocol`. Write `docs/architecture/canopyd/writing-a-sidecar.md`:
   the whole API on one page.
2. **Reference proof of sufficiency.** A minimal sidecar under test support,
   about 150 lines: no cache, reads the log from the common entry, three-way
   file merge with a whole-file choice on any conflict. Run it through the
   canopyd acceptance suites that do not assert today's specific merge rules.
   If it cannot be written against the API alone, the API is incomplete.
3. **canopyd serves history.** Store `trace`, `resolves` and `decisions` on
   the log (columns on `accepted_updates`, or one log table; decide in review),
   serve the three calls on the worker channel, and build inspection pages from
   log decisions with today's derived public ids.
4. **canopyd asks one question.** Replace intent requests, checkpoints and
   `SemanticMerge.record` with the question and the answer. Every acceptance
   path, including tree creation, pairing and boundary rewrites, appends a log
   entry without asking anything.
5. **Fast-forward.** Move the plain-edit check into `@overstory/protocol` and
   accept qualifying updates without a question.
6. **The worker becomes a sidecar.** Keep its engine and format rules. Replace
   host-supplied state with a cache keyed by (tree, log entry id), rebuilt from
   history by replaying entries (trace, then align to root and decisions). Store
   the cache per file, so a plain edit touches only that file's state and its
   directories. Delete the tree-wide active state load, store and clone.
7. **Migration (schema 19).** Move each head's request and decisions from
   `accepted_merge_states` into the log, then drop `accepted_merge_states` and
   the retention audit of sidecar state. Sidecar caches start cold.
8. **Docs and status.** Rewrite `merge-tool.md` around the two APIs and the
   question; record measurements.

## Decisions for Joe

1. **Where the log lives:** columns on `accepted_updates`, or a separate
   append-only table. Columns are fewer moving parts; a table keeps large
   traces out of the row every other query reads.
2. **Cache location:** only in the sidecar's memory (rebuild after each
   restart), or also in a private cache directory. Memory-only is simpler; a
   directory avoids a cold rebuild after deploys.
3. **Fast-forward scope:** start with `editSource` only, or include `addEntry`
   (a new file has no prior state).
4. **Reference sidecar:** keep it in test support only, or publish it as the
   documented example for people writing their own.

## Risks

- **Cold rebuilds.** Without a persisted cache, the first merge on a tree
  after a restart replays that tree's log since the squash point. Measure on a
  copy of production before deciding decision 2.
- **Information only the retained state carries.** Source-transfer provenance
  and hidden-alternative lineage live in today's retained state. They must be
  derivable by replaying traces, or the sidecar must cache them. Stage 2 and
  a differential test (old worker against new sidecar on replayed production
  history) find any gap before migration.
- **Determinism.** A sidecar whose replay depends on anything outside history,
  objects and rules gives different answers after a rebuild. The conformance
  run should rebuild caches midway and compare.

## Verification

- The reference sidecar passes the rule-agnostic acceptance suites.
- The differential run: for a copy of production, every accepted update
  replayed through the new sidecar yields the same roots and equivalent
  decisions as the current worker.
- Plain edits on the head: no sidecar call, and server time independent of
  file count (the 1,000-file case under 20 ms locally).
- A merge after a cache wipe answers the same as one with a warm cache.
- The usual gates: typecheck, the product suite, the merge suites,
  `test:protocol`, `check:links`, `git diff --check`.
