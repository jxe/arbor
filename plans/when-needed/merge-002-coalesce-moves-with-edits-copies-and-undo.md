# Clients 002: coalesce moves with edits, selections, copies and undo

Joe wants ordinary editing bursts to publish as a few meaningful authored changes,
with enough identity for overstoryd to merge concurrent work correctly. When needed
(Joe, 2026-11-07): take it up when real journals or network logs show edit bursts
from moves with edits, selections, copies or undo are still large. Plain
edits across records and runs of moves on either side of other work already
compose ([status](../../status.md#coalesced-typing-bursts-merge-002-case-1--2026-11-07));
what is left is a move with edits inside the moved material, several selections,
copies, entry chains and undo. Implement each case in the Swift and TypeScript
clients, using shared examples and the host merge engine to prove the result.

## Starting point

Read the implementation and tests before selecting a case:

- [Update machine and runner](../../docs/implementing-sync-services/update-machine.md).
- [Editor capture and publication](../../docs/implementing-editors/editor-source.md).
- [Source intent and provenance](../../docs/overstory-spec/10-source-intent.md).
- Swift `ChangePublication.swift` and TypeScript `publication.ts` in their
  working-tree packages; `docs/overstory-spec/conformance/coalesced-publication.json`.
- [Native 008](../when-needed/merge-008-copies-with-changes-and-compound-undo.md) owns missing
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

`tests/performance/coalescing-bursts.ts` measures each burst on a 64 KB page
(encoded request bytes, updates, frames, operations, preparation time). After
case 1, typing, backspacing, corrections and word replacements send about 1 KB
in one frame, and pure move runs about 1.2 KB. The largest remaining bursts are
moves with edits between them: "moves around typing" (five Option-arrow presses,
four characters typed in the block, five more presses) sends 2.1 KB in three
frames, and "move then edits" 1.7 KB in two. So the next saving is small per
burst; take the cases below when measurements on real journals show them matter,
and re-run the script before choosing.

| Order | Case | Expected benefit |
| --- | --- | --- |
| 2 | Move plus edits | One move of the original span plus the edits inside it, in one frame: about 0.5-1 KB per burst over today's frame per side. |
| 3 | Repeated moves of selections/subtrees | Several separate spans moved together; a single contiguous selection already composes. |
| 4 | Copy followed by edits/moves | Duplicate-and-adapt workflows; measure frequency and payload first. |
| 5 | Entry rename/move chains | Usually small directory payloads; pursue only if real workflows show large duplication. |
| 6 | Undo/redo cancellation and snapshot reductions | Potentially large savings, but origin, hidden-state and dependency proofs are harder. |

## Remaining cases

2. **Move plus edits.** Collapse movement with text edits inside the moved
   material, re-indentation and separator changes into one frame: an
   original-source move plus edits stated over the same basis (a frame's edits
   address basis bytes wherever its moves put them). Decide where an insertion
   at the moved span's edge belongs before composing it. Carry a peer's edit
   with the moved material. Do not turn it into deletion and retyping. Runs of
   moves on either side of an edit already collapse one per side.
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

Runner-level interruption vectors (before preparation, after durable
preparation, after acceptance, before acknowledgement) have not been repeated
with a composed burst; the composition happens inside the deterministic compile
step that the existing vectors freeze, so add them with the next case.

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
