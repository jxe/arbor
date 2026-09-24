# Merge executable and shared objects

The reference implementation has a TypeScript merge package,
`@overstory/canopyd-merge`, and an `arbor-merge` executable script run by Bun.
canopyd runs it as a sidecar: one persistent worker with a bounded FIFO queue
and no fan-out. canopyd owns accepted history, causal reconstruction,
authorization, guards, conflict identity, and atomic acceptance. The
executable owns the format rules, the tree merge computation, and its
retained state, whose format canopyd never reads. It has no database
connection or credentials in its API; it is a trusted local worker, not an
OS sandbox for arbitrary plugins.

The two share only the object store (`@overstory/object-store`) and the JSON
contract (`@overstory/merge-protocol`). canopyd does not depend on
`@overstory/canopyd-merge`. Account configuration is canopyd's own policy, so
canopyd merges it itself ([account configuration](#account-configuration)).

## API and execution

```sh
bun run arbor-merge serve --objects /data/objects --staging /data/merge-workers/worker-example/objects
```

`serve` accepts one JSON request per line on stdin and returns one response
per line on stdout, in order; a failed evaluation returns
`{ "error": { "message": "...", "code"?: "..." } }` and leaves the process
usable. Each request's timings go to stderr as one `{"timings": ...}` line.
Callers own staging lifetime and serialization. canopyd keeps one worker
alive across jobs, validates each result, then clears staging before starting
the next job. Timeouts and crashes are reaped before cleanup; queued
successors can start a replacement. canopyd shutdown drains the active job,
rejects queued work, and closes its worker. A custom executable speaks the
same protocol.

The [typed and validated contract](../../../packages/merge-protocol/src/index.ts) is the
source of truth. For example, a tree merge takes these fields (replace abbreviated
hashes with actual SHA-256 object hashes):

```json
{
  "kind": "tree",
  "base": { "object": "sha256:..." },
  "current": { "object": "sha256:..." },
  "incoming": { "object": "sha256:..." },
  "rules": { "id": "tree-default", "revision": 1 }
}
```

It returns `result: { object }`, `decisions`, `objects` (new object hashes, not
bytes), and `evidence: { rule, summary? }`. Conflict decisions name their path,
reason, and entry or coupled-directory scope. A successful partial merge may
contain unresolved decisions. Empty decisions do not clear existing canopyd choices.
canopyd reifies the rule output with retained alternatives and origins, assigning
durable identities itself. `tree-default` is the only snapshot rule.
Authored execution and unresolved alternatives use the operation-bearing
tree request described under [operation evaluation](#operation-evaluation).

The rule revision identifies algorithm semantics; it is not a versioned client API.
Unrecognized rules, invalid responses or missing material fail evaluation. There
is no supported-operation advertisement to clients. Ship server support before
clients emit additional operations.

### Trusted semantic basis

For operation-bearing tree requests, the host supplies `base` and `current`
state/root pairs within the named tree. canopyd takes them from its accepted
records, from checkpoints and replays the worker returned for accepted history,
or from earlier results in the same batch. They are not client-provided
assertions. This is the worker contract;
there is no trust flag or optional untrusted-basis mode.

Exact-basis source execution loads active state and directory metadata to obtain
unchanged file hashes. It does not reread untouched file bodies or reconstruct
the entire basis to prove the state/root relationship again. Referenced bytes
remain hash-checked, operation selectors remain checked, and the computed result
must match the supplied candidate. General merges currently retain their full
projection work; extending incremental execution is separate remaining work.

## Historical checkpoints

canopyd reconstructs missing semantic states that no trace explains with `checkpoint-batch`
requests containing an initial material reference and up to 64 ordered accepted
projections, change identities and legacy decisions. The worker applies the same
checkpoint semantics at each step and returns every intermediate state reference.
canopyd checks each against its accepted projection before persisting objects
and caching references.

Each batch retains at most 128 MiB of generated objects and 32 MiB of cached input
bytes. Exceeding the generated-object budget returns the error code
`checkpoint-batch-too-large`; canopyd retries a smaller slice against the same
basis. Other failures remain failures. These are
internal worker requests, with no public Overstory or database schema change.
Bun uses native SHA-256 with the same object identities as the portable fallback.

## Incremental retained state

Every stored state is indexed (`arbor-merge-intent-state-v3`): an active part
beside five hash-partitioned history maps. Migration 013 rewrote the earlier
full-copy states, and readers no longer accept them. A history record of at
most 2048 canonical JSON characters is stored inline (`arbor-state-record-v1`);
a larger one is chunked into shared value pages (`arbor-state-record-v2`), so
before/after piece sequences share unchanged pages across effects instead of
embedding a complete copy in every record. Both record forms are current.
These are internal object formats, not changes to public update requests.

This format is the worker's own. canopyd stores only state hashes beside its
accepted records and never parses, validates, or walks a state. Its integrity
audit (`/.arbor/health`) asks the worker to walk the retained closure of every
recorded state with a `retention-audit` request of at most 10,000 roots; the
worker checks each object's hash as it reads it and fails on a missing one.

## Decision reports

An authored evaluation and a checkpoint return `decisions` as reports, not as
the worker's retained records. A report carries the decision's key, kind,
reason, selected index, dependencies, alternatives (object, state, whether the
alternative names a present entry, and contributions), its subject, and, when
it has a placement, the placed file's logical `path` and, when that file is
active and the decision has no context, its affected byte `range`. The worker
resolves its own node identities into those paths, so canopyd needs nothing
else to assign durable decision and alternative identities and to present them.

## Response checks

canopyd trusts the worker it runs. It checks each response's shape and its
correspondence to the request (rule identity, change, operation keys, candidate
root, checkpoint projections), hash-checks every generated object as it reads it
back, verifies the reachable closure of a snapshot merge's result tree, and
requires a stateful result's root to be present. It does not re-execute
operations, re-validate retained state, or compare a response's decisions
against that state. Earlier releases did, with a second copy of the worker's
validator; `ARBOR_STATE_PROOF_MB`, `ARBOR_HISTORY_CACHE_MB` and
`ARBOR_STATE_VALIDATION_MS` configured it and no longer exist.

## Fast-forward without the worker

A single traced update whose base is the tree's current accepted update, with
no decisions open there, no resolutions, no stale `ifCurrent` guard, and only
`editSource` operations, is checked by canopyd itself: every frame must follow
its predecessor and reproduce its own `after` exactly from plain basis edits
(`validateSourceTrace` in `packages/canopyd/src/updates/source-edits.ts`). When
it does, canopyd accepts it without calling the worker and keeps its frames and
per-operation evidence in `authored_changes`, inside the accepted transaction.
An edit that leaves the bytes unchanged still records intent, so it goes to the
worker. The fast path never rejects: anything canopyd cannot verify, including
an invalid trace, is evaluated by the worker as before, and the worker remains
the authority on validity. If the head moves between verification and commit,
the request fails with a retryable `server-busy`; a traced edit is never merged
as a snapshot.

The worker's state then lags. canopyd rebuilds it from its accepted log: in
the background right after the commit, and in the foreground whenever a later
request needs the state first. Walking back to the nearest recorded or cached
state, an update whose retained trace explains it exactly (its basis and
candidate are its predecessor's root and its own) is replayed as an authored
evaluation and its result recorded; any other missing update is checkpointed
as its accepted projection, as before. A replay that does not reproduce the
accepted root, or fails, falls back to a checkpoint for that update. Builds are
serialized per tree, so a catch-up never replays history another has already
recorded, and shutdown waits for pending catch-ups.

On a 400-line note in a fresh data directory, sequential plain edits took a
35 to 40 ms median before this path and about 15 ms with it; the first edit
after start fell from about 280 ms to about 20 ms.

## Account configuration

The three account-configuration files are canopyd's policy: it parses them,
authorizes every change before and after merging, and writes them itself. So
their three-way merge is in canopyd (`packages/canopyd/src/account-policy-v2.ts`),
beside that authorization, and the worker has no account rule. Parsing and the
canonical three-file writer are in `@overstory/protocol`. `trees.yaml` is read in
the resource-rule grammar only.

## Operation evaluation

A tree request may carry authored operations. There is one evaluator; snapshot
requests, checkpoints, and account rules are different inputs to the same
executable, not separately deployed engines.

```ts
{
  kind: "tree",
  tree: "tree-scope",
  base: { object: baseRoot, state: retainedToolState },
  current: { object: currentRoot, state: retainedCurrentToolState },
  incoming: {
    object: exactCandidateRoot,
    change: "authored-change",
    trace: [/* frames of SourceOperation values */],
    resolves: [/* tool decision keys whose guards canopyd checked */]
  },
  rules: {
    id: "tree-default", revision: 1,
    config: {
      maxBytes: 33554432, maxNodes: 20000, maxMillis: 5000,
      proseInsertions: "preserve-both",
      formats: { "/records.csv": { format: "csv", recordKey: "id" } }
    }
  }
}
```

A first basis can omit `state`; later evaluations retain the returned state
object beside its root. Equal roots never imply equal retained intent, and the
evaluator never invents operations from a diff.

**Frames.** Operations arrive as a trace: a chain of `{ before, after,
operations }` frames from the request's base root to the candidate. References
are frame-local, operation keys are unique across the trace, and every frame
must reproduce its own `after`. A trace is evidence the evaluator checks in
full, never a hint; an empty trace is snapshot semantics. The protocol bounds
a trace to 64 frames and 1024 operations. `undoOperation` is not in the
grammar; editors express undo and redo as ordinary edits, and the evaluator
answers `unsupported` if it sees the kind. Clients compact a debounced burst of
plain `editSource` frames before admission: `compactTrace` in
`packages/client/src/source-admission-queue.ts` (and the Swift queue) composes
them with `composeSourceEdits` (see [trace compaction](../../implementing-editors/document-admission.md#trace-compaction)).
The evaluator does not compact; it checks the trace it receives. canopyd's
`composeFrames` in `packages/canopyd/src/updates/source-edits.ts` implements
the same rule by executing the composition, and serves as a test reference
for it.

**Results.** Success returns `outcome: "evaluated"`, `result: { object, state }`,
`authored: { object, state }` for the exact candidate before reconciliation, a
generated-object manifest, decision proposals, and evidence naming the three
input roots, the change and operation keys, the rule revision, configuration,
and policy reasons. The rule is deterministic, so the three roots reproduce
every object it read; the read set itself is not retained. Typed inabilities
are `invalid`, `missing-context`, `unsupported`, and `limit`. Unsupported
operation kinds are not successful no-ops, invalid candidates publish no staged
output, and an inability to evaluate is neither a conflict resolution nor an
accepted receipt; canopyd decides admission and fallback.

**Choices.** Text choices identify immutable basis ranges and their material
alternatives; independent overlaps can remain separate decisions, and a format
refusal can couple the file. Structural ambiguity couples the containing tree.
Explicit alternative bindings map canopyd's authorized material references into
the retained proposal. Enclosing choices retain the old context and depend on
the enclosed decisions; discarding guarded child material requires coherent
declarations. Selective undo preserves independent edits, and if later work
interferes with the inverse the tool retains the pre-undo tree as an
alternative rather than discarding that work. canopyd defaults to independent
source choices with current material selected; `mergeTool.contentChoices:
"file"` restores whole-file presentation, and format rules can still couple
choices.

A pre-existing source choice does not widen a later independent overlap or make
it dependent on that choice. Hidden source successors match the retained whole
branch context, then advance the affected fragment using source provenance.
When a transformation scatters a choice so it cannot remain a contiguous range,
an edit confined to one file retains a file-scoped enclosure and its child
choices; it does not escalate to the root directory. A newly authored enclosure
is not itself evidence of a concurrent conflict. A selected deletion has no
pieces to follow: its anchor moves with later edits, and only an edit spanning
the anchor encloses it. A choice already retained in its own context is not
re-evaluated against later edits to the live file. A file deleted on one side
and changed on the other is an existence choice about that file alone: its
kept alternative is the file, the deleted alternative names no node, and every
other concurrent change still merges into the projection.

An untraced snapshot (as filesystem sync sends) is checkpointed onto the
current state. It encloses only choices whose own material it touches: a
choice about one file is untouched by edits elsewhere, and a snapshot of the
displayed version continues that alternative, as a traced edit would. When a
snapshot itself conflicts, each conflicting file (or file against its
deletion) becomes its own choice and the rest of the snapshot merges; folders
and the root keep a single whole-root choice.

Evaluation time-budget exhaustion is an execution failure: canopyd returns a
retryable HTTP 503, not a malformed-request HTTP 400. The host grants evaluations
20 seconds by default, capped by the worker timeout (`evaluationMillis` can
configure a smaller budget); the standalone evaluator retains its 5-second default.
Deterministic invalid-input
and operation-limit checks retain their existing classification.

### Format support contract

Rules preserve bytes by applying verified source spans; they never print or
normalize a parsed tree, and parser success alone is not enough to merge. These
are the automatic subsets; other simultaneous changes retain alternatives.

| Format | Automatic subset | Requires review |
| --- | --- | --- |
| Text | Disjoint verified origins, including retained lineage and transport | Overlaps and competing anchors by default |
| Markdown | Stable host structure; prose, heading/list text, task values and simple table cells; independent embedded regions; concurrent known embedded edits delegate to their format | Structural delimiter/order changes, ambiguous links, escaped tables and unsupported embedded combinations |
| JSON | Different values under unique, unchanged object-key paths | Duplicate keys, array ordering, key creation/removal or competing values |
| JSONL | Independent record fields with configured unique `recordKey` and stable order | Missing/nonunique keys, key/order/schema changes |
| YAML | Different mapping values with unique stable keys and preserved source | Anchors, aliases, tags, sequences, multiline scalars and parse warnings |
| TOML | Different mapping values under stable unique tables/keys | Dotted keys, arrays, multiline constructs and structural changes |
| CSV/TSV | Different cells with configured unique `recordKey`, unchanged header and row order | Key/schema/order changes, malformed quoting and duplicate keys |
| TS/JS, Swift, Python | Parser-backed literal changes in distinct uniquely named declarations or supported members; syntax and binding topology unchanged | Binding/operator/import/export changes, overloads, decorators, macros, wrappers, directives and ambiguous declarations |
| HTML | Different values under unique element/attribute structure with unchanged order | Repeated unkeyed siblings, duplicate IDs, scripts/styles and event handlers |
| XML | Distinct values in a strict, uniquely structured namespace-free document | Namespaces, DTDs/entities and repeated sibling identity |
| CSS | Different unique declaration values with stable selectors/properties/order | Duplicate declarations, variables, unsupported selectors and cascade-changing structure |
| Binary/media | Entry move/copy and independent tree changes | Competing opaque content; no byte concatenation |

The `markdown-source-transfer` rule replays identity-verified moves and copies
of plain and self-contained formatted paragraphs, including across documents,
when basis, current, authored, and replayed versions all preserve protected
host blocks and embedded content. It never uses similarity as identity.
Competing destinations for the same anchor still require review.

Markdown defaults to `proseInsertions: "preserve-both"`: competing additions
of ordinary prose, paragraphs, and list or task items are kept in stable
contribution order with exact bytes, no separators, and no deduplication.
`"review"` requires review instead. Plain text defaults to review and can opt
in. Structured formats cannot opt into concatenation.

Tree-sitter grammars and the strict XML parser are pinned dependencies. Only
grammar modules are cached; parsed trees are disposed after evaluation.
Neither authored source nor parser IDs execute with host IO authority, and
collection schema evaluation stays in the QuickJS sandbox.

### Retained state and lazy history

Retained state has active material (nodes, decisions) and five history maps
(`outputs`, `effects`, `origins`, `alternatives`, `changes`), each a
hash-partitioned map of immutable records. A state is `editable` when the
evaluation that recorded it enforced every deletion in its effects map on its
nodes. Transported results, results kept under `conflictProjection:
"current"`, and imported states are not editable and take one complete scan,
after which their result is editable. A checkpoint (snapshot candidate) of an
editable state inherits editability: it adds no effects, unchanged files keep
their enforced pieces, and replaced files get fresh origins. Reading a record that was
not loaded is an evaluator error, never "absent".

An `editSource` effect records its piece delta per file node (`edits`: each
edit's `range`, `removed` and `inserted` pieces), and its `before`/`after` node
copies omit `pieces`. Deletion enforcement and retention read only the delta.
Records written before the delta keep whole piece copies and are read by
recomputing the same edits; there is no migration of stored history.

### Limits

Requests are bounded to 8 MiB at the CLI with at most 1024 operations.
Parser-backed analysis caps source at 256 KiB, syntax traversal at 20,000
nodes, and each parse at 100 ms. Exceeding a budget returns `limit`; an
analyzer that cannot prove independence preserves choices. No timeout can
commit accepted state inside this process.

## Objects, authority and failure

`@overstory/object-store` provides immutable, hash-sharded storage. Reads verify
hashes. Durable writes flush files and atomically link them into place;
disposable staging uses atomic publication without fsync. A merge job reads
shared storage first, falling back to staging only when an object is absent.
Corrupt shared bytes fail validation. Generated objects are written only into
staging. Generated hashes already present in the shared store are not staged
again; canopyd reads returned hashes from staging or shared storage and verifies
them. Neither process recopies existing immutable material into every job.
Request JSON contains no object-store filesystem paths.

The worker owns a unique `/data/merge-workers/worker-*` directory. For each job
canopyd stages the uncommitted input objects in its `objects/` staging store,
in one publish. The worker receives fixed paths, with a minimal
environment rather than inherited server credentials. canopyd checks responses as
described under [response checks](#response-checks), then applies its normal
schema, boundary, authorization and guarded-acceptance checks. Returned objects are
retained in memory until canopyd durably stores them before the accepted transaction.
Writing an object alone never creates accepted state.

Normal and failed jobs remove staging in `finally`. A host crash can leave an
unaccepted worker directory; canopyd removes `merge-workers/` (and any
`merge-jobs/` left by older releases) at startup, before any job runs.
The existing retained object store has no garbage collector: accepted input history
is not pruned during evaluation. A future collector must pin job inputs, staged
inputs, results awaiting commit, hidden alternatives and provenance dependencies.

canopyd uses one worker, at most 64 queued evaluations, a
30-second worker timeout with forced termination, and an 8 MiB stdout/stderr buffer
limit. Runtime options can change the timeout, but not add workers. Worker launch, timeout,
validation or execution failure preserves ordinary snapshot content as accepted
ambiguity where the existing snapshot path can do so safely. Authoritative operation
execution and semantic checkpoint failures cannot become unchecked snapshot writes:
no acceptance is recorded, and the client retains its durable request for retry.
An exact accepted retry uses its receipt without requiring the worker. Governed account
configuration retains its authorization/rejection policy. The client keeps its
usual durable retry behavior for unrelated storage or transaction failures.

## Running and configuring

The default invocation runs the TypeScript CLI with the current Bun runtime. The
workspace exposes `bun run arbor-merge`; its executable script has a Bun shebang.
No compilation or signing is needed. A custom `ARBOR_MERGE_EXECUTABLE` may name an
absolute executable script or program that implements `serve`; programmatic
options also accept fixed arguments and worker limits. Arguments are never
interpreted by a shell.

Install workspace dependencies with `bun install`. Collection schema compilation
resolves the worker's installed Zod, uses private temporary files, and evaluates
inside the existing memory/time-limited QuickJS sandbox. It does not depend on the
caller's working directory or execute authored schemas in the host runtime.

Ported behavior: Markdown additive merging and frontmatter/fence checks; stable-page
rename and directory reconciliation; keyed collection rows and schema/constraint
checks. Exact authored-operation execution, nested choices, and the
conservative format rules are described next.

## Verification

```sh
bun test tests/integration/canopyd-merge tests/unit/canopyd/update-merge.test.ts
bun test tests/unit/canopyd-merge tests/unit/canopyd/account-policy-v2.test.ts
bun test tests/integration/canopyd/source-acceptance.test.ts
bun tests/performance/benchmark-merge-tool.ts
bun run typecheck
bun run test:protocol
```

The corpus compares exact roots, bytes, decisions, and evidence against the
ported rules, exercises shared and fresh worker processes, and checks
concurrent staging, corrupt objects, malformed output, worker exits, and forced
timeouts. A real
HTTP case verifies accepted ambiguity, replay, continued publication, restart,
and integrity with a missing worker. A process test runs a collection merge
with an empty environment from a working directory outside the checkout.
`tests/unit/canopyd-merge/lazy-history.test.ts` compares every lazily loaded
result against an eager reference that reads all history. The source-acceptance
suite covers host fast-forwards: acceptance without a worker, replay after an
outage, a stale guard, equal-byte edits, and catch-up across eighty updates.


Ordinary plain list edits, including splitting, removing, and rearranging list
items, may merge with disjoint prose changes. This allowance checks the affected
lines and leaves protected Markdown scopes (headings, links, code, HTML, tables,
and reference syntax) under their existing format checks. It does not infer
source identity from matching rendered text.
