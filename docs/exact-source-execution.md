# Exact source execution foundation

The first production-oriented `editSource` component is implemented on main in
`packages/canopy/src/updates/source-edits.ts`. It is a pure executor and candidate
validator, not yet connected to Canopy acceptance. Live and source-built Canopy
still reject every operation-bearing batch before accepting a prefix.

## Implemented

The executor resolves basis paths and guarded objects, then optional `within`
selectors and UTF-8 byte ranges. It verifies object hashes, rejects traversal across
nested tree boundaries, and distinguishes equal file objects at different paths.
It applies disjoint edits using immutable basis coordinates, rebuilding only affected
directories and preserving all untouched source bytes and neighboring entries.

Replacement lineage must match exact selected source bytes. Ordered, nonoverlapping
preservation inside the replaced selection is supported. Evidence records retain
operation keys, source path/object/ranges, replacement text and verified lineage,
even for a replacement that reproduces the original bytes. The complete reconstructed
root must equal the submitted candidate; unrelated candidate changes fail validation.
Evidence is returned to the caller, not yet written to durable storage.

This component requires its future authority caller to bind the basis to an
authorized accepted state in the same tree. Object hashing is not authorization.
The existing Wire codecs still own grammar and request-size limits.

## Deliberately not enabled

Retained operation-result/alternative references, overlapping or same-anchor edits,
and reordered/reused or outside-selection lineage require causal material execution.
They return an explicit unsupported error in this component. No snapshot fallback
or implicit copy/move claim is introduced. These are implementation bounds, not
changes to the portable specification.

## Next acceptance slice

Before enabling client emission, add a durable change/operation store and bind
validated evidence to tree, accepted state and `(change, operation)` in the same
transaction as ref advancement and observation. Reject contradictory identity reuse;
retain creation material and required roots through compaction and backup. Consult
[storage 001](../plans/canopy-storage/001-pack-object-storage.md); packing itself is
not required.

Wire the validator into acceptance with whole-batch unsupported-form preflight,
exact replay, metadata-only accepted states, and candidate verification before
object persistence. Conservative concurrency handling must preserve authored intent;
do not pass operations through a snapshot merge and discard their meaning. Run
restart/rollback and mixed snapshot-client tests, then deploy and verify server
support before editor emission. No client/server cutover is needed for that release.

The [operation plan](../plans/reliability/008-enable-source-operations.md) owns this
remaining work. The old experiment remains useful for causal runs and arrival-order
cases, but its earlier reference vocabulary must not be promoted unchanged.
