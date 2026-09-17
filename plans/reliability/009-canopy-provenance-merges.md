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
shared-basis disjoint edits and immutable rule evidence. The [whole-entry lifecycle](../../docs/accepted-entry-conflicts.md) now joins durable
alternatives, snapshot attribution, authorized inspection and explicit resolution.
Entry-level coupled ancestors are implemented using schema 11 decisions and
derived inspection dependencies. Range-level ambiguity and broader correspondence
remain; merely persisting a conflict signal is insufficient. Installed clients
still emit snapshots.

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

**Deferred behind the two client goals.** Remaining fragment storage adoption,
migration and range/ancestor lifecycle work now belongs to
[Canopy storage 002](../canopy-storage/002-composable-conflict-fragments.md).
The requirements below inform that plan; they are not prerequisites for retiring
Native's stale-admission and rejected-update conflict paths. Continue only server
acceptance fixes needed by the actual client-emitted subset during that transition.

Coordinate the production storage design with [Canopy storage 001](../canopy-storage/001-pack-object-storage.md)
and [line provenance 006](../smaller-projects/006-line-provenance.md). Origin bindings
and unresolved alternatives add retention dependencies beyond ordinary roots;
retain independent deletion contributions, inverse fragments, restoration anchors
and undo activity even when they project to identical bytes or empty source;
packing must preserve them. Prototype state serialization is evidence for the
design, not a production layout or a reason to introduce packfiles prematurely.

The [durable fragment storage proof](../../docs/conflict-fragment-storage.md) validates
independent source choices, hidden and length-changing edits, and ancestor/opaque
replacement choices across restart. It is isolated from the host and schema. Use
that evidence when selecting production storage; selective undo, move/copy lineage,
storage growth and garbage collection remain unvalidated. Do not confuse its
exact-state mutation API with production stale-basis reconciliation.

- Integrate the tested region partition and composable fragment graph into the existing accepted transaction, inspection and guarded partial resolution; neither is yet used by acceptance. Preserve the existing snapshot/hidden-alternative and equal-root guarantees, including continuation after a selected fragment changes length. An ancestor resolution that discards unresolved descendants must guard those decisions in the same atomic update. Retain nested choices rather than enumerating whole-file combinations when an opaque replacement needs a larger decision.
- Atomically commit accepted state identity, provenance, projection, conflict signal, and watch observation. Use accepted-update CAS. Preserve exact-request replay and authorization of retained material.
- Extend the implemented accepted-state-scoped conflict inspection beyond entry decisions: locations, complete alternative identities, source/object references, selection, causal evidence, and explanation. Specify and fixture any additional read DTOs in TypeScript and Swift together before the UI consumes them; do not expose private graph internals or download a whole history to edit a file.
- Implement alternative-target edits and broader resolution forms on top of current whole-entry guarded resolution. Commit independent resolutions separately when appropriate; stale reviews retain the person's draft and all newer evidence.
- Define retention, compaction, backup, pruning, restart, and historical read semantics. Never compact unresolved alternatives or origins still needed by active references into an ordinary snapshot.

## 4. Rule selection and execution placement

Per-source-format rules own merge validity and resolution policy. The implemented
source-rule boundary accepts self-contained data and supports asynchronous evaluation;
keep causal correspondence and authority commits separate from format policy.
Remaining work:

- Add explicit Canopy defaults and per-tree rule selection/overrides when configuration
  is introduced. Keep rule identity/revision and evaluated inputs in accepted evidence.
- Allow rule/merge computation to move to a sidecar if useful. Keep authorization,
  accepted-state guards and atomic persistence in Canopy; validate returned objects
  and decisions before committing. Define cancellation, resource limits and worker
  failure behavior when implementing the process boundary.
- Preserve historical evidence across rule upgrades and configuration changes. A
  new rule must not silently reinterpret an old accepted decision or retry receipt.

## 5. Integrate and measure

Replace existing merge decisions incrementally behind the ordinary update path. Keep rejection for unsupported operations and invalid models. Measure merge latency, source-analysis cache use, provenance growth, conflict frequency, and false-merge regressions. Rehearse any storage migration on a copy with exact root/update/inventory comparison; do not reset live history as an optimization.

Run the focused merge corpus, transactional fault tests, cross-language protocol suite, and `DEVELOPMENT.md` gates. Compare full-suite failures to baseline. Record supported cases, bounded limitations, and migration evidence in status/docs before archiving the completed plan.
