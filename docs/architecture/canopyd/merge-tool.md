# Merge executable and shared objects

The reference implementation has a TypeScript merge package,
`@overstory/canopyd-merge`, and an `arbor-merge` executable script run by Bun.
canopyd runs it as a sidecar: one persistent worker with a bounded FIFO queue
and no fan-out. canopyd owns accepted history, causal reconstruction,
authorization, guards, conflict identity, retention, and atomic acceptance.
The executable owns the format rules and the tree merge computation. It has
no database connection or credentials in its API; it is a trusted local
worker, not an OS sandbox for arbitrary plugins.

## API and execution

```sh
bun run arbor-merge evaluate --objects /data/objects --staging /data/merge-jobs/example/objects
bun run arbor-merge serve --objects /data/objects --staging /data/merge-jobs/example/objects
```

`evaluate` accepts one JSON request on stdin and writes one JSON response on
stdout. Failures exit nonzero with diagnostics on stderr. `serve` accepts one
JSON request per line and returns one response per line, in order; an invalid
request returns `{ "error": { "message": "..." } }` and leaves the process usable.
Persistent callers own staging lifetime and serialization. canopyd
adapter keeps the worker alive across jobs, validates each result, then clears
staging before starting the next job. Timeouts and crashes are reaped before
cleanup; queued successors can start a replacement. canopyd shutdown drains the
active job, rejects queued work, and closes its worker. Custom executables retain
one-shot mode unless `persistent: true` is explicitly configured.

The [typed and validated contract](../../../packages/canopyd-merge/src/contract.ts) is the
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
durable identities itself. Account merge selection uses `account-config-v2`; authorization remains in canopyd before and after evaluation.
Authored execution and unresolved alternatives use the operation-bearing
tree request described under [operation evaluation](#operation-evaluation).

The rule revision identifies algorithm semantics; it is not a versioned client API.
Unrecognized rules, invalid responses or missing material fail evaluation. There
is no supported-operation advertisement to clients. Ship server support before
clients emit additional operations.

### Trusted semantic basis

For operation-bearing tree requests, the host supplies already validated
`base` and `current` state/root pairs within the named tree. canopyd derives them
from accepted records, validated legacy checkpoints, or validated earlier batch
results. They are not client-provided assertions. This is the worker contract;
there is no trust flag or optional untrusted-basis mode.

Exact-basis source execution loads active state and directory metadata to obtain
unchanged file hashes. It does not reread untouched file bodies or reconstruct
the entire basis to prove the state/root relationship again. Referenced bytes
remain hash-checked, operation selectors remain checked, and the computed result
must match the supplied candidate. canopyd still validates worker output and
retention before acceptance. General merges currently retain their full
projection work; extending incremental execution is separate remaining work.

## Historical checkpoints

canopyd reconstructs missing legacy semantic states with `checkpoint-batch`
requests containing an initial material reference and up to 64 ordered accepted
projections, change identities and legacy decisions. The worker applies the same
checkpoint semantics at each step and returns every intermediate state reference.
canopyd checks each against its accepted projection, then validates their combined
retention closure once before persisting objects and caching references.

Each batch retains at most 128 MiB of generated objects and 32 MiB of cached input
bytes. Exceeding the generated-object budget exits with code 75; canopyd retries a
smaller slice against the same basis. Other failures remain failures. These are
internal worker requests, with no public Overstory or database schema change.
Bun uses native SHA-256 with the same object identities as the portable fallback.

## Incremental retained state

Indexed state maps retain large history records through shared value pages.
Before/after piece sequences share unchanged pages across effects instead of
embedding a complete copy in every record. Readers retain compatibility with
inline history records and legacy state roots. These are internal object formats,
not changes to public update requests; old deployed binaries cannot read the new
formats after they have been written.

canopyd validates new history records and carries their typed dependencies with
that validation. Per-evaluation proofs survive until acceptance even when they
are too large for the optional cross-request cache. Material validation compares
against the preceding validated state; graph validation inherits unchanged
structure only from an accepted root. Retention independently checks availability
of staged dependencies before acceptance.

History validation proofs mirror the immutable radix tree. A parent references
child proofs instead of copying every descendant record, object hash, and
reference into flat collections. Synchronous lookup follows that tree; complete
enumeration remains available for audits and legacy consumers. The input's
expanded-byte and visit limits still apply, including on cache hits.

The history cache accounts for each reachable proof allocation once. Accepted
state-cache entries hold leases on their history roots, so evicting a lookup
entry cannot hide memory still retained by an accepted state. Shared history
uses the existing 256 MiB history budget; active state and material proofs use
the existing 64 MiB state budget. A lease that cannot fit is declined. Neither
budget was enlarged.

Retention always traverses indexed history as typed map nodes, including when a
semantic state proof is available. Durable subtrees are reusable by both hash
and history-field type. A staged sibling does not prevent an independent durable
branch from being certified. Pending publication obligations propagate to their
parents; repeated proposal checks cannot promote unpublished dependencies.
The host hash-checks all staged overrides before skipping certified subtrees.
Its cached checks need only the verified frontier and pending bytes, while a
fresh integrity audit still enumerates and checks the full closure.

Update diagnostics include `retention-visits` and `retention-map-hits` alongside
validation/retention timings and proof-cache hits/rejections. `history-mb` now
includes shared allocations held by state-proof leases. `proof-mb` and
`proof-bytes-last` account for the state-owned portion only, so their magnitudes
are not directly comparable with the earlier expanded-history charges. As with
the other diagnostic counters, multiple evaluations within one HTTP request
are summed.

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
full, never a hint; an absent trace is snapshot semantics. The protocol bounds
a trace to 64 frames and 1024 operations. `undoOperation` is not in the
grammar; editors express undo and redo as ordinary edits, and the evaluator
answers `unsupported` if it sees the kind. `composeFrames` in
`packages/canopyd/src/updates/source-edits.ts` collapses a run of plain
`editSource` frames into one by executing the composition; the same rule lets
clients compact a debounced burst (see [client state machines](../../implementing-editors/document-admission.md#trace-compaction)).

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
is not itself evidence of a concurrent conflict.

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
staging. Generated hashes already present in the shared store
reuse those verified bytes; canopyd reads returned hashes from staging or shared
storage. Neither process recopies existing immutable material into every job.
Request JSON contains no object-store filesystem paths.

canopyd creates a unique `/data/merge-jobs/job-*` directory, stages uncommitted input
objects, and records the request. The worker receives fixed paths, with a minimal
environment rather than inherited server credentials. canopyd validates the response
shape, rule identity, object hashes and result closure, then applies its normal
schema, boundary, authorization and guarded-acceptance checks. Returned objects are
retained in memory until canopyd durably stores them before the accepted transaction.
Writing an object alone never creates accepted state.

Normal and failed jobs remove staging in `finally`. A host crash can leave an
unaccepted job directory; after confirming no worker uses it, it can be removed.
The existing retained object store has no garbage collector: accepted input history
is not pruned during evaluation. A future collector must pin job inputs, staged
inputs, results awaiting commit, hidden alternatives and provenance dependencies;
the job manifest alone is not a completed GC lease protocol.

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
absolute executable script or program; programmatic options also accept fixed
arguments and worker limits. Arguments are never interpreted by a shell.

Install workspace dependencies with `bun install`. Collection schema compilation
resolves the worker's installed Zod, uses private temporary files, and evaluates
inside the existing memory/time-limited QuickJS sandbox. It does not depend on the
caller's working directory or execute authored schemas in the host runtime.

Ported behavior: Markdown additive merging and frontmatter/fence checks; stable-page
rename and directory reconciliation; keyed collection rows and schema/constraint
checks; account configuration v2 merging. Exact authored-operation execution, nested choices, and the
conservative format rules are described next.

## Verification

```sh
bun test tests/integration/canopyd-merge tests/unit/canopyd/update-merge.test.ts tests/unit/canopyd/source-reconciliation.test.ts
bun test tests/unit/canopyd-merge
bun tests/performance/benchmark-merge-tool.ts
bun run typecheck
bun run test:protocol
```

The corpus compares exact roots, bytes, decisions, and evidence against the
ported rules, exercises both execution modes, and checks concurrent staging,
corrupt objects, malformed output, nonzero exits, and forced timeouts. A real
HTTP case verifies accepted ambiguity, replay, continued publication, restart,
and integrity with a missing worker. A process test runs a collection merge
with an empty environment from a working directory outside the checkout.
`tests/unit/canopyd-merge/lazy-history.test.ts` compares every lazily loaded
result against an eager reference that reads all history.


Ordinary plain list edits, including splitting, removing, and rearranging list
items, may merge with disjoint prose changes. This allowance checks the affected
lines and leaves protected Markdown scopes (headings, links, code, HTML, tables,
and reference syntax) under their existing format checks. It does not infer
source identity from matching rendered text.
