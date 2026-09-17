# Merge operation evaluation

This is the implementation checkpoint for the tool-only work in
[Reliability 013](../plans/reliability/013-merge-operations-and-formats.md).
It runs in `codex/merge-tool`; it is not deployed. Canopy retention/activation is
[009](../plans/reliability/009-canopy-provenance-merges.md), and editor capture is
[008](../plans/reliability/008-enable-source-operations.md). No public Wire or client
state-machine change accompanies this checkpoint.

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
state }`, a generated-object manifest, decision proposals and evidence. Typed
inabilities are `invalid`, `missing-context`, `unsupported`, and `limit`.
Unsupported operation kinds are not successful no-ops. Invalid candidates or false
lineage do not publish staged output. Canopy decides admission and fallback; an
inability to evaluate is not a conflict resolution or an accepted receipt.

The tool verifies the complete candidate against the authored basis before
reconciliation. Its successful evidence distinguishes exact execution validation
from per-format automatic-resolution decisions. Evidence includes evaluated input
hashes, change/operation keys, rule revision, configuration and policy reasons.
A repeated contribution is not applied again; identical immutable requests replay
deterministically. Canopy still owns durable request receipts and accepted identity.

## Material and choices

Retained state is a hash-addressed implementation object. It contains entry
occurrences, immutable origin intervals, operation results, inverse material,
active deletion contributions, and proposed choices. These IDs are private to
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

The checkpoint is intentionally not the final storage contract. Partial copying
through a choice boundary currently needs additional alternative correspondence;
it returns `missing-context`. Broader structural-alternative addressing, arbitrary
nested continuation, and inverse/copy combinations still need the completion
corpus tracked in 013. Do not activate these semantics from this document alone.

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

Markdown/text may opt into `proseInsertions: "preserve-both"` for same-anchor
insertions. Ordering then uses contribution identity and is arrival-order
independent. The default remains review. This option never enables code/data
concatenation. Configuration is validated in the tool; future per-tree/default
selection belongs to Canopy.

Tree-sitter grammars/runtime and the strict XML parser are pinned package
dependencies. Only grammar modules are cached; parsed trees are disposed after
evaluation. Neither authored source nor parser IDs execute with host IO authority.
Existing collection schema evaluation remains in the QuickJS sandbox.

## Limits, staging and measurements

Requests are bounded to 8 MiB at the CLI, with at most 1024 operations. The evaluator
bounds distinct input and generated bytes, nodes, directory depth, elapsed time and
interval correspondence work. Parser-backed analysis caps source size at 256 KiB,
syntax traversal at 20,000 nodes, and each parse at 100 ms. Exceeding semantic engine
budgets returns `limit`; a format analyzer unable to prove independence preserves
choices. Canopy's worker supervisor retains its queue, timeout, kill and output
limits. No timeout can commit accepted state inside this process.

The Canopy adapter verifies the ordinary root and direct retained-state object
dependencies, including alternatives and inverse material, before releasing job
staging. Production reachability/GC leases, recursive retained-history validation,
and accepted transactions remain 009/storage work.

Repeatable checks:

```sh
bun test tests/unit/merge tests/integration/merge
bun tools/benchmark-merge-tool.ts
bun run typecheck
```

A September 17, 2026 local 32-edit run over a 65,536-byte file measured 32 ms cold,
6 ms median, 15 ms p95, 449,278 bytes for the final retained state, 7,546,110 total
immutable bytes and about 147 MB process RSS. These are synthetic library results,
not a production throughput claim or a storage migration recommendation. The
benchmark retains every intermediate state; packing/compaction remains separate.

Checkpoint verification: 899 product tests passed; the subsequent equal-byte
replacement/move regression passed in the focused suite. TypeScript checking,
build, full TypeScript/Swift protocol conformance, frozen installation and whitespace
checks passed. The repository-wide Markdown scan found no new broken relative links
(24 existing unresolved targets). This evidence is a checkpoint, not completion of
013 or live activation.
