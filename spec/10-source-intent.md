# Source intent and provenance

This chapter defines the semantic part of an [update](01-tree-operations.md#21-the-update-request). It uses the same update, result, and watch routes. It requires neither a second API version nor extension negotiation. Implementation availability is recorded in [status](../status.md).

## 1. An authored change

Every candidate has a required `change` identifier and required `operations` field. Change, operation, output, conflict, and alternative keys are 1–128 ASCII letters, digits, underscores, or hyphens. Accepted update IDs remain opaque under the accepted-update contract. A client generates a fresh change identifier before persisting a newly authored candidate; a randomly generated UUID is suitable. A retry or adopted prefix retains that identifier and its exact operations. The identifier is scoped to the tree for provenance; it is not a credential or a replacement for the credential-scoped request digest. Clients MUST NOT reuse it for different authored intent. A batch MUST contain distinct change identifiers.

`operations: null` means the candidate is a snapshot change. A nonempty operation array means that those ordered operations explain the **entire** transition from the candidate's basis to its proposed root. An empty array, omitted field, unknown operation, or unknown semantic field is invalid. There is no residual field. If an editor knows how a paragraph moved but has only snapshot evidence for another edit, it sends an operation-bearing candidate for the move followed by a separate snapshot candidate for the remaining edit.

An operation key is unique within its change. An output key names material introduced by that operation. `(change, operation, output)` is both identity and provenance: it names a creation event without exposing a backend graph identifier or an editor's transient block ID. Moves preserve existing origins; copies introduce a new origin with a derivation from their source. Editing preserves only explicitly verified lineage and creates origins for new material. Equality of bytes alone does not establish shared origin.

Snapshot changes do not assert fine-grained origins. An authority may derive conservative correspondence from source structure, but MUST NOT invent explicit move, copy, undo, or resolution intent. A snapshot no-op need not create accepted history or an origin record. Once operation outputs are supported, the authority MUST enforce their immutable origin bindings and retain enough provenance to validate references for its advertised retention period. An unavailable origin requires resynchronization or review; it never falls back to matching similar text.

## 2. References without a per-character identity download

```ts
type SourceRef =
  | { kind: "source"; path: string; object: Hash; start: number; end: number }
  | { kind: "entry"; path: string }
  | { kind: "output"; change: string; operation: string; output: string;
      start: number; end: number }
  | { kind: "alternative"; state: string; conflict: string; alternative: string;
      start: number; end: number };
type OperationRef = { change: string; operation: string };
type Lineage = { source: SourceRef; start: number; end: number };
```

All references are scoped to the request's TreeID. A `source` identifies an exact UTF-8 source slice in a file object reachable at `path` in the element's basis: the accepted state at request `base` for the first element, or the preceding submitted candidate for later elements. `object` is the exact file hash. Offsets are half-open byte ranges, never UTF-16 indices, grapheme counts, line numbers, or rendered positions. They MUST lie on UTF-8 boundaries in valid source. Zero-width slices are allowed for insertion. No offset addresses the JSON envelope or the surrounding directory object.

Paths are NFC, absolute within the tree, and non-root; empty components, trailing slashes, dot components, backslashes, and NUL are invalid. `entry` addresses the exact entry at that path in the basis, including its kind and content. It does not grant permission to cross a nested TreeID boundary. Moving a boundary entry requires the existing boundary authorization; its interior belongs to its own tree.

An `output` references retained output provenance, or an earlier operation in this change or its submitted prefix. Forward references and cycles are invalid. The authority verifies the referenced origin, range, and visibility at the basis; knowing an identifier never grants access. Output coordinates name the output when created, and provenance transports that material through subsequent accepted changes. They are not guessed positions in the latest projection.

An `alternative` names a range of one conflict alternative in the exact accepted `state`. `state` is an accepted update ID. Conflict and alternative keys are opaque identities supplied by the authority. They are not regenerated from display order or content hashes. An edit cannot silently retarget an alternative from a newer conflict state.

An editor can therefore open ordinary Markdown with its existing accepted update and file hash, parse it locally, and emit source ranges only for affected material. It does not need an identity per character or the server's history graph. Format awareness belongs in source correspondence: Markdown paragraphs, frontmatter fields, list items, code symbols, and structured records can map to exact source while preserving the same origin vocabulary. Any richer inspection surface must preserve these identities and guards.

## 3. Operations

Every row below also has required `key` and `kind` fields. All listed fields are required except `lineage`. Source operations accept `source` or `output` references; entry operations require an `entry` reference. Insertion anchors (`at`) are source/output references, with `side: "before" | "after"` selecting their start or end boundary.

| `kind` | Fields | Authored meaning |
| --- | --- | --- |
| `editSource` | `source, text, output, lineage?` | Replace the selected source with exact UTF-8 text; an empty slice inserts and empty text deletes. |
| `moveSource` | `source, at, side` | Relocate the same material, preserving its origins and transporting independently authored edits. |
| `copySource` | `source, at, side, output` | Introduce a distinct copy with derivation from the source; later edits to either copy do not become edits to the other. |
| `moveEntry` | `source, destination` | Relocate the same tree entry, preserving its identity and descendant provenance. |
| `copyEntry` | `source, destination, output` | Create a distinct entry/subtree derived from the source, subject to tree boundaries. |
| `removeEntry` | `source` | Remove the entry observed at the basis; concurrent additions or modifications remain evidence to reconcile, not silently erased history. |
| `editAlternative` | `source, text, output, lineage?` | Edit the named alternative while leaving the conflict unresolved. |
| `resolveConflict` | `state, conflict, alternatives, text, output` | Explicitly resolve the exact named alternative set to reviewed source text. |
| `undoOperation` | `target: OperationRef` | Invert that operation's causal contribution while preserving independent later changes; ambiguity remains a conflict. |

For `resolveConflict`, `alternatives` is the complete, nonempty set the author reviewed, with no duplicates. It is an identity guard, not a list of display indices. The authority MUST reject a stale or incomplete set rather than silently resolving newly arrived alternatives. This text form resolves source conflicts; entry, binary, and structural conflicts that cannot be represented by these operations remain unsupported until a complete contract exists.

`lineage` maps nonoverlapping, ascending output ranges to verified source ranges. Each mapping MUST preserve the exact referenced bytes and their origin. Unmapped output bytes are new material. The authority validates claims against retained source and MUST reject false lineage. Omission supplies no preservation claim. Lineage is neither an instruction to normalize formatting nor permission to infer copy identity from equal text.

Operations are ordered. Basis references retain their original meaning as prior operations transform the working result; references to newly introduced material use output identities. Effects compose against that basis, not arbitrary offsets in successive rendered documents. Executing the complete array on its exact basis MUST reproduce the supplied candidate graph, including untouched bytes. Unsupported overlapping effects, ambiguous attachment, stale alternatives, and invalid identity bindings MUST fail rather than select an arbitrary target. Independent operation-bearing and snapshot elements remain separate accepted-history boundaries.

Wire limits are 1–1024 operations per semantic candidate, at most 1024 lineage segments per edit, at most 1024 reviewed alternatives, and at most 1 MiB of UTF-8 text per text field. Offsets are nonnegative integers no larger than `2^53 - 1`. These limits also apply to Swift; JSON numbers must not lose precision. Implementations may impose documented overall request/object limits independently.

## 4. Acceptance, unsupported operations, and conflicts

The candidate graph is the proposed materialization; operations explain how the author produced it. Both belong to request identity. Complete objects and object deltas remain interchangeable transport. An authority MUST NOT discard operations, use them only as unverified suggestions, or accept the candidate through snapshot-only fallback.

Before accepting any element of a request, an authority validates its operation grammar and preflights operation support across the entire batch. A well-formed operation the authority does not support returns HTTP `422`, `error: "unsupported-operation"`, and `retryable: false`, without accepting any prefix, storing submitted objects, or changing accepted/watch state. Malformed semantics return `400 invalid-request`. These preflight failures differ from a supported operation's reconciliation conflict, where the existing sequential `409` contract retains the completed prefix. An unsupported request remains durable at its client; it must not be converted into snapshots or retried as a network outage.

Supporting an operation means validating its references, authorization, complete effect and candidate correspondence, persisting its necessary provenance atomically with acceptance, and implementing safe conflict behavior. Merely recognizing its JSON shape is insufficient. A server may implement operations incrementally under this single contract; clients may begin emitting each only once their coordinated server upgrade supports it.

An accepted state can retain unresolved alternatives with `conflicted: true`. Its root remains an ordinary file graph. Ordinary source edits and snapshot writes MUST NOT imply resolution. Only an explicit resolution with matching accepted-state and alternative guards clears the corresponding conflict. Editing an alternative back to old base bytes still leaves it unresolved. An accepted metadata-only change receives a new update ID and watch cursor even if its root is unchanged; concurrency checks must include accepted identity, not just root equality.

The internal representation of origins and unresolved alternatives is replaceable. A composable conflict expression, an operation graph, or another representation conforms only if it preserves these observable semantics. The protocol does not require clients to reproduce Canopy's merge algorithm.
