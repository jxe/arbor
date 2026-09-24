# canopyd 016: A merge sidecar built on objects and history

## Status

- **Priority:** P2
- **Effort:** L
- **Risk:** HIGH. It replaces how merge state is kept and changes the stored
  data model (a migration), though not the wire protocol clients speak.
- **State:** PLANNED, 2026-09-24. Joe agreed the direction: the accepted
  history stored as immutable objects, so a sidecar needs only the object
  store and one merge question; sidecar state is a cache.
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
storage canopyd manages. It needs two things: content, and the history of what
was accepted. Both can live in one place. The object store already holds
content; this plan stores each accepted update there too, as an immutable
**log entry** that names the entry before it, so a tree's history is a hash
chain, like git commits.

A sidecar then needs **one API, the object store**, plus the question it is
asked. It is a deterministic function of objects, and whatever it keeps is a
cache it can rebuild. canopyd stores no sidecar state, and a plain edit on the
head needs no sidecar at all: canopyd checks it and appends its entry.

## The design

### Log entries

One entry per accepted update, written by canopyd as a canonical JSON object in
the object store, all protocol data canopyd already has:

```ts
interface LogEntry {
  format: "overstory-log-entry-v1";
  tree: string;
  previous: ObjectHash | null; // the entry before; null for a tree's first entry
                               // and for each head this plan's migration starts from
  root: ObjectHash;            // the accepted projection
  change: string;
  trace: Frame[] | null;       // the authored frames; null for a snapshot
  resolves: string[];          // decision keys this update resolved
  decisions: LogDecision[];    // decisions open after this update
}
interface LogDecision {
  key: string;                 // the sidecar's key; canopyd derives public ids from it
  path?: string[];             // the entry it concerns; absent for the whole root
  dependencies: string[];
  selected: number;
  alternatives: Array<{ object: ObjectHash; contributions: Array<{ change: string; operation: string | null }> }>;
}
```

`LogDecision` is today's checkpoint decision shape, so replaying an entry gives
a sidecar the same information a checkpoint does now. An entry's hash is its
identity: two sidecars, or one sidecar before and after a restart, can never
disagree about what an entry says. canopyd writes the entry object durably
before the transaction that records it, as it already does for roots, and each
accepted row keeps its entry's hash. canopyd's SQLite schema stays private.

### The object store: the one API

- `get(hash) → bytes`: read `objects/<hex 0..2>/<hex 2..64>` under the shared
  directory; the bytes must hash (SHA-256) to the name. Read-only.
- `put(bytes) → hash`: write into this question's staging directory under the
  same layout; canopyd makes an object durable only if it accepts the answer.

`@overstory/object-store` implements both in TypeScript. The layout is the
contract, so a sidecar in another language needs no library.

### The merge question

canopyd asks one kind of question:

```ts
interface MergeQuestion {
  base: ObjectHash;      // the log entry the candidate was authored on
  head: ObjectHash;      // the tree's current log entry
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

The sidecar walks `previous` from `head` (and from `base`, when they differ) to
whatever it needs. Typed refusals stay (`invalid`, `unsupported`, `limit`,
`missing-context`), as does the retryable `unavailable` for a sidecar that
cannot answer. Checkpoints, `retention-audit`, decision reports with node
paths, and every request that carries sidecar state go away. Snapshot merges
and account configuration are not special: account configuration stays merged
in canopyd, and a snapshot is a question with `trace: null`.

### Transport

Today's stdin/stdout JSON lines: one question per line, one answer per line,
in order. With history in the object store the sidecar never calls canopyd,
so the channel stays one-way and needs no framing beyond lines. Any language
can implement it. A sidecar may also be given a private cache directory, which
canopyd may delete at any time; it is not an API. If concurrency or a remote
sidecar is ever needed, the same question and answer can move to HTTP over a
unix socket without changing their shape.

### Determinism and upgrades

A sidecar must answer as a deterministic function of objects and its rules.
Entries are facts: when a sidecar replays history to rebuild its cache, it
applies each entry's trace and then aligns to the accepted root and decisions
(today's checkpoint behavior), rather than trusting its own replay. So a
sidecar upgrade never rewrites the past; it only needs a cold rebuild, bounded
by each chain's start. A cache keyed by entry hash can never be stale.

### Fast-forward

A single update on the current head, with no open decision on any file it
touches, whose frames are all plain `editSource` (and later `addEntry`)
operations that canopyd reproduces exactly, is accepted by canopyd without a
question. Its entry records the trace. The check (today's `validateSourceTrace`,
now test support) moves into `@overstory/protocol` beside `composeSourceEdits`,
because it is protocol behavior, not merge policy. Anything canopyd cannot
check goes to the sidecar, which remains the authority on validity. The fast
path never rejects.

### Retention and access

Every entry, and every root and alternative it names, is reachable from a
tree's head entry, so a future object collector keeps exactly what the chains
reach; sidecar caches are disposable. Entry hashes are never sent to clients.
The object route already serves any retained object to a caller who can read
some tree and knows its hash; entries fall under that rule as sidecar states
do today.

## Work

1. **Contract.** Define `LogEntry`, `LogDecision`, the question and the answer
   in `@overstory/merge-protocol`, and document the object layout. Write
   `docs/architecture/canopyd/writing-a-sidecar.md`: the whole API on one page.
2. **Reference proof of sufficiency.** A minimal sidecar under test support,
   about 150 lines: no cache, walks entries from `head` and `base` to their
   common entry, three-way file merge with a whole-file choice on any
   conflict. Run it through the canopyd acceptance suites that do not assert
   today's specific merge rules. If it cannot be written against the object
   store and the question alone, the design is incomplete.
3. **canopyd writes entries.** Every acceptance path, including tree creation,
   pairing, account configuration and boundary rewrites, writes its entry
   object and records its hash on the accepted row. Inspection pages read
   decisions from the head entry with today's derived public ids.
4. **canopyd asks one question.** Replace intent requests, checkpoints and
   `SemanticMerge.record` with the question and the answer.
5. **Fast-forward.** Move the plain-edit check into `@overstory/protocol` and
   accept qualifying updates without a question.
6. **The worker becomes a sidecar.** Keep its engine and format rules. Replace
   host-supplied state with a cache keyed by entry hash, rebuilt by replaying
   entries (trace, then align to root and decisions). Store the cache per
   file, so a plain edit touches only that file's state and its directories.
   Delete the tree-wide active state load, store and clone.
7. **Migration (schema 19).** Write one entry per current head (previous
   `null`) from its row and merge-state record, record its hash, then drop
   `accepted_merge_states` and the retention audit of sidecar state. Sidecar
   caches start cold.
8. **Docs and status.** Rewrite `merge-tool.md` around the object store and the
   question; record measurements.

## Decisions for Joe

1. **Entry encoding:** canonical JSON (readable, what the merge contract uses)
   or the protocol's canonical CBOR (compact, what tree objects use).
2. **Decisions in SQLite too:** whether accepted rows keep a copy of their open
   decisions for queries and inspection, or canopyd always reads them from the
   head entry. A copy is faster to query; reading the entry keeps one source.
3. **Cache location:** only in the sidecar's memory (rebuild after each
   restart), or also in its private cache directory. Memory-only is simpler; a
   directory avoids a cold rebuild after deploys.
4. **Fast-forward scope:** start with `editSource` only, or include `addEntry`
   (a new file has no prior state).
5. **Reference sidecar:** keep it in test support only, or publish it as the
   documented example for people writing their own.

## Risks

- **Cold rebuilds.** Without a persisted cache, the first merge on a tree
  after a restart replays that tree's chain from its start. Measure on a copy
  of production before deciding decision 3.
- **Information only the retained state carries.** Source-transfer provenance
  and hidden-alternative lineage live in today's retained state. They must be
  derivable by replaying entries, or the sidecar must cache them. Step 2 and
  a differential test (old worker against new sidecar on replayed production
  history) find any gap before migration.
- **Determinism.** A sidecar whose replay depends on anything outside objects
  and its rules gives different answers after a rebuild. The conformance
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
