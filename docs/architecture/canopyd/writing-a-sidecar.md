# Writing a merge sidecar

A merge sidecar decides how concurrent work combines. canopyd asks it one kind of
question and it reads everything else it needs from one place, the object store.
This page is the whole API. The types are in
[`@overstory/merge-protocol`](../../../packages/merge-protocol/src/index.ts); the
reference sidecar is [`@overstory/canopyd-merge`](merge-tool.md), and
[`tests/support/reference-sidecar.ts`](../../../tests/support/reference-sidecar.ts) is a
cache-free one of about a hundred lines that canopyd's acceptance tests run against.

## The object store

Every object is named by the SHA-256 of its bytes, `sha256:<64 hex>`, and stored at
`<dir>/<hex 0..2>/<hex 2..64>`. The layout is the contract; no library is needed.

- **Read** from the shared directory (`--objects`). Check that the bytes hash to the
  name. It is read-only.
- **Write** new objects into this question's staging directory (`--staging`), under the
  same layout. canopyd keeps an object only if it accepts the answer that lists it.

Trees are directory objects: canonical CBOR maps `{type: "directory", entries}`, each
entry `{name, file | directory | tree}` in UTF-8 name order
([wire objects](../../overstory-spec/README.md)). File objects are raw bytes.

## Accepted history

canopyd stores each accepted update as a **log entry**: canonical JSON
(sorted keys, no whitespace), format `overstory-log-entry-v1`.

```ts
interface LogEntry {
  format: "overstory-log-entry-v1";
  tree: string;
  previous: ObjectHash | null; // the entry before; null starts a chain
  root: ObjectHash;            // the accepted tree
  change: string;
  trace: Frame[] | null;       // the authored frames; null for a snapshot
  resolves: string[];          // decision keys this update resolved
  decisions: LogDecision[];    // decisions open after this update
  asked?: {                    // how the sidecar was asked, when it was
    base?: ObjectHash; prefix?: Candidate[]; candidate?: ObjectHash;
    alternatives?: AlternativeBinding[]; rules: MergeRules;
  };
  evidence?: unknown;          // the sidecar's own, recorded as given
}
```

`previous` makes a tree's history a hash chain, like git commits: walk it from any
entry to whatever you need. An entry's hash is its identity, so a cache keyed by it
can never be stale.

A **decision** is a choice left open:

```ts
interface LogDecision {
  key: string;               // yours; canopyd derives public ids from it
  path?: string[];           // the entry it concerns; absent: the whole root
  range?: [number, number];  // with path: a choice about these bytes of that file
  at?: ObjectHash;           // with range: the file the range is in, when not root's
  dependencies: string[];    // keys that must be resolved with it
  selected: number;          // the alternative the root shows
  alternatives: Array<{ object: ObjectHash; contributions: Array<{ change: string; operation: string | null }> }>;
}
```

Without `range`, each alternative object is a whole root: without `path` the root itself,
with `path` the entry's root with that alternative's version at `path` (absent for a
deletion). With `range`, each alternative object is that alternative's bytes for the range.

## The question

One JSON object per line on stdin; one answer per line on stdout, in order.

```ts
interface MergeQuestion {
  base: ObjectHash;      // the entry the candidate was authored on
  head: ObjectHash;      // the tree's current entry
  prefix?: Candidate[];  // earlier batch candidates authored on base, in order
  candidate: { root: ObjectHash; change: string; trace: Frame[] | null; resolves: string[]; alternatives?: AlternativeBinding[] };
  rules: { id: string; revision: number; config?: unknown };
}
interface MergeAnswer {
  root: ObjectHash;          // the tree to accept
  objects: ObjectHash[];     // new objects you put in staging
  decisions: LogDecision[];  // open after this update
  evidence: unknown;
}
```

The candidate's objects are in staging or the shared store. `resolves` lists decision
keys of the head whose resolution guards canopyd has already checked;
`alternatives` binds material a client's operations name to your decision keys. Answer
a question you cannot evaluate with one line:

- `{"refusal": {"code": "invalid" | "missing-context" | "unsupported" | "limit", "message": "..."}}`
  for a typed refusal: canopyd accepts nothing and tells the client;
- `{"error": {"message": "...", "code"?: "limit" | "unavailable"}}` for a failure;
  canopyd answers a retryable 503 only for those two codes.

Stay running between questions. canopyd starts one process, sends one question at a
time, clears staging between them, and restarts you if you exit, exceed its timeout, or
send a line that is not a well-formed answer, refusal or error, or an answer that fails
its checks. A refusal or an error keeps you running with your cache.
Stderr lines starting `{"timings":` are read as diagnostics; anything else is ignored.

## What canopyd does without you

- **Plain edits on the head.** A single traced update authored on the head whose
  operations are all `editSource` over basis material or `addEntry` of a new name,
  whose frames canopyd reproduces exactly, and that touches nothing an open decision
  concerns, is accepted as authored with the head's decisions carried over. Its entry
  has no `asked`. You meet it when you replay history.
- **Its own acceptances.** A tree's first entry, pairing, and boundary rewrites are
  written by canopyd; when decisions are open it asks you to carry them onto its root.
- **Account configuration** is canopyd's own policy, merged by canopyd; a policy choice
  it keeps open is added to the entry after your answer.

## Rules for a sidecar

- **Rebuild across questions if you must.** canopyd ends a process that exceeds its
  timeout. If rebuilding a cache takes longer, answer `{"error": {"code": "unavailable"}}`
  and keep what you built: canopyd tells the client to retry.
- **Be deterministic.** Answer as a function of objects and the rules. A cache must be
  rebuildable from entries, and a rebuild must answer the same.
- **Entries are facts.** When you replay history, derive each entry's state from its
  recorded question (`asked`, or the trace on `previous` when it has none) and then
  align to its recorded root and decisions; never trust your replay over the entry.
- **Name everything you answer.** Every object the root and the decisions reach that the
  shared store lacks goes in staging and in `objects`. canopyd checks each tree's
  closure and each range alternative before it accepts.
- **Keys are identities.** Keep a decision's key while it is the same choice; canopyd's
  public decision and alternative ids come from it.
