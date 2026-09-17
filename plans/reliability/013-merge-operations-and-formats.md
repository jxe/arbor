# Reliability 013: Expand merge operations and format rules

Status: READY for phased work after the [merge-tool checkpoint](../../docs/merge-tool.md)
is reviewed and landed. Priority: P1. This plan owns the operation/format expansion
matrix; [008](008-enable-source-operations.md) owns client emission and operation
admission, [009](009-canopy-provenance-merges.md) owns authoritative reconciliation
and provenance, and [010](010-client-conflict-review.md) owns Native review. The
[packfile](../canopy-storage/001-pack-object-storage.md) and
[fragment storage](../canopy-storage/002-composable-conflict-fragments.md) plans own
storage evolution. None is a prerequisite merely to add a format rule.

## Goal and boundaries

Preserve exact intent across more edits and formats, automatically resolving only
when evidence and the selected rule justify it. Canopy retains authority; the merge
executable reads immutable material and proposes content and decisions. A format
rule may preserve duplication for prose but reject the same combination for code,
keyed records or binary formats. Ambiguity is an ordinary accepted state.

Inspect current code/tests before implementing each slice. The portable spec
specifies the goal state; do not weaken it to match the current executable. Reuse
material references and authored operations rather than introducing parser-specific
Wire identities or a second replacement language. Client-visible protocol changes
require paired TypeScript/Swift models, shared fixtures and reference API docs.
The internal executable protocol has no Swift consumer or client capability endpoint.

## 1. Establish an expansion corpus and richer rule inputs

- Record each case's exact base/current/incoming bytes, authored operations and
  provenance, expected preserved contributions, accepted alternatives, and allowed
  automatic decisions. Test both arrival orders when semantics permit; explicitly
  document any projection-order policy instead of confusing it with lost intent.
- Extend normal rule input objects to expose unresolved alternatives, their material
  bindings and dependencies when a rule needs them. Keep accepted-state identity
  distinct from projection bytes. Do not send database rows or the entire history.
- Preserve each change's authored basis and causal ordering, including operation
  outputs used by later operations. Make missing context explicit; never fabricate
  lineage from matching text. A supplied proposal is evidence to validate, not
  permission to assume it preserves every contribution.
- Define new/retained/resolved decision proposals without letting the executable
  mint accepted identities. Existing choices survive omission. Automatic dispositions
  need explicit evidence and Canopy policy validation; guarded user resolutions
  remain Canopy-owned. Model coupled decisions without enumerating all combinations.
- Keep a common result/evidence envelope with open rule-specific details. Capture
  selected rule identity, revision, configuration and evaluated material so an
  upgrade does not reinterpret historical accepted results or request receipts.

Gate: hidden-alternative edits, equal-root/different-state inputs, mixed snapshot
and operation histories, coupled directory choices, replay and missing context all
preserve contributions through both the library and process boundary.

## 2. Expand operation families in vertical slices

Each row is a separately reviewable slice: define/fixture semantics, implement exact
execution and safe reconciliation in Canopy/the tool, then enable client emission.
Backend support ships first; no operation-advertisement API or coordinated client
cutover is required. Unsupported or invalid authored operations remain explicit
admission errors; valid operations whose overlap is uncertain become accepted choices.

| Operation family | Required behavior and adversarial cases |
| --- | --- |
| Broader `editSource` | Exact UTF-8 selections, insert/delete/replace, multiple edits, CRLF and no trailing newline; carry intent across retained predecessors. Equal-byte edits retain provenance. Concurrent same-anchor inserts and duplicate passages need explicit policy. |
| Entry move/rename | `moveEntry` preserves identity through concurrent descendant edits. Divergent destinations, name collisions, cross-directory moves and delete/move remain coupled when needed. Never cross a TreeID boundary implicitly. |
| Entry copy | `copyEntry` creates distinct lineage. Later edits must distinguish original and copy even when bytes and names match. Copies of unresolved material retain the appropriate choices rather than accidentally resolving them. |
| Source move/copy | `moveSource` and `copySource` use validated source/destination references and before/after anchors. Cover edits inside moved material, competing moves, vanished anchors, repeated text, and edits to only one copy. |
| Structural remove/replace | `removeEntry` and `replaceEntry` preserve delete/edit alternatives, file/directory transitions, collection metadata and nested choices. Whole-directory replacement must account for every dependent decision it discards. |
| Operation-result and alternative references | Target earlier operation material and selected or hidden alternatives without guessing by projection path. Distinguish editing an alternative from resolving a decision. Support composed batches atomically where required. |
| Selective undo | `undoOperation` targets a causal contribution, not an old snapshot. Retain independent later edits, competing deletions, restoration anchors and undo activity even when bytes are unchanged. Coordinate retention with storage plans before client activation. |
| Composite transformations | Split/join blocks, list conversion, extraction and symbol rename should first compose existing operations plus exact lineage. Add a new operation only when a concrete case cannot be faithfully expressed; update the goal spec and both clients together. |

Gate per row: exact execution, interleaving, alternative preservation, restart,
request replay, dependent batch elements, stale resolution guards, and independent
publication while choices remain open. Maintain unsupported-case fixtures until a
slice is enabled; never claim syntax parsing alone establishes safe merge semantics.

## 3. Add format and language rules

Start with the first three rows, then choose language priorities from actual Arbor
usage. Parsing and serialization must preserve unmodified bytes and opaque syntax.
Rule selection can inspect source structure; an extension alone is not proof.

| Format | First useful rules | Cases that must remain explicit |
| --- | --- | --- |
| Markdown | Paragraph/list-item edits and moves, headings, tasks, frontmatter, tables, links and fences. Preserve authored source and distinguish embedded code from prose. | Repeated blocks, heading identity uncertainty, competing list order, broken fences, ambiguous link targets. Duplication may be appropriate for prose, not automatically for frontmatter or code. |
| JSON / JSONL | Independent object keys, schema-keyed records and field changes; JSONL record identity only when established. | Duplicate keys, missing/nonunique record keys, delete/edit, array order and competing scalar values. Do not turn arbitrary arrays into sets. |
| YAML / TOML | Independent mapping fields with exact comments, quoting and source preservation. | YAML aliases/anchors, merge keys, tags, duplicate keys, implicit types, multiline scalars and order-sensitive sequences. Decline unsupported constructs without normalizing them away. |
| CSV / TSV / collections | Extend existing schema/primary-key row rules to field-level edits, ordering policy and safe schema changes. | Key changes/collisions, row deletion, unique/foreign-key constraints, delimiter/quoting fidelity and incompatible schemas. |
| TypeScript / JavaScript | Parser-backed nonoverlapping syntax changes, imports and independently edited members; use binding information for rename/move. | Duplicate declarations, export changes, overloads, shadowing, side-effect imports and order-sensitive initialization. Successful parsing is necessary but insufficient. |
| Swift | Independent declarations and members, imports and structurally verified moves; preserve comments and conditional compilation. | Overloads, extensions, access control, property wrappers, macros and changed bindings. Resolve only with adequate language context. |
| Python and other code | Add one parser-backed language at a time using the same evidence contract; begin with independently scoped changes. | Python indentation/decorators/import effects, dynamic bindings and constructs the analyzer cannot prove independent. No generic concatenate-both code rule. |
| HTML / XML / CSS | Validated element/attribute or selector/declaration identity and source-preserving edits. | Repeated siblings, namespaces, significant order, CSS cascade and duplicate properties. |
| Binary/media | Opaque replacement choices first; exact identical-result coalescing must preserve provenance. Later add specific container/metadata rules only with validated codecs. | Never concatenate arbitrary bytes. Renames, copies and independent entries can merge without claiming competing binary content can. |

Embedded languages delegate only well-identified regions, preserving their host
syntax and mapping evidence back to original material. Executable/custom schema
validation remains sandboxed; project code must not run with Canopy authority.

## 4. Select, measure and deploy rules independently

- Add Canopy defaults and per-tree rule/configuration overrides. Rule revisions and
  configuration must be retained with decisions. Default conservatively when no rule
  applies; do not make Native or filesystem clients duplicate format policy.
- Measure cold-start latency, request/object IO, parser memory and real merge load.
  Keep on-demand execution unless a measured workload benefits from a supervised
  persistent worker. If adopting a sidecar, define session/job ownership, cancellation,
  restart, bounded concurrency and staging cleanup using the same evaluation contract.
- Before introducing object GC or packfiles, implement leases for active input graphs,
  staged inputs, generated output awaiting commit and retained alternative/provenance
  roots. Rehearse crash, orphan-job cleanup, backup and pruning; shared object access
  alone is not a retention protocol.
- Roll out one operation/format slice at a time. Preserve old rule evidence and exact
  retries. New executables may add rules before Canopy selects them; clients emit new
  operations only after deployed server support is verified. No client cutover for a
  rule-only improvement.

## Verification and completion

Extend the golden corpus with both intended resolutions and intentional refusals.
False automatic resolution is the primary regression; track it separately from merge
coverage. Include generated/differential cases for duplication, causality, paths,
source fidelity and language scope. Check exact bytes, contributions and alternative
sets, not only rendered content or parse success.

Run library/process parity, worker-failure acceptance, Canopy integration,
protocol fixtures and applicable [development gates](../../DEVELOPMENT.md). Measure
large inputs and bound resource use. Record each delivered slice and limitations in
status/docs; remove its remaining-work entries here. Archive this plan only when its
chosen scope is complete, without claiming every language is universally mergeable.
