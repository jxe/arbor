# Exact source execution foundation

Source-built Canopy accepts the first exact-basis `editSource` subset. The pure
executor and candidate validator in `packages/canopy/src/updates/source-edits.ts`
are connected to acceptance and atomic provenance storage. This is not deployed;
live Canopy still rejects operation-bearing batches, and clients still emit snapshots.

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
The accepted-update store can now persist validated operations and evidence in
`authored_changes`, atomically with the accepted record, ref and observation.
Tree-scoped change identities cannot overwrite prior records. Equal-byte intent
is retained, and snapshot commits leave that evidence untouched. Exact retries
use the existing accepted-request receipt. The public acceptance path now supplies this evidence after validation.

Schema 9 adds this table through [migration 007](../migrations/007-authored-changes/README.md).
It preserves existing history without inferring operations. This server-only migration
has disposable-database tests but has not been rehearsed or deployed against live data.
Owning accepted records are protected by a foreign key; basis and candidate roots
are explicit retention dependencies included in integrity checking. Future compaction
must retain those graphs and the operation records together.

This component requires its future authority caller to bind the basis to an
authorized accepted state in the same tree. Object hashing is not authorization.
The existing Wire codecs still own grammar and request-size limits.

## Acceptance and concurrency

Operation batches require a retained non-null accepted basis. Each complete
candidate is reconstructed from its operations; later elements use the preceding
submitted candidate. The whole batch is checked for unsupported execution forms
before any prefix is accepted. Invalid candidate explanations also fail this preflight.
Existing policy authorization, graph validation and commit hooks still apply.

A source edit requires both the current accepted identity and the exact basis root,
with no unresolved conflicts. It bypasses snapshot reconciliation and creates an
accepted record even when its resulting bytes are unchanged. A stale basis returns
the existing structured conflict response, retaining any completed prefix. This is
conservative rejection, not concurrent operation merging or accepted ambiguity.
Retries of accepted requests return their receipts before checking a stale basis.
Reusing a retained operation change ID in a different request, including a snapshot,
is rejected. Snapshot-only behavior otherwise remains unchanged.

## Deliberately not enabled

Activation batches containing operations, retained operation-result/alternative references, overlapping or same-anchor edits,
and reordered/reused or outside-selection lineage require causal material execution.
They return an explicit unsupported error in this component. No snapshot fallback
or implicit copy/move claim is introduced. These are implementation bounds, not
changes to the portable specification.

## Next acceptance slice

Before enabling client emission, implement causal reconciliation and accepted ambiguity.
Retain creation material and required roots through
compaction and backup; define resynchronization before exposing retained outputs. Consult
[storage 001](../plans/canopy-storage/001-pack-object-storage.md); packing itself is
not required.

Concurrent edits currently receive a conflict response even if they affect different
files. Replace this restriction with causal material reconciliation that preserves
hidden alternatives and equal-byte intent. Keep ordinary filesystem snapshot clients
working without a new conflict-induced pause. Run mixed-client and arrival-order
cases, then deploy and verify server support before editor emission. The schema 9
server storage upgrade is required, but no coordinated client cutover is needed.

The [operation plan](../plans/reliability/008-enable-source-operations.md) owns this
remaining work. The old experiment remains useful for causal runs and arrival-order
cases, but its earlier reference vocabulary must not be promoted unchanged.

## Storage checkpoint verification

The provenance checkpoint passed the 699-test product suite, the protocol gate
(including 60 Swift working-tree tests), typechecking, and migration 007's three
preservation/rollback/version tests. Five focused provenance tests cover reopen,
exact receipt replay, same-byte acceptance, snapshot coexistence, tree-scoped
identity reuse, transaction rollback, and unprojected candidate retention.
Repository link/anchor checks introduced no new unresolved links.

## Acceptance checkpoint verification

The acceptance slice passed 709 product tests, typechecking, and the protocol gate
(including 60 Swift working-tree tests). Nine new HTTP integration cases cover
restart/replay after snapshot advancement, equal-byte acceptance, sequential
candidates, concurrent authors, stale equal-root bases, unsupported batch preflight,
identity reuse, injected transaction failure, completed-prefix retries, and access
and tree-basis checks. Link and anchor checks found no new unresolved references.
No server deployment, storage migration, client release or live-data edit was made.
