# Consolidated update contract: specification readiness

The [portable update contract](../spec/01-tree-operations.md#21-the-update-request)
and [material/resolution semantics](../spec/10-source-intent.md) define the target.
The implementation in this worktree uses the consolidated request and accepted-state
encoding in active TypeScript/Swift clients and Canopy. Accepted receipts now use
`unchanged | accepted`; watch replay checks predecessor identity and root. Installed
apps and Canopy have not been upgraded. The [active adoption checkpoint](#active-accepted-state-adoption)
records verification and remaining cutover gates. This is one unversioned contract.

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

## Active conflict inspection subset

The [whole-entry accepted-conflict implementation](accepted-entry-conflicts.md) now
serves the specified conflict page and alternative-object routes. TypeScript and
Swift readers use the existing `DecisionPage` encoding and validate accepted context.
Current operation-mode resolution supports complete current-state guards, keeping
the projection or replacing a whole text file. This is an additive implementation
of the existing contract, not a new protocol version. Schema 10 is not deployed.

## Paired executable models

- [TypeScript semantic model](../packages/wire/src/updates/authored-contract.ts).
- [Swift semantic model](../native/Packages/ArborWire/Sources/ArborWire/WireAuthoredContract.swift).
- [Shared grammar and identity vectors](../conformance/wire-authored-updates.json).

These models decode the semantic portion of requests and compute exact CBOR/digests.
The semantic models exclude transport arrays. The complete request codecs below
combine them with the existing object/delta transport. Vectors use synthetic object hashes: grammar and digest
agreement does not prove graph reachability, source attribution or server execution.
The request models are wired into active submission and pending-request encoding.
The read models now also validate active decoding. Historical old-format vectors retain their original
bytes and digests; the experimental authority remains on its separate branch.

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
alternate endpoint. An uncertain deployed-format request must be settled with the
old build before upgrading; it cannot be translated into the new request identity.
The maintained protocol gate runs the target TS tests and Swift suites alongside
existing deployed-format compatibility tests.

## One foundational cutover

[Plan 011](../plans/reliability/011-compatible-accepted-ambiguity.md) owns the sequence.
The request-side implementation is complete in this worktree. Snapshot constructors
emit `operations: null` and `resolves: []`; optional `ifCurrent` binds accepted
identity. Canopy checks replay before the guard and uses the guarded accepted ID
in its commit comparison, so same-root advancement cannot bypass a precondition.
The existing conservative snapshot merge engine remains in use. Canopy rejects an
entire batch with `422 unsupported-operation` if any element has operations or
resolution declarations; grammar support never implies semantic execution.

Accepted-state/read adoption now includes simplified outcomes, predecessor ID/root
chains and required unresolved signals. Inspection follows as accepted decisions
become available. Complete baseline client disk-format compatibility in this same
cutover, as required by Plan 011.
No capability-discovery endpoint or negotiation mechanism is needed.

After that foundation, deploy and verify server acceptance of each new operation
and its input forms before releasing clients that send them. These are separate
releases with a dependency, not simultaneous upgrades. Baseline clients continue
ordinary snapshot editing through accepted conflicts; Canopy preserves hidden
alternatives and enforces resolution. Unknown optional read extensions do not stop
ordinary sync. Merge rules and review UI can improve independently within the
existing contract. Keep whole-batch unsupported-semantics rejection and immutable
request recovery as safeguards against release-order mistakes.

Preserve baseline client builds and test them against newer servers. The commitment
covers additive capabilities, not arbitrary changes to existing request semantics.
Server rollback must continue honoring all semantics and accepted state already in
use by released clients; disabling new conflict creation must not discard existing
alternatives or their resolution paths.

Before live cutover, audit all offline/native and filesystem queues and adopted
prefixes. Resolve unknown outcomes with the original request body and old build.
Neither client silently rewrites an incompatible pending record: the filesystem
loader rejects it, and native coordinator initialization rejects it before submission
or persistence. Recovery tests verify that the old bytes remain on disk. Accepted
historical receipts and digests remain unchanged in Canopy storage. A clean queue
allows new requests to use the new encoding; pending work requires explicit recovery.

The superseded active operation grammar is removed. Historical experiments and vectors
remain evidence of their original contract, not new semantic execution. Validation and
retention must precede emission of each operation family. Live activation remains
coordinated with Joe; no installation or data migration has occurred.

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
target shapes through the active HTTP codecs as well as standalone models. These checks do not prove
projection correspondence, server authorization, paging traversal or semantic execution.
Installation of the consolidated codecs remains part of the coordinated cutover.

Historically, the experimental accepted-state consolidation passed 742 product tests, 32 standalone ArborWire
Swift tests, type checking and the cross-language/live compatibility gate. The 37
shared read/chain vectors cover opaque predecessor identity, same-root transitions,
simplified outcomes, off-page dependencies and open rule-specific details. Additional
TS/Swift checks accept 40 resolution declarations with 1025 alternatives each; no
fixed decision or alternative count cap is introduced by the target models. These
checks verify contract decoding and identity continuity, not new server execution.
Repository-wide file-link and section-link checks introduce no new broken references;
`git diff --check` passes.

## Active accepted-state adoption

Canopy, TypeScript and Swift now use the target accepted-state and receipt models
on active HTTP/watch paths. Shared transport fixtures run through active decoders.
Private merge summaries stay in Canopy storage; they no longer determine a wire
outcome or expose a server-specific merge kind to clients.

Schema 8 stores predecessor IDs and unresolved flags. The
[offline migration](../migrations/006-accepted-state-links/README.md) preserves all
existing accepted-record fields, observation rows, digests and objects. Retention
can remove a predecessor later without changing its successor's link. New snapshots
preserve an existing unresolved flag. Production creation and resolution of retained
alternatives remain unimplemented; synthetic metadata tests do not claim otherwise.

Filesystem placements persist observation cursors separately from accepted IDs and
expose unresolved state independently of rejected-edit sync status. Equal bytes
cannot discard pending requests or advance the authored basis of newer local edits.
Native replay binds the first predecessor to its confirmed state. Historical receipt
acknowledgement clears no unseen observation range; the watcher refreshes its
snapshot boundary when it has no confirmed cursor. Bootstrap represents that cursor
as null rather than substituting an accepted ID.

Tests exercise continued filesystem editing/restart with a synthetic unresolved
signal, native metadata-only replay with an independent observation cursor, sparse
reconciliation, request recovery, exact history preservation and failed migration
rollback. These are disposable fixtures and services, not checks of installed apps.

Verification: 685 product tests pass, followed by 48 focused client/authority/read
checks after adding independent-cursor replay assertions. Type checking, 32 standalone
ArborWire Swift tests and the full protocol gate pass; the latter includes 58
WorkingTree Swift tests. Both offline migration tests pass. An earlier concurrent
full-suite run hit collection-sandbox and CLI timeouts; the unchanged full suite
passed when rerun without the competing Swift build. No timeout or assertion was
relaxed. Repository file/section checks introduce no new broken links.

Native saved placement/visit compatibility now adapts legacy missing flags only on
disk reads, leaving network decoding strict and source caches unchanged. The
[preserved-backup rehearsal](../migrations/006-accepted-state-links/rehearsal.md)
passed for Canopy and saved Mac/iPhone placements. Both native platform builds,
focused cache tests, migration tests, type checking and the protocol gate pass.

The [joint live cutover](../migrations/006-accepted-state-links/live-cutover.md)
completed September 15 with exact history/byte preservation, request replay and
Mac/iPhone restart checks. Ordinary-use/offline observation remains. Detailed
inspection, operation execution and review UI follow independently under the
server-first release order.

## Accepted read transport checkpoint

Historical preparation before active adoption: the staged TS and Swift read models now validate watch transition payloads and
submission reconciliation, using the existing complete-object/delta transport.
They require both predecessor identity and root, retain empty same-root transitions,
bind the final accepted state and unresolved signal to the descriptor, and keep
accepted IDs independent of observation cursors. Unknown read extensions survive
round trips; malformed known reconciliation fields do not pass as extensions.
Watch binding validation is separate from descriptor policy validation and requires
observation replay deduplication before checking the confirmed client basis.

[Shared accepted-transport fixtures](../conformance/wire-accepted-transport.json)
cover 24 positive/negative cases, including identity gaps concealed by equal roots,
omitted metadata transitions, exact Unicode identity, historical receipts, complete
object hashes, duplicate results and sparse transport. Both languages reconstruct
exact fixture graph bytes after a metadata-only transition followed by a content
transition. The maintained protocol gate includes these cases.

These checks are preparatory: active HTTP response codecs, server accepted-state
storage and client replay/coordinator paths still use the prior read representation.
This checkpoint does not establish durable client handling of accepted conflicts or
cutover readiness. Next wire the checked shapes through those paths and verify
observation replay/HTTP races, restart and local edits against disposable servers.
Retain historical accepted identities, request digests and provenance while adding
predecessor identity access; do not reset history to simplify adoption.

Checkpoint verification: 683 product tests, 59 focused read tests, 33 standalone
ArborWire Swift tests, type checking and the full protocol gate pass. The protocol
gate also passes 58 WorkingTree Swift tests against disposable services. Repository
file/section link checks introduce no new broken references; `git diff --check` passes.

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

## Active request adoption verification

The request-side adoption passes 658 product tests, 32 standalone ArborWire Swift
tests, type checking and the full cross-language/live protocol gate. An additional
native recovery regression passes: an uncertain request with a valid old-format
digest remains byte-for-byte intact and is never submitted by the upgraded coordinator.
The filesystem recovery regression verifies the equivalent pending-record behavior.
The final live protocol gate includes all 58 working-tree Swift tests.
Canopy tests cover same-root advancement, replay before stale guards, and preflight
rejection of a resolution-bearing suffix before accepting its otherwise valid prefix.
A later recorded digest proves an earlier unrecorded no-op prefix, so retries skip
stale guards and already-active activation checks without reapplying the prefix.
These results do not claim accepted-conflict storage or upgraded read responses.

One full product run hit an unchanged filesystem-watcher timing assertion. Its
21-test file passed in isolation, and the complete rerun passed all 658 tests;
no watcher implementation or assertion was changed.
