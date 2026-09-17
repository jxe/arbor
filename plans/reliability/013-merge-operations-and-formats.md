# Reliability 013: Complete merge-tool operation and language support

Status: IN PROGRESS on `codex/merge-tool`. Priority: P1.
This is the tool-only track of three plans: [008](008-enable-source-operations.md)
owns client capture/submission on main; [009](009-canopy-provenance-merges.md) owns
Canopy retention, forwarding, authority and deployment on main. This plan owns
`@arbor/merge`: operation interpretation, source correspondence, format/language
policy and proposed results. The [process checkpoint](../../docs/merge-tool.md) is
implemented; its deployment is 009's task, not a prerequisite for this development.

## Current checkpoint and remaining gates

The [operation evaluation checkpoint](../../docs/merge-operation-evaluation.md)
implements all operation kinds, immutable interval correspondence, source choices,
selected/hidden continuation, enclosing deletion, selective undo, pinned parsers and
conservative automatic subsets for every format row below. The original source-intent
lineage/transfer corpus runs in both arrival orders. Library, fresh/persistent process
and Canopy staging parity are tested. This plan remains open: an implemented syntax
row is not by itself proof of the full lifecycle contract.

Remaining completion gates include partial choice copying, structural-alternative
material addressing, arbitrary nested continuation/resolution, operation inverses
across those choices, broader generated adversarial cases, and final verification.
Record explicit refusals separately from successful merges; do not silently count
missing semantic context as completed operation support.

## Outcome and meaning of full support

Implement every operation family in the [goal contract](../../spec/10-source-intent.md)
and the format/language matrix below, with exact execution, reconciliation and
explicit ambiguity. Full support means valid inputs have defined, source-preserving
behavior and uncertain cases preserve choices; it does not mean every conflict can
be automatically resolved or that every programming language is semantically decidable.
Maintain explicit syntax/subset coverage per language and extend the matrix as real
usage requires. Invalid execution and missing context are distinct from ambiguity.

Build against self-contained fixtures and shared immutable objects without waiting
for editor capture, Native review or production Canopy changes. Canopy owns accepted
identity, authorization, guards, durable state and retention. The tool never connects
to its database or reimplements those authorities. Rule-specific evidence can remain
open within a common request/result contract.

## 1. Complete the evaluation model and golden corpus

- Extend base/current/incoming material to include relevant unresolved alternatives,
  dependencies, exact authored operations, bases and causal order. Coordinate the
  common envelope with 009; interpret operation payloads here. Recorded claims are
  not validated merely because Canopy retained them.
- Execute known operations against their exact bases and verify declared candidate
  coverage, output bindings and lineage. Never infer a complete operation list from
  equal bytes or silently ignore an unrecognized operation. Return a typed inability
  to evaluate when context or semantics is missing; Canopy owns fallback acceptance.
- Distinguish execution validation from reconciliation and automatic resolution.
  Support collection-only/shadow use by returning proposals/evidence without any
  accepted-state side effects. Do not retroactively reinterpret old receipts.
- Describe new, retained and resolved decision proposals using material references,
  selected projections and dependencies. Keep durable identity assignment in Canopy.
  Existing choices survive omission; source/file/directory decisions may be coupled.
- Build golden inputs with exact bytes, operations and provenance, expected results,
  contributions and preserved alternatives. Test relevant arrival orders and exact
  replay; document projection-order policy separately from commutativity.
- Maintain library/process parity and bounded evaluation. References identify immutable
  bytes, while causal context establishes meaning. Do not require full database
  histories, parser-internal identities or a new replacement language.

Gate: hidden-alternative edits, equal-root/different-state inputs, snapshot barriers,
missing context, candidate mismatch, false lineage, dependent operations and coupled
choices have explicit tested outcomes before broader rule activation.

## 2. Implement every operation family

Deliver each row as exact execution plus semantic reconciliation and adversarial
fixtures. Tests may author operations directly; no client implementation is needed
to prove tool behavior. 009 handles installation/activation and 008 handles capture.
The retained operation envelope may ship before these semantics, allowing real intent
to be collected without incorrectly claiming it has already been validated.

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


For each family test concurrent and sequential combinations, deleted/moved anchors,
independent contributions after copies, equal-byte intent, UTF-8 boundaries, nested
TreeID boundaries and explicit alternatives. Undo requires supplied retained inverse
material; return missing-context rather than inventing it. Operation execution must
not normalize untouched source.

## 3. Build source correspondence and composable decisions

- Prefer verified lineage over heuristic correspondence. Use headings, list structure,
  stable page IDs, record keys and language bindings as evidence with known scope.
  Repeated text and nonunique names remain ambiguous; similarity is not identity.
- Translate edits through verified moves and structural transformations; copies get
  distinct lineage. Align snapshot changes conservatively when explicit operations
  are unavailable, retaining uncertainty instead of synthesizing authored intent.
- Propose independent fine-grained choices where justified and coupled decisions where
  needed, without enumerating every whole-document combination. Handle hidden and
  selected alternatives, opaque replacement and parent/child dependencies.
- Explain alignments, rule decisions, evaluated inputs and configuration. Parsing and
  automatic-resolution policy remain separate: duplication may be valid prose but
  invalid code or keyed data. Merely editing an alternative is not resolution.
- Keep parser caches disposable and keyed by content, analyzer revision and relevant
  context/configuration. A parser cache cannot become authority for material identity.

Tool fixtures can prove finer-grained behavior before 009/storage plans can persist
it. Keep the deployed conservative representation usable until that integration is
ready; do not describe prototype range decisions as deployed acceptance support.

## 4. Complete the format and language matrix

Start with Markdown, JSON/JSONL and YAML/TOML, then collections and code languages.
Choose later language order from actual usage while retaining all rows as planned
scope. Preserve unmodified bytes, comments and opaque syntax. Explicitly document
syntax constructs that require conservative alternatives.

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


Delegate embedded languages only for well-identified regions, preserving host syntax
and mapping evidence back to source material. Never evaluate project code with host
IO authority to decide a merge. Keep custom schema execution inside its sandbox.

## 5. Make rules independently installable and measurable

- Give each rule explicit identity, revision, configuration and evaluated-input evidence.
  Validate configurations in the tool; 009 owns Canopy defaults and per-tree selection.
  A rule upgrade does not rewrite historical results or replay semantics.
- Package additional rules behind the same executable API. Preserve old rule behavior
  where retained jobs require it, or report unsupported evaluation explicitly. Keep
  custom details open without weakening the shared result validation contract.
- Measure cold/warm latency, object IO, parser memory and large-file behavior. Respect
  resource budgets and cancellation. Improve the persistent evaluation mode if useful;
  009 owns worker supervision, staging lifetime, credentials and GC leases.
- Supply captured fixture requests and executable releases to 009 for shadow evaluation
  before activation. Editors can collect intent through 008 before these rules ship.
  No client capability-advertisement endpoint or per-rule coordinated cutover.

## Verification and completion

For every operation/language pair record supported syntax, exact execution, expected
resolutions and intentional refusals. Add generated/differential cases for causality,
duplicates, ordering, malformed source and binding changes. Successful parsing alone
never proves semantic equivalence. False automatic resolution is the primary regression;
measure it separately from merge coverage.

Run the golden corpus through both library and executable, including fresh/persistent
workers, malformed requests, missing objects, limits and deterministic evidence.
Use disposable Canopy integration to verify returned proposals can be validated and
retained; do not require installed clients to complete tool-only slices. Run applicable
[development gates](../../DEVELOPMENT.md). Record delivered subsets in status/docs,
remove completed work here, and archive only when every chosen row has an explicit,
verified support contract rather than an unqualified claim to merge all programs.
