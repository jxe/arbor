# Reliability 009: Use source intelligence and provenance in Canopy

Status: IN PROGRESS. The first shared-basis disjoint-source rule is implemented alongside [008](008-enable-source-operations.md). Priority: P1. This plan owns server reconciliation, accepted conflicts, and explanation evidence. [010](010-client-conflict-review.md) consumes that evidence.

## Outcome

Preserve what each author changed and why that change targets particular material. Merge independent work precisely; when evidence cannot justify a merge, retain the alternatives and explain the ambiguity. Combine source analysis at Canopy with explicit editor operations. Neither source heuristics alone nor an operation graph alone is sufficient.

Read current source/tests before relying on the [conflict terms experiment](../../docs/conflict-terms-experiment.md) or [intent comparison](../../docs/conflict-intent-comparison.md). They are isolated models, not production backends. Keep the public [source-intent contract](../../spec/10-source-intent.md) independent of the chosen storage/algebra.

Follow [011](011-compatible-accepted-ambiguity.md) for staged compatibility
and activation. Format rules must distinguish resolved, unresolved and inapplicable
outcomes; record guarded automatic resolutions explicitly rather than relying on
term cancellation or byte equality. Independent decisions and dependencies must
remain representable without enumerating whole-document alternatives.

The [source execution checkpoint](../../docs/exact-source-execution.md) records the
implemented subset: accepted-identity ancestry, original contribution retention,
shared-basis disjoint edits and immutable rule evidence. Overlap still returns a
conflict response. Durable alternatives must ship with ordinary snapshot attribution
and authorized accepted-state inspection; merely persisting a conflict signal is
insufficient. No live deployment or client emission has been enabled.

## 1. Establish the decision corpus

Turn the thought experiments into end-to-end fixtures with exact base, candidates, operations, arrival permutations, expected ordinary projection, retained alternatives, and provenance. Cover at least:

- Move plus edit, rename plus edit, reorder of identical paragraphs, nested list movement, and cross-file movement.
- Copy versus move with identical final bytes; independent edits after a copy.
- Delete versus a concurrently created child, overlapping edits, concurrent inserts at one anchor, and duplicate headings/keys.
- Frontmatter/schema changes, Markdown fences, links and embedded boundaries, collection keys/constraints, binary changes, and malformed source.
- Editing an alternative back to base bytes, editing a nonselected alternative, resolving one conflict while another remains, and stale review against a changed alternative set.
- Undo after independent edits; successive merges and partial resolutions; metadata-only transitions; pruned or unavailable ancestry.

Assert order independence where the operations commute, idempotency of exact replay, and preservation of all independent contributions. Do not require arbitrary projection choices to be identical unless the contract promises that ordering. Track automatic-merge coverage separately from false merges; false merges are the critical failure.

## 2. Build source correspondence with explicit evidence

- Analyze exact source objects and cache by hash and analyzer implementation, with bounded work. Start with Markdown/frontmatter and existing collection-file semantics. Preserve authored bytes and opaque unsupported syntax.
- Treat structural identity as evidence: headings, paragraph/list structure, persistent page IDs, record keys, and symbol binding where a real parser exists. Repeated equal content and nonunique names remain ambiguous. Never use rendered text or a similarity score as an identity guarantee.
- Prefer verified operation lineage over heuristic correspondence. Translate edits through verified moves; create distinct identities for copies. Use source intelligence to resolve missing snapshot correspondence conservatively and validate editor claims.
- Record why each alignment/merge was chosen and which source ranges or operations justify it. Keep parser output replaceable; no backend node IDs become Wire identities.

Acceptance: adversarial duplicate-content tests, exact UTF-8/source round trips, and bounded performance for large files and long histories. Instrument ambiguous and unsupported cases rather than hiding them in “merged” counts.

## 3. Persist composable unresolved state

Coordinate the production storage design with [Canopy storage 001](../canopy-storage/001-pack-object-storage.md)
and [line provenance 006](../smaller-projects/006-line-provenance.md). Origin bindings
and unresolved alternatives add retention dependencies beyond ordinary roots;
retain independent deletion contributions, inverse fragments, restoration anchors
and undo activity even when they project to identical bytes or empty source;
packing must preserve them. Prototype state serialization is evidence for the
design, not a production layout or a reason to introduce packfiles prematurely.

Choose the smallest production representation that passes the corpus: composable conflict expressions with provenance may be sufficient; use a richer operation graph where tests demonstrate the need. Compare these choices on nested conflicts, selective undo, move/copy lineage, storage growth, and garbage collection before committing to a graph implementation.

- Store alternatives and their origins independently of the ordinary projected root. Ordinary updates must preserve hidden alternatives; equal roots must not clear them.
- Atomically commit accepted state identity, provenance, projection, conflict signal, and watch observation. Use accepted-update CAS. Preserve exact-request replay and authorization of retained material.
- Expose bounded, accepted-state-scoped conflict inspection: locations, complete alternative identities, source/object references, selection, causal evidence, and explanation. Specify and fixture any additional read DTOs in TypeScript and Swift together before the UI consumes them; do not expose private graph internals or download a whole history to edit a file.
- Validate explicit alternative edits and resolution using exact accepted state and reviewed alternative-set guards. Commit independent resolutions separately when appropriate; stale reviews retain the person's draft and all newer evidence.
- Define retention, compaction, backup, pruning, restart, and historical read semantics. Never compact unresolved alternatives or origins still needed by active references into an ordinary snapshot.

## 4. Integrate and measure

Replace existing merge decisions incrementally behind the ordinary update path. Keep rejection for unsupported operations and invalid models. Measure merge latency, source-analysis cache use, provenance growth, conflict frequency, and false-merge regressions. Rehearse any storage migration on a copy with exact root/update/inventory comparison; do not reset live history as an optimization.

Run the focused merge corpus, transactional fault tests, cross-language protocol suite, and `DEVELOPMENT.md` gates. Compare full-suite failures to baseline. Record supported cases, bounded limitations, and migration evidence in status/docs before archiving the completed plan.
