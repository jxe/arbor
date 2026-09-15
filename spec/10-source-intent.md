# Source intent and provenance

This chapter defines authored effects, references and resolutions for the ordinary
[update route](01-tree-operations.md#21-the-update-request). There is one target
contract, with no API version or negotiation. [Status](../status.md) records the
reference implementation's progress toward it.

## 1. An authored change

Every candidate has required `change`, `candidate`, `operations` and `resolves`
fields. `change` identifies an immutable authored change within its TreeID. Change,
operation, conflict and alternative keys are 1–128 ASCII letters, digits,
underscores or hyphens. A random UUID is suitable for a new change. Exact retry and
adoption retain its identity and semantics; clients MUST NOT reuse it for different
intent. Change identities within a request are distinct.

`operations: null` means snapshot semantics. Otherwise ordered operations explain
the entire authored transition, including effects on hidden material. There is no
residual field. Known operations followed by snapshot-only edits are separate
candidate elements. `resolves` is always an array; empty means no human-authored
resolution. An empty operations array is valid only with nonempty `resolves`, for
an explicit resolution that leaves the projection unchanged. Snapshot candidates
may also carry explicit resolution declarations; snapshots alone never resolve.
Unknown semantic fields or operation kinds are invalid.

An operation key is unique within its change. `(change, operation)` identifies its
single material result when it has one; there is no independently named output.
Result identity and material origin are distinct: a move preserves origins, a copy
creates new origins with derivation, and an edit preserves only verified lineage.
Result coordinates describe the result at execution on its authored basis. A result
may contain several retained or newly created origins. Equal bytes do not establish
shared origin. A snapshot asserts no fine-grained origins; the authority may derive
conservative correspondence, but MUST NOT invent move, copy, undo or resolution intent.

## 2. Material references and selectors

```ts
type Material =
  | { kind: "basis"; path: string; object: Hash }
  | { kind: "operation"; change: string; operation: string }
  | { kind: "alternative"; state: string; conflict: string; alternative: string };

type Ref = {
  material: Material;
  within?: string[];
  range?: [number, number];
};
type EntryDestination = { parent: Ref; name: string };
type Lineage = { source: Ref; range: [number, number] };
type OperationRef = { change: string; operation: string };
```

All references are scoped to the request's TreeID and remain subject to current
authorization. `basis` names the exact object at a logical path in the element's
authored basis. For the first element this is the accepted state at request `base`;
for later elements it is the preceding submitted candidate together with its authored
semantic effects, not merely its root hash. Paths are NFC, absolute and at most
4096 UTF-8 bytes; `/` is permitted to reference the tree root or a destination parent.
Other paths have no trailing slash, empty/dot components, backslashes or NUL.
Root material cannot itself be moved, removed or replaced as an entry.

`operation` names a retained material result or the result of an earlier operation
in this change or submitted prefix. Forward references, cycles and references to an
operation with no material result are invalid. An operation result is not a backend
graph ID and does not inherently create a new origin. The authority retains its
immutable binding and the provenance needed to transport selections through later
changes. Missing history requires an explicit failure, never fuzzy text matching.

`alternative` names material in an exact retained accepted `state`. State IDs are
opaque, nonempty strings of at most 1024 UTF-8 bytes. Conflict and alternative IDs
come from the authority. The state identifies the reviewed alternative revision;
bytes, display order and current paths cannot substitute for identity.

Omitting selectors means the complete material. A nonempty `within` array selects
a descendant of directory material using names at the identified basis/result/state,
not current path lookup. Components obey the path-name rules, have a combined
slash-joined length of at most 4096 UTF-8 bytes, and number at most 256. A `range`
then selects text in that material or descendant: two nonnegative safe integers
(`<= 2^53 - 1`) defining a half-open UTF-8 byte range on scalar boundaries. A
zero-width range is an insertion point. No range means the entire selected text
for source operations and the entire selected entry for entry operations. Applying
text ranges to binary or directory material is invalid. Entry references cannot
have ranges. Logical boundaries never grant access to another TreeID's interior.

The authority resolves the identified selection before transporting its identity
through changes; it MUST NOT retarget by matching current names or bytes. For an
entry destination, `parent` identifies a directory and `name` is one NFC component.
The authored destination slot, including its observed occupant or absence, is part
of the basis. Concurrent moves or occupants are reconciled rather than overwritten.
Text insertion uses `at: Ref` and `side: "before" | "after"` at the selected edges.

Editors open ordinary source with its accepted update and file hash. They need no
per-character identity map or provenance graph. Format-aware analysis may map blocks,
keys or symbols to exact source; it does not introduce a separate identity namespace.

## 3. Operations

The target authority supports every operation below. Each has required `key` and
`kind` fields. All listed fields are required except `lineage`. References may
select projected material or alternatives; the reference determines the target,
so there is no separate `editAlternative` operation.

| `kind` | Fields | Authored meaning and material result |
| --- | --- | --- |
| `editSource` | `source: Ref, text, lineage?` | Replace selected text; empty selection inserts and empty text deletes. Result is the replacement text, including preserved lineage. |
| `moveSource` | `source: Ref, at: Ref, side` | Relocate the same material and transport independent edits. Result is the relocated text with its original origins. |
| `copySource` | `source: Ref, at: Ref, side` | Create a distinct copy of observed text with derivation. Result is the new text; later edits to either copy remain independent. |
| `moveEntry` | `source: Ref, destination: EntryDestination` | Move the same entry/subtree. Result is the relocated entry with retained descendant identities. |
| `copyEntry` | `source: Ref, destination: EntryDestination` | Create a distinct entry/subtree derived from observed material. Result is the new subtree. |
| `removeEntry` | `source: Ref` | Remove the observed entry; concurrent modifications remain evidence to reconcile. No material result. |
| `replaceEntry` | `source: Ref, value: { file: Hash } \| { directory: Hash } \| Ref` | Replace the selected entry's content/subtree while retaining its outer entry identity. Result is the replaced entry. |
| `undoOperation` | `target: OperationRef` | Invert the named causal contribution while preserving independent later work. Ambiguity remains a decision. No material result. |

`replaceEntry` supports whole-file/binary and subtree replacement without a text
payload. A `file` or `directory` value identifies the explicit entry kind and its object supplied
or reachable under the transport rules. Kind is never inferred from payload bytes.
Such a value asserts new content, not historical
lineage. A material value takes the exact content and descendant provenance of a
referenced entry, including a hidden alternative. It does not assert a copy or permit
two simultaneous placements of one entry identity. A deliberate duplicate uses
`copyEntry`. Boundary attachment kind/authorization and all model constraints remain
in force. Creation at an absent location can use a separate snapshot candidate;
`replaceEntry` requires an existing entry in its authored basis.

`lineage` maps ascending nonoverlapping ranges in the replacement text to verified
source selections. Each mapping MUST preserve exact bytes and origin. Unmapped text
is new material. False lineage is invalid. Omission supplies no preservation claim;
lineage is not normalization or inferred copy intent.

Operations execute in order against their authored semantic basis. Basis references
retain their meaning as earlier operations transform material; use operation-result
references for newly introduced material. The result MUST reproduce `candidate`,
including untouched bytes, while retaining all declared hidden/provenance effects.
Contradictory authored effects, false references and unexplained candidate changes
fail. Valid effects that become incompatible through concurrency are retained as
unresolved decisions when representable within the contract bounds.

Limits: at most 1024 operations per candidate, 1024 lineage segments per edit, and
1 MiB of UTF-8 text per text field. Implementations may impose documented overall
request/object limits. Grammar validation does not establish source reachability,
UTF-8 boundaries in stored objects, candidate correspondence or authorization; the
authority validates those before acceptance.

## 4. Acceptance and explicit resolution

[Tree operations §2.3](01-tree-operations.md#23-accepting-and-merging) is the single
acceptance procedure for snapshots and operations. Reconciliation is the default;
optional `ifCurrent` guards exact accepted identity. There is no resolved-only write
mode. A consumer that requires resolved material checks that condition when consuming
it. Operations and candidate are both semantic intent, never unchecked hints or a
snapshot fallback. Provenance, decisions and projected state commit atomically.

```ts
type ResolutionDeclaration = {
  state: string;
  conflict: string;
  alternatives: string[];
};
```

A declaration in `resolves` explicitly endorses the candidate's resulting projection
for the named decision. It does not carry its own replacement language or clear an
arbitrary flag. The operations or snapshot describe the authored result; the
declaration supplies resolution intent and guards. For hidden material to become
the chosen result, the candidate must materialize it using the appropriate ordinary
operations. Editing a hidden alternative alone does not select it.

`state` identifies the exact reviewed accepted evidence. `alternatives` is the
complete nonempty set of reviewed alternative IDs, with no duplicates. The authority
loads their revisions, contributions and dependencies at that state and compares the
relevant evidence with current. New or changed alternatives, affected locations,
projection choices or dependencies invalidate the review. Unrelated advancement need
not invalidate it when the authority proves the guarded decision unchanged. `ifCurrent`
is available when the caller requires no accepted advancement at all.

There is no fixed protocol count limit on declarations or reviewed alternatives.
A conflict may appear only once. Array order is retained in request identity, but
all declarations take effect jointly, never sequentially. The authority validates
that the candidate fully expresses each resolved choice and preserves all unnamed
open decisions. Ordinary saves, equal bytes and omission of hidden material never
resolve a decision implicitly.

Coupled decisions use one candidate with all required operations and declarations.
The authority validates a coherent combined result against dependencies and model
constraints, then accepts everything atomically or rejects that candidate. Several
request elements are not a substitute: they can leave an accepted prefix. A dependency
does not force joint resolution if an individual choice leaves the other alternatives
meaningful and correctly attached. New concurrency affecting a resolved choice causes
rejection, not silent expansion of the person's resolution. Unrelated edits may merge.

Keeping the existing projection can use `operations: []` plus guarded `resolves`.
It advances accepted identity even with an unchanged root. An automatic rule uses the
same resolution invariants with separately recorded authority authorship under §6.

## 5. Accepted decisions and continued editing

An authority distinguishes contributions, unresolved decisions and the ordinary
projected file graph. Decision identity is stable within a tree. Alternatives retain
identity, revision and provenance; equal bytes, ordering and paths cannot identify
or collapse them. Decisions may concern content, existence, placement or attachment.
Independent decisions remain separately reviewable. Dependencies describe constraints
on valid combinations, not a requirement to enumerate whole-document combinations.

The projection MUST be a valid ordinary file graph without injected conflict markers.
Its correspondence to alternatives is retained in accepted state. Hidden material
and its required objects remain available through authorized inspection for the
advertised retention period. An ordinary edit continues its attributable alternative
and preserves other alternatives and the open decision. Returning to base bytes or
matching another alternative is not resolution. When attribution is ambiguous, the
authority retains that ambiguity if representable; invalid claims, missing required
evidence and exceeded bounds remain explicit failures.

Accepted unresolved results acknowledge work normally and do not pause sync or stop
a request's remaining elements. Clients retain exact accepted identity, the unresolved
signal, the projection underlying authored edits and durable pending local work.
Canopy owns attribution and resolution semantics on every write path. Clients need
no downloaded alternative map or inspection cache to perform ordinary editing.
Incoming materialization must preserve newer unaccepted local edits and their bases.
Inspection failures may delay review but cannot alone block ordinary synchronization.
Durable review caching is optional.

Inspection is authorized, bounded and scoped to accepted state. It supplies the
complete relevant identities, locations, dependencies and actions without requiring
a full provenance graph. Section 7 specifies text, whole-entry and placement inspection using the same
material-reference vocabulary.

## 6. Format-aware merge rules and explicit automatic resolution

Merge rules interpret exact source, structural/schema context, provenance and open
decisions. A filename extension alone is insufficient: Markdown frontmatter and
embedded code may require different rules from surrounding prose. JSON/YAML object
keys, array identities, code bindings and supported binary structures may justify
different outcomes for superficially similar changes.

A rule can justify a resolved result, identify remaining ambiguity and valid choices,
or decline applicability. The internal rule interface is replaceable. Rules MUST
account for competing contributions, preserve unaffected bytes and identities, and
validate the result against the applicable format/model constraints. Keeping two
independent Markdown insertions may be valid; duplicating one twice-moved paragraph
is not implied by that policy. Binary content requires an applicable merger or
explicit alternatives/rejection, not an automatic text fallback.

Clearing an existing decision automatically is an explicit authority resolution. It
MUST record the accepted state and complete alternative set considered, the rule's
identity and revision, the result and its provenance mapping, and the justification.
Human resolution records instead identify the reviewed operation and alternatives.
Both must preserve independent decisions, validate dependency guards and commit
atomically with accepted identity and projection. A stale rule result must be
recomputed or rejected; it cannot silently resolve newly arrived contributions.
Changing a rule's implementation MUST NOT reinterpret historical resolutions.

For clean automatic merges, the authority must likewise retain the contributions and
sufficient decision evidence for explanation and reproducibility; it need not create
a user-visible conflict solely to resolve it immediately. Deterministic rule and
projection behavior must be specified where promised by the format contract.

The shared decision scenarios in [accepted ambiguity](../conformance/accepted-ambiguity.json)
cover these semantic obligations. They are scenario requirements, not an additional
Wire encoding or a claim that the reference implementation supports them already.

## 7. Decision inspection using material references

`GET /.arbor/trees/{tree}/conflicts?state={acceptedUpdate}` lists decisions in an
exact retained accepted state. Optional `after` continues an opaque page token;
optional `conflict` selects one decision. Each query field occurs at most once;
`state` is required, nonempty and exact. `after` and `conflict` are mutually exclusive.
The authority authorizes every read, including continuation pages. Unknown or
unauthorized trees, unavailable states and unknown selected decisions return `404`;
malformed or mismatched page tokens return `400`. A page token is bound to tree,
accepted state and traversal position, never an authorization grant.

```ts
type DecisionPage = {
  tree: TreeID; state: string; root: Hash; conflicted: boolean;
  decisions: Decision[];
  next: string | null;
};
type Decision = {
  id: string;
  kind: string;
  affected: Ref[];
  selected: string;
  alternatives: Array<{
    id: string; revision: string;
    value: { text: string } | { file: Hash } | { directory: Hash }
         | { tree: TreeID } | { absent: true };
    placement?: EntryDestination;
    contributions: Array<{ change: string; operation: string | null }>;
  }>;
  dependencies: string[];
  actions: string[];
};
```

There is no fixed protocol cap on decisions, alternatives, dependencies,
contributions or aggregate inspection text. In particular, accepting the 33rd
unresolved decision is not an error. Page size is a transfer choice, never a limit
on accepted conflict state. Documented storage/resource constraints remain honest
implementation failures; a full response or absent automatic merge rule must not
be misreported as a resolved tree or an unsupported decision count.

`tree`, `state` and `root` must match the requested accepted context on every page.
`conflicted` describes the entire state, not just the current page. `next: null`
ends the traversal. A complete traversal yields each decision once in stable order,
with no omission or duplication. Pages remain at their original accepted state even
if current advances. A nonterminal page must make progress and return a different
continuation token; unavailable retained evidence requires explicit failure. A
resolved state has no decisions and no continuation. A filtered read returns the
one requested complete decision, with `next: null`; it does not claim to enumerate
all tree decisions. Clients cannot infer resolution from an empty partial result.

Each decision record contains its complete alternative and dependency sets; it is
not split into partial choices. Dependencies may name decisions on other pages.
The client may fetch those by `conflict` at the same state. Not appearing on this
page does not mean a dependency is missing or resolved. Before preparing a joint
resolution the client obtains the evidence required for the affected dependency
closure. Unrelated sync requires neither a complete traversal nor that closure.
The authority still validates all guards and combinations at acceptance.

`affected` uses the same material references as updates. A `basis` reference is
interpreted at the page's `state`. Absence decisions can address a destination parent
or retained material rather than inventing a nonexistent file path. Whole-entry,
placement and text selections therefore share the same identity vocabulary.
An alternative is addressed in a mutation by an `alternative` material reference
using this page's state and its decision/alternative IDs. Its value supplies exact
text or the existing explicitly typed entry representation; `absent` represents
nonexistence. `placement`, when present, identifies the proposed parent and name
for an entry value, not a second independent copy. It is invalid for text or absence.

Decision and alternative IDs are stable across continuation. Revisions change when
value, placement, contributions or other meaningful alternative evidence changes;
earlier revisions remain associated with retained accepted states. Equal bytes do
not collapse alternatives. Contributions identify authored input rather than a full
transitive history download. Null `operation` explicitly denotes a snapshot input.
Selected identity must name an alternative. The authority retains and verifies its
correspondence to the ordinary projection; clients validate exact source and placement
before attaching actionable controls. A text value must match the selected projected
UTF-8 range. A directory/file kind is never guessed from bytes. Unknown decision
kinds or actions may be displayed as unavailable, but cannot authorize invented
mutation behavior. Core read fields may be extended without changing their meaning.

For entry-valued alternatives, authorized object reads are scoped to that alternative:
`GET /.arbor/trees/{tree}/conflicts/{conflict}/alternatives/{alternative}/objects/{hash}?state={acceptedUpdate}`.
The hash must be reachable from the explicitly typed alternative at that exact retained
state; arbitrary historical or unrelated objects are `404`. The response is immutable
object bytes and must hash to the requested hash. Tree-boundary entries do not grant
access to the nested tree's interior. This route supplements ordinary projected-root
object reads without broadening their authorization. Inline text requires no extra read.

Known review actions remain `editAlternative` and `resolveConflict`: capability
labels rather than mutation opcodes. They produce ordinary operations and resolution
declarations. Requests remain subject to current authorization and guarded evidence.
Optional offline inspection caching does not grant current-state authority.

IDs and references use §1–2 syntax. Decisions, alternatives, dependencies, actions and
contributions must be unique within their stated scopes; dependencies cannot refer to
self but cycles between decisions are permitted. Empty alternative sets, invalid
selected IDs, malformed references and invalid values fail decoding. Open decisions
have at least two alternatives. Responses are private and must not be stored by shared
HTTP caches. The [target read vectors](../conformance/wire-accepted-state.json) bind
paired TypeScript and Swift models; they do not assert server execution.

## 8. Rule evidence

The portable core does not enumerate merge implementations or their private counters.
`GET /.arbor/trees/{tree}/updates/{state}/evidence` lists rule evaluations recorded
with that accepted state. It uses the same exact-state authorization and optional
`after` continuation rules as decision inspection, with `404` for unavailable or
unauthorized state. Records are immutable evidence, not instructions from a client.

```ts
type RuleEvidencePage = {
  tree: TreeID; state: string;
  records: Array<{
    id: string;
    rule: { id: string; revision: string };
    evaluated: {
      state: string;
      materials: Ref[];
      contributions: Array<{ change: string; operation: string | null }>;
      decisions: ResolutionDeclaration[];
    };
    outcome: "resolved" | "unresolved" | "not-applicable";
    decisions: string[];
    details: JSONValue;
  }>;
  next: string | null;
};
```

The core identifies the rule/revision, exact evaluated state and inputs, outcome,
and resulting decision identities in the page's recorded accepted state. Each
record has a stable identity; a page may contain evaluations from several rules
and formats. `not-applicable` means the rule declined, not that it resolved the
input. An update need not have rule evidence merely because two independent changes
were combined. Accepted-state kind and submission outcome do not encode rule choice.

`details` is an open JSON value owned by the named rule and revision. It may contain
format constraints, explanations, result/provenance mappings or diagnostics. The
rule defines its schema and promises; unknown details are preserved or ignored,
never interpreted as generic authorization, resolution intent or executable code.
Required §6 resolution evidence must remain available, whether represented in the
core input fields or the rule's specified details. Rule-specific schema changes do
not require adding another case to a global Wire union. Re-evaluating with a newer
rule must not rewrite historical evidence. Paging has no fixed record-count cap.
