# Merge operation evaluation

This records the completed tool-only scope of
Reliability 013 (completed plan, deleted; see git history).
It runs in `codex/merge-tool`; it is not deployed. Canopy integration is described in the [authority checkpoint](merge-authority-integration.md);
future retention extensions remain in [009](../plans/canopy/009-canopy-provenance-merges.md), and editor capture is
[008](../plans/canopy-swift/008-complete-native-move-copy-undo-capture.md). No public Wire or client
state-machine change accompanies this implementation.

## One evaluator

The [existing process API](merge-tool.md) remains one evaluator. A tree request
can now carry authored operations, rather than invoking a second version or
compatibility service:

```ts
{
  kind: "tree",
  tree: "tree-scope",
  base: { object: baseRoot, state: retainedToolState },
  current: { object: currentRoot, state: retainedCurrentToolState },
  incoming: {
    object: exactCandidateRoot,
    change: "authored-change",
    operations: [/* exact Wire SourceOperation values */],
    resolves: [/* optional tool decision keys whose guards Canopy checked */]
  },
  rules: {
    id: "tree-default", revision: 1,
    config: {
      maxBytes: 33554432, maxNodes: 20000, maxMillis: 5000,
      formats: { "/records.csv": { format: "csv", recordKey: "id" } }
    }
  }
}
```

Without `operations`, tree requests evaluate ordinary snapshots using the ported
rules. Source-proposal validation and account rules also use the same executable.
These are different inputs/rules, not independently deployed old/new engines.

A first basis can omit `state`. Subsequent evaluations retain the returned state
object alongside its root. Equal roots never imply equal retained intent. Without
causal correspondence across distinct snapshot roots, the evaluator preserves a
coupled choice. It does not invent editor operations from a diff.

Successful operation evaluation returns `outcome: "evaluated"`, `result: { object,
state }`, `authored: { object, state }` for the exact candidate before reconciliation,
a generated-object manifest, decision proposals and evidence. Typed
inabilities are `invalid`, `missing-context`, `unsupported`, and `limit`.
Unsupported operation kinds are not successful no-ops. Invalid candidates or false
lineage do not publish staged output. Canopy decides admission and fallback; an
inability to evaluate is not a conflict resolution or an accepted receipt.

The tool verifies the complete candidate against the authored basis before
reconciliation. Its successful evidence distinguishes exact execution validation
from per-format automatic-resolution decisions. Evidence includes the three evaluated
input roots (base, current and incoming tree objects), change/operation keys, rule
revision, configuration and policy reasons. The rule is deterministic, so the three
roots reproduce every object it read; the read set itself is not retained (it was,
until migration 013 compacted it).
A repeated contribution is not applied again; identical immutable requests replay
deterministically. Canopy still owns durable request receipts and accepted identity.

## Operations as frames

Since [Canopy 010](../plans/canopy/010-operation-frames-and-lazy-history.md)
Phase 1, the evaluator reads a change's operations as a **trace**: a chain of
frames, each carrying the operations that take one tree root to the next.

```ts
type Frame = { before: TreeRoot; after: TreeRoot; operations: SourceOperation[] };
```

- `trace[0].before` is the request's base root and the last frame's `after` is
  the candidate; each frame's `before` is its predecessor's `after`.
- References are frame-local. A basis reference in a frame names an object in
  that frame's `before` tree; an operation reference names an earlier key in the
  same change, in any frame. Two traces therefore concatenate without rebasing,
  which is what lets a client coalesce debounced editor generations instead of
  recomposing ranges across them.
- Operation keys are unique across the whole trace, because a key names one
  authored contribution of the change.
- Every frame must reproduce its own `after`. A frame whose operations project
  to anything else fails with "Frame does not reproduce its result"; the last
  frame keeps the evaluator's existing candidate check, which runs after
  decisions propagate and retained deletions are enforced. Operations remain
  checked evidence, never hints: a trace that is absent (or empty) is snapshot
  semantics, exactly as `operations: null` is today, and a trace that is present
  is validated in full.
- `undoOperation` has left the grammar for the evaluator. Editors express undo
  and redo as ordinary edits against the generation they are undoing, so there
  is no causal inverse to evaluate. The Wire contract still decodes the kind
  until the Phase 2 clean break; the engine answers `unsupported`.

The exact-basis fast path takes traces too. It applies each frame in order
against the previous frame's result, carrying the projected file material
forward instead of re-deriving it, and checks each frame's root as it goes.
Its decline reasons are unchanged except for a new reason 8, a trace that does
not start at the request's basis.

`packages/canopyd/src/updates/source-edits.ts` exposes the same shape for exact
source execution: `validateSourceTrace` runs the per-frame candidate check with
each frame's generated objects available to the next, and `composeFrames`
collapses a chain of plain edits into one frame, proving the composition by
executing it. The rule is the one both clients apply when they compact a trace
(plan 010 Phase 3): every operation must be a lineage-free `editSource` over
`basis` material with a range; per path, the generations compose through
`composeSourceEdits` in `@overstory/protocol`, which needs no intermediate bytes
because it models the original as copied ranges and inserted text; the
composed operations are keyed `edit-0-<i>` in output order and name each
path's object in the first frame; and a plain chain that ends at the root it
started from composes to no operations. Lineage, copies and operation
material name the generation they were captured against and are refused
rather than rebased. `conformance/source-admission-queue.json` (`traces`)
holds the vectors shared by `composeFrames`, the Swift queue and the
TypeScript queue.

Since Phase 2 the wire carries `trace` (up to 64 frames, 1024 operations) and
the receipt domain is `arbor-update/2`. Since Phase 3 a client that coalesces a
debounced burst emits one frame per editor generation and compacts adjacent
plain frames by the rule above, so a typing burst arrives as one frame while a
generation with lineage or copies keeps its own frame against the exact
intermediate root. The update log's `trace-frames` and `trace-ops` show the
chain a request carried.

## Material and choices

Retained state is a hash-addressed implementation object. It contains entry
occurrences, immutable origin intervals, operation results, inverse material,
active deletion contributions, exact authored operation objects and basis references,
immutable submitted envelopes with causal bases, and proposed choices. These IDs are private to
this evaluator, not Wire identities or parser node IDs. Copies receive new
origins; verified moves and preservation lineage retain existing origins.

All eight operation kinds execute. Tests cover dependent operation results,
empty result anchors, UTF-8 boundaries, exact CRLF/BOM source, entry and source
move/copy, replacement/removal, selective undo and redo. The earlier source-intent
experiment's lineage and source-transfer corpus is exercised in both arrival
orders. In particular, copying freezes the observed source, while moving transports
interior edits. Undoing one independent deletion does not undo another.

Text choices identify immutable basis ranges and their material alternatives.
Independent overlaps can remain separate decisions; a format refusal can couple
the file. Structural ambiguity couples the containing tree rather than claiming
independent placements. The ordinary projection currently prefers incoming material;
this projection policy is separate from commutativity of independent changes.

Explicit alternative bindings map Canopy's authorized material references into the
retained proposal. Each binding supplies `ref`, tool `decision`, `alternative`
(index), and `value: { object, kind }`; the evaluator checks the retained material.
Editing a hidden alternative can change `state` without changing `object`.
Editing the selected value back to ancestral bytes does not resolve its sibling.
Copying a conflicted file creates independent decisions for the copy.

Opaque transformations can enclose existing source decisions. An enclosing choice
retains the old context and depends on the enclosed decisions; hidden edits update
its retained branch. Resolution declarations are separate from editing operations.
The evaluator checks that declared decisions still match the basis and requires
coupled declarations when discarding dependent choices. It does not authenticate
public resolution guards; Canopy must do that before accepting a proposal.

Partial copying through a choice boundary executes the literal authored copy and
retains a coupled decision when correspondence into the other value is ambiguous.
Whole copies, including empty selected values, receive distinct choices. Structural
alternatives support descendant addressing. Hidden changes propagate through nested
source and structural contexts; generated tests cover up to five enclosing decisions.
Keeping an enclosing alternative can preserve an unresolved child; discarding it
requires a guarded declaration for that child as well.

Selective undo preserves independent edits and deletion contributions. If later work
interferes with the inverse, the tool retains the pre-undo tree as an alternative;
it does not silently discard that work. Choices may be coarse when correspondence
is insufficient. Retained inverse material is required. The state objects are a
private implementation format, not the final Canopy storage contract. Installation,
recursive retention and public resolution authorization remain Canopy work in 009.

## Format support contract

Rules preserve bytes by applying verified source spans. They do not print or
normalize parsed trees. Parser success alone is insufficient for automatic merging.
The following are the implemented automatic subsets; other simultaneous changes
retain alternatives. Exact authored operation execution is independent of these
policy restrictions.

| Format | Automatic subset | Requires review |
| --- | --- | --- |
| Text | Disjoint verified origins, including retained lineage and transport | Overlaps and competing anchors by default |
| Markdown | Stable host structure; prose, heading/list text, task values and simple table cells; independent embedded regions; concurrent known embedded edits delegate to their format | Structural delimiter/order changes, ambiguous links, escaped tables and unsupported embedded combinations |
| JSON | Different values under unique, unchanged object-key paths | Duplicate keys, array ordering, key creation/removal or competing values |
| JSONL | Independent record fields with configured unique `recordKey` and stable order | Missing/nonunique keys, key/order/schema changes |
| YAML | Different mapping values with unique stable keys and preserved source | Anchors, aliases, tags, sequences, multiline scalars and parse warnings |
| TOML | Different mapping values under stable unique tables/keys | Dotted keys, arrays, multiline constructs and structural changes |
| CSV/TSV | Different cells with configured unique `recordKey`, unchanged header and row order | Key/schema/order changes, malformed quoting and duplicate keys |
| TS/JS, Swift, Python | Parser-backed literal changes in distinct uniquely named declarations or supported members; syntax and binding topology remain unchanged | Binding/operator/import/export changes, overloads, decorators, macros, wrappers, directives and ambiguous declarations |
| HTML | Different values under unique element/attribute structure with unchanged order | Repeated unkeyed siblings, duplicate IDs, scripts/styles and event handlers |
| XML | Distinct values in a strict, uniquely structured namespace-free document | Namespaces, DTDs/entities and repeated sibling identity |
| CSS | Different unique declaration values with stable selectors/properties/order | Duplicate declarations, variables, unsupported selectors and cascade-changing structure |
| Binary/media | Entry move/copy and independent tree changes | Competing opaque content; no byte concatenation |

The `markdown-source-transfer` rule evaluates identity-verified move/copy replay
separately from ordinary edit independence. It permits plain and self-contained formatted paragraph transfers
alongside independent prose edits, including cross-document transfers, when all
four versions (basis, current, authored, replayed) preserve protected host blocks
and embedded content. It preserves the existing raw bytes; the policy signature
is only a safety check, never a correspondence or identity heuristic. Unchanged
headings, frontmatter and fenced code can remain beside transferred paragraphs.
Complete emphasis, inline code and absolute HTTP(S)/mailto link spans may travel
with paragraphs. Reference and relative links still require binding evidence.
Changing protected blocks or transferring list/table structure still requires review.
HTML and incomplete opaque syntax protect their local region (or unclosed suffix),
so unaffected prose elsewhere can merge. Invalid UTF-8 remains unsupported. JSON/YAML/code/binary
source transfers remain conservative until their own structural proofs exist.

Successful replay does not order competing destinations: same-anchor source
transfers and competing moves still require review. This is distinct from the
ordinary prose-insertion policy below. File-format overrides apply to both rules;
Canopy-wide/per-tree configuration remains future work. This transfer refinement
has not been deployed.

Markdown defaults to `proseInsertions: "preserve-both"`: competing additions of
ordinary prose, new paragraphs and list/task items (including formatted items and
shallow nested lists) are preserved in stable
contribution order, independent of arrival order. Exact authored bytes are retained;
the tool does not add separators, deduplicate equal text or clear existing choices.
The insertion rule records the effective policy in its evidence. Set
`proseInsertions: "review"` to require review instead. Plain text retains the review
default and can opt into preserve-both.

Complete self-contained inline spans may be inserted, but insertion inside a code
span or link remains conservative. The policy excludes frontmatter, fences, tables,
indented code, reference links and unsupported Markdown syntax. Opaque HTML regions
are bounded locally; unclosed regions protect the remaining suffix. Structured
formats cannot opt into prose concatenation. Replacement conflicts and mixed changes
whose structural independence is unproved still retain choices. Configuration is
validated in the tool; future per-tree/default selection belongs to Canopy.

Tree-sitter grammars/runtime and the strict XML parser are pinned package
dependencies. Only grammar modules are cached; parsed trees are disposed after
evaluation. Neither authored source nor parser IDs execute with host IO authority.
Existing collection schema evaluation remains in the QuickJS sandbox.

## History is read on demand

Retained state has two parts: active material (nodes, decisions) and five
history maps (`outputs`, `effects`, `origins`, `alternatives`, `changes`),
each stored as a hash-partitioned map of immutable records. A state is marked
`editable` when the evaluation that recorded it enforced every deletion in its
effects map on its nodes: fast-path results, and full-evaluator results whose
nodes are the authored or merged state. Transported results, results that keep
the current nodes under `conflictProjection: "current"`, and checkpoint or
imported states are not editable.

When the base is editable, the full evaluator loads active material whole and
history maps as read-through views:

- It re-enforces only effects the base does not hold. Those are found by
  diffing map roots, which skips identical buckets by hash; the base's own
  deletions are already reflected in the nodes every branch starts from.
- It loads up front what the request names: its change identity, its operation
  identities, and the operation or alternative material it cites. It walks
  origin chains before its bounded origin walks, and loads the effect of each
  inserted piece before deciding whether an insertion is an attachment.
- Reading a record that was not loaded is an evaluator error, never "absent".
- Results are stored by path-copying the written buckets onto the loaded map.
- Base and current are accepted pairs the host validated on acceptance, so
  their file hashes come from each root's directory metadata rather than from
  rebuilding every file, as the exact-basis path already does.

A base that is not editable takes the complete scan once; its result is
editable from then on. The outcome is identical either way:
`tests/unit/canopyd-merge/lazy-history.test.ts` compares every accepted result, decision
and operation list against an eager reference that reads and re-enforces all
history (`mergeIntent(..., { eager: true })`). Authority validation in Canopy
still reads whole states; making it lazy is Phase 5 of plan 010.

## Limits, staging and measurements

Requests are bounded to 8 MiB at the CLI, with at most 1024 operations. The evaluator
bounds distinct input and generated bytes, nodes, directory depth, elapsed time and
interval correspondence work. Parser-backed analysis caps source size at 256 KiB,
syntax traversal at 20,000 nodes, and each parse at 100 ms. Exceeding semantic engine
budgets returns `limit`; a format analyzer unable to prove independence preserves
choices. Canopy's worker supervisor retains its queue, timeout, kill and output
limits. No timeout can commit accepted state inside this process.

The Canopy adapter verifies the ordinary root and direct retained-state object
dependencies, including alternatives, authored operations/envelopes and inverse material, before releasing job
staging. Production reachability/GC leases, recursive retained-history validation,
and accepted transactions remain 009/storage work.

Repeatable checks:

```sh
bun test tests/unit/merge tests/integration/merge
bun tools/benchmark-merge-tool.ts
bun run typecheck
```

A September 17, 2026 local 32-edit run over a 65,536-byte file measured 10 ms cold,
6 ms median, 12 ms p95, 455,070 bytes for the final retained state, 7,664,600 total
immutable bytes and about 150 MB process RSS. Parser samples measured TypeScript
13 ms cold / 0.26 ms warm median, Swift 8 ms / 0.32 ms, and Python 1.7 ms / 0.14 ms.
RSS reached about 252 MB after loading all three grammars. These are synthetic
library results, not a production throughput claim or a storage recommendation.
The benchmark retains every intermediate state; packing/compaction remains separate.

Verification covers the original exploratory corpus, all operation families,
all format rows, generated Unicode/line-ending and arrival-order combinations,
deep choices, exact operation retention, malformed syntax, binding changes and
explicit refusals. The 158 focused tests pass, including identical successful and
typed-refusal results through library, fresh worker and persistent worker, plus
Canopy staging validation and conservative worker-failure acceptance. Final
repository gate results for the original milestone are recorded in the archived plan.
The lenient Markdown default follow-up passed 953 product tests, type checking, build
and the relative-link/whitespace checks. This is not live activation.
