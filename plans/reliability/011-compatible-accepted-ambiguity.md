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

Use one unversioned contract with one foundational, coordinated client/server
cutover. Every client installed at that cutover must remain safe with later server
conflict capabilities, without requiring review UI or detailed operation emission.
Later additive capabilities ship independently through the server-first release order and
compatibility gates below. This does not promise compatibility for arbitrary future
breaking changes to existing semantics. Never fall back to a server that discards
already accepted alternatives.

The [shared scenarios](../../conformance/accepted-ambiguity.json) are planned semantic
requirements, not executable conformance claims. Convert them to executable evidence
as the owning implementation lands. Keep existing conformance suites passing.

## 1. Adopt the consolidated contract compatibly

The [active request/read implementation](../../docs/update-wire-contract.md#active-accepted-state-adoption)
and [offline schema migration](../../migrations/006-accepted-state-links/README.md)
are in place, with [native cache compatibility and preserved-backup evidence](../../migrations/006-accepted-state-links/rehearsal.md).
Audit fresh live durable rejection records, transmitted uncertain requests, offline
clients and adopted prefixes. Resolve old requests with their original
build/bytes/semantics/digests; never rewrite historical receipts or translate pending
work in place. Coordinate fresh synchronized backups, clean-queue upgrades and
exact state/byte verification with Joe. Verify continued offline/restart syncing
and retain matching rollback artifacts. Keep transport object/delta codecs.

Port or explicitly archive old-format experiments; retain their historical evidence.
Complete material-based inspection as accepted alternatives become available.
Implement state-bound page tokens and alternative-scoped object authorization; no
fixed decision count cap may become an acceptance policy. Test metadata-only batch
continuity, stale pages, off-page dependencies and historical receipts. Complete
format-specific projection/action validation before enabling non-text controls.
Inspection action labels identify review capabilities, not opcodes.

### Foundational cutover gate

Finish these requirements before the single live client/server cutover:

- Verify adoption of the consolidated request, receipt and watch contracts against
  installed client disk formats and real backup copies, including opaque accepted
  identity, predecessor chains and same-root unresolved-state changes.
- Make baseline snapshot clients continue syncing and editing accepted conflicts
  without downloading decisions or understanding their formats. Preserve pending
  work and newer local bytes during acknowledgement and remote materialization.
  Canopy owns hidden-alternative preservation and prevents ordinary saves from
  becoming implicit resolution; clients do not reproduce that merge logic.
- Keep baseline clients tolerant of unknown optional read fields, decision kinds
  and action labels. Continue ordinary sync; do not invent mutation semantics for
  unfamiliar review actions. No capability-discovery endpoint, protocol-version
  ladder or negotiation handshake is needed.
- Establish server-first release ordering: implement, deploy and verify acceptance
  semantics on every destination authority used by a client before releasing that
  client's emission of those semantics. Verify supported reference/value forms and
  resolution behavior, not just recognition of an operation name. Record that
  prerequisite with each operation's release evidence.
- Retain whole-batch unsupported-semantics preflight as a failure safeguard. Preserve
  the original request on rejection; an uncertain outcome requires exact retry.
  Never silently strip already-authored operations or resolution declarations from
  durable pending requests. If a definitively rejected request is explicitly
  reauthored, retain the work and assign fresh identity.
- Preserve a baseline client build as a compatibility test artifact. Test it against
  a server accepting unresolved text, structural and opaque/binary decisions,
  including hidden-alternative preservation under ordinary snapshots. Until those
  engines exist, use disposable protocol scenarios to exercise the actual client
  queues, restart, same-root watch changes and newer local edits. Those scenarios
  establish client behavior, not future server merge correctness.
- Test unsupported suffix preflight and unknown read extensions. A client sent to
  an authority lacking its required operation support must fail without losing work;
  that combination is a release-order error, not a supported advanced-editing mode.
  Add actual server execution/preservation cases as each capability is implemented;
  keep the baseline client in the release compatibility matrix.

The cutover does not require every operation, production conflict creation, full
inspection or a resolution UI. Settle old-format queues with the original build,
verify backups and complete the gate with Joe. Thereafter an operation-aware client
ships after the corresponding server acceptance support is deployed and verified;
there is no requirement to update them simultaneously. Baseline clients continue
snapshots while server capabilities grow. Merge rules and review UI improve
independently within the deployed server contract. A server storage migration may still require its
own rehearsal, but must preserve accepted state without requiring client migration.

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
paged inspection. Commit state, provenance, projection and signal atomically.
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
all resolution semantics. Ship this path after server resolution support is deployed
and verified, respecting per-decision actions. A usable resolution path may be a product readiness gate
for enabling new conflict creation, but does not require upgrading every client or
another wire cutover. Test fallback that stops creating new decisions
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
Archive this plan only after the foundational cutover and first accepted-conflict
slice pass the mixed-capability gates and their evidence is recorded; keep later
operation/rule/UI work in 008–010.
