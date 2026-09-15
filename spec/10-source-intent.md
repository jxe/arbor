# Source intent and provenance

This chapter defines authored effects, references and resolutions for the ordinary
[update route](01-tree-operations.md#21-the-update-request). There is one target
contract, with no API version or negotiation. [Status](../status.md) records the
reference implementation's progress toward it.

## 1. An authored change

Every candidate has required `change`, `candidate`, `operations` and `resolves`
fields. `change` identifies an immutable authored change within its TreeID and uses
the [material-reference key syntax](01-tree-operations.md#122-material-references-and-selectors).
A random UUID is suitable for a new change. Exact retry and
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

## 2. References in authored changes

[Tree operations §1.2.2](01-tree-operations.md#122-material-references-and-selectors)
defines `Material`, `Ref`, `EntryDestination` and their selectors for both reads and
writes. Authored operations additionally use:

```ts
type Lineage = { source: Ref; range: [number, number] };
type OperationRef = { change: string; operation: string };
```

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

Inspection is authorized and scoped to accepted state. It supplies the
complete relevant identities, locations, dependencies and actions without requiring
a full provenance graph. [Tree operations §1.2.3](01-tree-operations.md#123-reading-conflicts)
specifies text, whole-entry and placement inspection using the same material-reference
vocabulary.

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

The portable core requires rule identity and revision, evaluated inputs and resulting
decisions, but does not enumerate implementations or their private counters. Each
rule may define additional evidence fields and their schema. Unknown rule-specific
fields never grant authorization, express human resolution intent or execute code.
Required resolution evidence must remain available for the advertised retention
period; changing a rule must not rewrite it. The storage and retrieval mechanism
for this evidence is an implementation choice.
