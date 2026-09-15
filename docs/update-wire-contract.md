# Consolidated update contract: specification readiness

The [portable update contract](../spec/01-tree-operations.md#21-the-update-request)
and [material/resolution semantics](../spec/10-source-intent.md) define the target.
The deployed HTTP codec and persisted requests still use the previous protocol-ready
encoding. This is staged implementation, not a second API version or negotiation.
Do not submit target-shaped requests through the existing `WireClient` yet.

## Target request

Each candidate carries `change`, `candidate`, explicit `operations`, required
`resolves`, optional `ifCurrent`, and the existing `objects`/`deltas` transport.
`operations: null` selects snapshots. Empty operation arrays require at least one
resolution declaration. Ordinary writes reconcile; exact-state guards use accepted
identity. `ifMatch`, `onConflict`, output names and special alternative-edit/resolution
opcodes are absent. Inspection action labels remain user capabilities, not opcodes.

A material reference identifies a basis object, operation result or accepted
alternative, then optionally selects descendant names and UTF-8 ranges. Entry
destinations identify a parent plus one name. `replaceEntry` takes an explicitly
kinded file/directory object or referenced entry material. It retains the target's
outer entry identity; copy remains the operation for intentional duplication.

A `resolves` declaration endorses the candidate's result for a complete guarded
reviewed decision. Several declarations in one candidate are atomic; several
candidate elements are sequential and may leave an accepted prefix. The candidate
must preserve unnamed decisions, and stale dependent evidence invalidates resolution.

## Paired executable models

- [TypeScript semantic model](../packages/wire/src/updates/authored-contract.ts).
- [Swift semantic model](../native/Packages/ArborWire/Sources/ArborWire/WireAuthoredContract.swift).
- [Shared grammar and identity vectors](../conformance/wire-authored-updates.json).

These models decode the semantic portion of requests and compute exact CBOR/digests.
The semantic models exclude transport arrays. The complete request codecs below
combine them with the existing object/delta transport. Vectors use synthetic object hashes: grammar and digest
agreement does not prove graph reachability, source attribution or server execution.
They are not wired into endpoint submission, active persistence or the experimental
authority. The existing deployed codecs and their historical vectors are unchanged.

## Complete request codec

The [TypeScript request codec](../packages/wire/src/updates/authored-transport.ts) and
[Swift request codec](../native/Packages/ArborWire/Sources/ArborWire/WireAuthoredTransport.swift)
combine authored semantics with complete objects and sparse deltas. They validate
required fields, complete-object hashes, unique result hashes, canonical base64,
delta quotas and activation restrictions. Semantic validation is shared with the
existing target models; source execution, reachability and candidate correspondence
remain authority checks.

The [complete-request vectors](../conformance/wire-authored-transport.json) cover 24
transport cases with real object bytes and exact semantic identities. Both languages
also run all 43 semantic vectors through the complete codec. Complete and sparse
encodings reconstruct the same candidate graph and carry the same digest. Tests
persist and reload requests, append a successor, and verify that the original
candidate and digest remain unchanged. These are codec persistence tests, not proof
that the active queue has adopted the new format.

Legacy `ifMatch` and `onConflict` fields fail closed. There is no translation or
alternate endpoint. These codecs are not connected to active submission yet; an
uncertain deployed-format request must still be settled with its original codec.
The maintained protocol gate runs the target TS tests and Swift suites alongside
existing deployed-format compatibility tests.

## Next implementation cutover

[Plan 011](../plans/reliability/011-compatible-accepted-ambiguity.md) owns the sequence.
Adopt these target models in both active codecs, request construction, hashing,
Canopy validation/preconditions, durable queues and editor emission together. Preserve
already transmitted requests and resolve unknown outcomes using the original codec
and digest before retiring it. Any definitively unaccepted re-authored work gets a
fresh identity; never translate an uncertain request in place. Preserve accepted
historical receipts/digests as historical evidence rather than rehashing them.

After coordinated adoption, remove the superseded active grammar rather than retaining
an alternate API or permanent translation adapter. Port or archive the isolated
experiments explicitly; do not mistake old-format experiment passes for new semantic
execution. Upgrade server validation/retention before enabling each operation family.
Live activation remains coordinated with Joe; this milestone changes no installation.

Remaining specification work includes detailed format-specific resolution constraints. Resolution caching and other conveniences remain deferred.

## Historical verification before extraction

The following results were recorded on `codex/source-intent-experiment` before
extracting the contract onto main; they are historical evidence, not main test counts.

The target grammar has 43 shared positive/negative vectors with matching TS/Swift
CBOR bytes and digests. The Wire unit suite passes 145 tests, the standalone Swift
ArborWire suite passes 30, and the complete product suite passes 703. The existing
cross-language/live protocol gate passes; it verifies continued deployed-format
compatibility, not target operation execution. Type checking, repository-wide
relative-file-link checks and `git diff --check` pass without new broken file links.

## Accepted state, inspection and rule evidence

The target read contract now uses `unchanged | accepted` submission outcomes and
accepted state with `previous: { id, root } | null`. `conflicted` is explicit. The
predecessor identity chain establishes accepted order independently of observation
cursors, including same-root transitions and multi-update frames. There is no
accepted-state `kind` or hard-coded `MergeSummary`; restoration and rule execution
are provenance. Historical receipt replay is distinct from observing the latest head.

Inspection uses material references and text, explicitly typed entry, placement or
absence alternatives. State-bound paging and individual decision reads let clients
fetch dependency closure as needed. There is no fixed decision/alternative count cap
in inspection or resolution declarations. Paging bounds transfers, not accepted state.
Alternative object reads authorize reachability from the exact reviewed alternative.

[Tree operations](../spec/01-tree-operations.md#123-reading-conflicts) owns conflict
inspection and its shared material-reference types. The target conflict and alternative
object reads are specified but not active. There is no dedicated rule-evidence route
or response model: the specification requires retained rule identity, evaluated inputs
and resulting decisions, with additional fields defined by each rule. Unknown fields
cannot grant authority.

[TypeScript read models](../packages/wire/src/updates/accepted-contract.ts),
[Swift read models](../native/Packages/ArborWire/Sources/ArborWire/WireAcceptedContract.swift)
and [shared read/chain vectors](../conformance/wire-accepted-state.json) validate the
target shapes independently of active HTTP codecs. Their grammar checks do not prove
projection correspondence, server authorization, paging traversal or semantic execution.
Keep active read/write codecs compatible until coordinated adoption replaces them.

Historically, the experimental accepted-state consolidation passed 742 product tests, 32 standalone ArborWire
Swift tests, type checking and the cross-language/live compatibility gate. The 37
shared read/chain vectors cover opaque predecessor identity, same-root transitions,
simplified outcomes, off-page dependencies and open rule-specific details. Additional
TS/Swift checks accept 40 resolution declarations with 1025 alternatives each; no
fixed decision or alternative count cap is introduced by the target models. These
checks verify contract decoding and identity continuity, not new server execution.
Repository-wide file-link and section-link checks introduce no new broken references;
`git diff --check` passes.

## Main integration boundary

The spec, paired target models, shared fixtures and remaining plans are maintained on
main. Experimental merge execution, editor capture harnesses and the superseded
bounded inspection endpoint remain on `codex/source-intent-experiment`. No active
Canopy route, client submission codec, persistent queue format or Quagmire dependency
is changed by this extraction. Continued implementation starts from main and follows
Plan 011; live activation remains coordinated separately.

Extraction was verified against main base `94a7002`: 552 product tests, 84 focused
target-contract tests and 30 standalone ArborWire Swift tests pass. The full
cross-language/live protocol gate and type checking pass. Repository-wide file and
section links introduce no new broken references, and `git diff --check` passes.
The different product count reflects leaving experiment-only tests and the superseded
inspection implementation on their branch rather than claiming them as main support.

## Tree-read ownership cleanup

Conflict inspection and its shared reference types now live in tree operations.
The speculative rule-evidence endpoint and paired response models have been removed;
semantic evidence retention remains required. The shared read fixtures now contain
32 cases, including explicit-null snapshot contribution validation through inspection.

Verification: 547 product tests, 79 focused authored/read-contract tests, 30 standalone
ArborWire Swift tests and type checking pass. Repository-wide relative file and section
links introduce no new broken references, and `git diff --check` passes. Active codecs,
server behavior and deployment remain unchanged.

The complete-request checkpoint passes 617 product tests, 70 focused transport tests,
33 standalone ArborWire Swift tests, type checking and the full cross-language/live
protocol gate. Relative file/section checks introduce no new broken references and
`git diff --check` passes. Live installations are unchanged.
