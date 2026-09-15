# Reliability 011: Activate accepted ambiguity without blocking filesystem sync

Status: IN PROGRESS. Priority: P1. This plan owns sequencing for
[008](008-enable-source-operations.md), [009](009-canopy-provenance-merges.md) and
[010](010-client-conflict-review.md), which retain implementation ownership.
The spec may remain ahead of implementation. Coordinate live activation with Joe;
preparatory work does not authorize deployment.

## Compatibility invariant

Canopy owns attribution, preservation of alternatives and explicit resolution on
all write paths, including snapshots. Clients durably retain the exact accepted
basis, unresolved signal, pending requests and newer local edits. Accepted conflicts
must not create a local hold or pause sync. Clients need no downloaded identity map,
merge engine or review cache to perform ordinary editing.

Use one unversioned contract and coordinated upgrades. Verify stale/offline clients
before activation. If compatibility cannot be assured, add an explicit guard first.
Never fall back to a server that discards already accepted alternatives.

The [shared scenarios](../../conformance/accepted-ambiguity.json) are planned semantic
requirements, not executable conformance claims. Convert them to executable evidence
as the owning implementation lands. Keep existing conformance suites passing.

## 1. Adopt the consolidated contract compatibly

Use the [target semantic models and complete request codecs](../../docs/update-wire-contract.md).
Connect the complete codecs to active TS/Swift submission, builders, digest calculation and durable
queue fields together with Canopy decoding and exact accepted-state preconditions.
Keep transport object/delta codecs. Resolve transmitted uncertain requests with their
original bytes/semantics/digests before retiring the old encoding; never rewrite
historical receipts or silently translate pending requests. Audit offline clients
and adopted prefixes before cutover. Remove superseded grammar after adoption rather
than adding a permanent versioned API or adapter. Test changed guards and declarations
changing digests, prefix identity stability, restart and recovery before activation.

Port or explicitly archive old-format experiments; retain their historical evidence.
Adopt the target read models with simplified receipt outcomes, predecessor identity
chains, explicit unresolved signals, material-based inspection.
Implement state-bound page tokens and alternative-scoped object authorization; no
fixed decision count cap may become an acceptance policy. Test metadata-only batch
continuity, stale pages, off-page dependencies and historical receipts. Complete
format-specific projection/action validation before enabling non-text controls.
Inspection action labels identify review capabilities, not opcodes.

## 2. Prepare Canopy to validate and retain intent

Implement each operation family's validation, exact candidate correspondence and
atomic provenance retention before permitting its emission. Initially retain
conservative reconciliation: advanced intent-based merging may follow later.
“Not using intent yet” must never mean discarding it or accepting an operation as an
unchecked hint. Unsupported operations still reject the entire batch in preflight.

Use [storage 001](../canopy-storage/001-pack-object-storage.md) and related storage
plans for retention constraints. Packing is not a prerequisite. Rehearse storage
changes on a copy; verify exact roots, accepted identities and inventory.

## 3. Enable client emission

Emit each operation only after Canopy supports its acceptance semantics. Verify
exact accepted bases, immutable retry, restart, same-root metadata transitions and
protection of newer local edits during remote materialization. Clients do not infer
alternative correspondence or resolve decisions through ordinary saves.

## 4. Accept and track unresolved text decisions

Implement competing replacements, ordinary projection, durable alternatives and
bounded inspection. Commit state, provenance, projection and signal atomically.
Continue ordinary edits, including snapshots from clients without review UI; preserve
hidden alternatives and open decisions. Accept representable ambiguity rather than
rejecting merely because attribution is uncertain. Reject invalid or unsupported
semantics without claiming acceptance.

Implement the [target inspection contract](../../docs/update-wire-contract.md)
with authorized responses and retention/resource tests. The earlier bounded text
inspection endpoint remains on the experiment branch and is not an implementation
prerequisite for this consolidated target. Test accepted versus
rejected results, retry, restart, equal-root changes and ongoing edits from both client
languages. Acceptance must clear the submitted pending work normally while preserving
newer local edits. A failed inspection fetch must not stop ordinary sync.

## 5. Add explicit client resolution

Provide one usable end-to-end text resolution path with exact accepted-state and
alternative guards. Fetch evidence on demand. Preserve user-authored drafts and
pending requests; stale evidence requires refresh before resolution. Canopy enforces
all resolution semantics. Coordinate everyday activation after this path and client
compatibility have been verified. Test fallback that stops creating new decisions
while retaining, serving and permitting resolution of existing ones.

## 6. Improve operation coverage and merge rules incrementally

Add source-aware merging and format-specific rules, initially recording proposals
without applying them. Record rule identity/revision, evaluated state, alternatives,
constraints, result and provenance. Test false merges separately from coverage.
Automatic resolution uses the same guarded persistence path as explicit human
resolution, with distinct authorship. Equal bytes never implicitly close decisions.
Extend structural and binary operations with paired client/server fixtures.

## Remaining rejection scheduling

Independently improve the filesystem scheduler so definitive rejection does not
block provably independent work. This addresses unaccepted edits, not accepted
alternatives, and is not a new prerequisite created by accepted conflicts. Preserve
original requests/bases/suffixes, transaction dependencies and durable accounting for
separately published effects. Unknown outcomes require exact retry first. Test B
arriving on another client while rejected A remains recoverable, then replay A without
losing or duplicating B. Never invent independence merely from different paths.

## Deferred conveniences

Durable inspection caching, offline review, polished comparison/navigation and other
review conveniences are deferred. They do not gate intent emission or accepted
conflicts. Essential local-edit, draft and pending-request durability remains required.
Archive this plan only after the first compatible slice is activated and its evidence
is recorded; keep later operation/rule/UI work in 008–010.
