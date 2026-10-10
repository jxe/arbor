# Clients 002: more identity-preserving coalescing

Joe wants ordinary editing bursts to publish as a few meaningful authored changes,
with enough identity for overstoryd to merge concurrent work correctly. After the
idle-based publication baseline, extend simplification beyond repeated moves of
one unchanged span. Implement each case in the Swift and TypeScript clients,
using shared examples and the host merge engine to prove the result.

## Starting point

Read the implementation and tests before selecting a case:

- [Update machine and runner](../../docs/implementing-sync-services/update-machine.md).
- [Editor capture and publication](../../docs/implementing-editors/editor-source.md).
- [Source intent and provenance](../../docs/overstory-spec/10-source-intent.md).
- Swift `ChangePublication.swift` and TypeScript `publication.ts` in their
  working-tree packages; `tests/fixtures/coalesced-publication.json`.
- [Native 008](008-copies-with-changes-and-compound-undo.md) owns missing
  editor evidence for copies with changes and compound undo. Coalescing must use
  such evidence, not infer it from matching text.

Combining several records into one update with multiple frames is different from
simplifying their operations. Preserve the frame chain whenever a shorter account
has not been proved. The baseline handles repeated pure moves of the same original
span; mixed changes can still share one publication without flattening their frames.

## Interior bases that need further support

Before expanding composition, define publication identity for a late branch from
an intermediate record when the remaining published frames touch the same file,
change structure, or expose operation results. Known branch points already end a
batch; source branches over disjoint files have a client commutation proof. That
does not cover overlapping branches from editors captured before publication.
Determine whether clients can preserve addressable intermediate bases without
sending each original change, or whether the protocol needs an explicit retained
intermediate-basis identity. Never replay an original prefix under a second
identity, retarget by byte equality, or undo the already accepted suffix merely
to reconstruct the old basis. Test late capture, copies, net-zero edits, guarded
resolutions, collapsed move coordinates, retry and restart against the real host.

## Implementation order

Start with common editor bursts that currently retain intermediate full-file
objects or many source operations. This ordering is based on the capture and
publication paths, not measured usage frequency. First measure repeated typing,
backspace, replacements, Option-arrow movement, indentation and selected-subtree
movement on a long page. Report encoded request bytes (including object envelopes
and deltas), update/frame/operation counts and preparation time, not HTTP count
alone. Compare against the uncoalesced encoded request: combining frames can
expand an accepted-base delta into an intermediate object when that version is
absent from the final candidate. Prioritize removing those intermediate versions,
and avoid selecting a larger wire representation merely to reduce update count.
Reorder later cases if measurements show a larger practical saving.

| Order | Case | Expected benefit |
| --- | --- | --- |
| 1 | Plain edits across local records | Typing, deletion and correction are common. A composed edit can remove intermediate full-file objects and reduce repeated replacement text; preserve or generate an efficient final delta when valid. |
| 2 | Move plus edits | Extends the pure-move reduction to ordinary indentation and separator changes, which currently prevent simplification. Retain only the final candidate's objects when the compact operations suffice. |
| 3 | Repeated moves of selections/subtrees | A long keyboard or drag sequence over several blocks can otherwise carry many move operations and intermediate candidates. |
| 4 | Copy followed by edits/moves | Useful for duplicate-and-adapt workflows; measure frequency and payload before broadening the origin/result mapping. |
| 5 | Entry rename/move chains | Usually small directory payloads; pursue earlier only if real workflows show large subtree/object duplication. |
| 6 | Undo/redo cancellation and snapshot reductions | Potentially large savings, but origin, hidden-state and dependency proofs are harder. Cover safety now; implement reductions when measured examples justify them. |

## Remaining cases

1. **Plain edits across local records.** Compose insertions, replacements and
   deletions in source coordinates. Preserve any intermediate operation result
   referenced by later work, or provide an exact mapping to its published result.
   Include edits that cancel in bytes but differ in origins.
2. **Move plus edits.** Collapse repeated movement with text edits, re-indentation
   and separator changes into an original-source move plus verified edits. Carry
   a peer's edit with the moved material. Do not turn it into deletion and retyping.
3. **Several selected spans and subtrees.** Coalesce repeated movement of a
   selection, including heading envelopes and descendants, without claiming that
   intervening stationary blocks moved. Handle changing selections explicitly.
4. **Copies and edits to copies.** Preserve distinct copy origins and their
   derivation. A copy moved or edited repeatedly can become a compact contribution;
   its original and sibling copies must remain independently editable.
5. **Entry operations.** Study rename/move chains, a newly created entry moved
   before publication, and changes to children of moved entries. Keep entry and
   descendant identity across paths and respect logical tree boundaries. Include
   cross-document source moves separately from whole-entry moves.
6. **Undo, redo and round trips.** Prove cancellation over origins and referenced
   results, not merely equal candidate roots. Undoing a move, replacing text with
   identical bytes, and deleting then recreating an entry are different cases.
7. **Snapshot boundaries.** Decide which snapshot-only sequences can safely be
   reduced. Never erase hidden identity effects, operation dependencies, or human
   resolution declarations to obtain one final snapshot.

## Requirements for each case

- Keep local records durable immediately and preserve undo independently of
  publication. Coalesce only work that has not entered an immutable prepared
  request. Retried or ambiguously transmitted prefixes remain exact.
- Start from one explicit authored chain. Equal roots never establish ancestry;
  independent branches cannot be collapsed into a fictitious common history.
- Preserve material origins, copy derivation, entry identity, destination anchors,
  and every still-addressable operation result, including its authored coordinates.
  Define the local-to-publication identity mapping and its retention before coding.
- Verify the shorter account against the exact starting graph and final bytes.
  That check is necessary but insufficient: also compare provenance and concurrent
  merge outcomes. Preserve unresolved choices and resolution guards.
- Keep Swift and TypeScript behavior aligned using shared input and expected wire
  vectors. Do not change the wire grammar unless existing operations cannot express
  the intended result; a grammar change also needs the protocol conformance work.
- Bound preparation cost and retained mapping/object storage. Avoid rebuilding all
  prefixes of a long burst. Compare preparation time and wire size on long documents.

## Evidence required

For each supported case, test both the uncoalesced and coalesced sequence against:

- edits inside the moved/copied material and edits to its neighbors;
- concurrent changes to the destination anchor and competing placements;
- identical-looking blocks with different origins, Unicode and CRLF;
- both arrival orders, with the expected accepted state or unresolved alternatives;
- an interruption before preparation, after durable preparation, after host
  acceptance, and before local acknowledgement;
- later work referring to a covered local change or operation result, exact retry,
  ambiguous extension, and cleanup while a descendant still needs the mapping;
- protocol frame/operation limits, oversized bursts, unsupported mixtures and
  unchanged final bytes.

Record request count, update count, operation/frame count and the actual selected
source/anchor identities. A test that checks only rendered text cannot establish
identity preservation.

## Completion

Each implemented case needs focused Swift/TypeScript tests, host merge evidence,
updated descriptions and a status entry naming the supported boundary. Run the
repository's affected checks; run the full DEVELOPMENT.md gate when closing this
plan. Move durable evidence into docs/status and delete the plan once its remaining
cases have been implemented or deliberately split into other plans.
