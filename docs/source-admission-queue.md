# Exact source admission queue

This is a client implementation checkpoint for the
[exact authored basis contract](../spec/09-client-synchronization.md#exact-authored-basis).
`SourceAdmissionQueue` exists in `ArborWorkingTree` and `@arbor/canopy-client`.
The Swift queue is connected to document acknowledgement, recovery and publication
behind `UpdateCoordinator.sourceOperationEmission` (default `false`). Native passes
its coordinator to the provider, which selects this path only when explicitly enabled.
Installed clients still use the existing head/attempt/rejection path. The TS queue now has a `SourceDocumentSession` and `SourceAdmissionPublisher` consumer;
these are library APIs and are not connected to an installed editor host.
This checkpoint does not enable emission in installed clients or migrate legacy work.

## Retained records and enforced policy

Each immutable record carries a client-generated change identity, tree scope,
an exact basis graph, candidate and publication dependency. Source records also
retain guarded edits and `editSource` operations. Swift structural records retain
snapshot candidates with `operations: null` in the same ordered queue. For source edits, the queue builds the candidate by replacing
only the selected physical source file and its ancestor directories. It preserves
other files, directory metadata and tree boundaries. Source ranges must be ordered,
guarded where supplied, and aligned to UTF-8 scalars. Candidate verification uses
exact bytes, including CRLF and distinct Unicode normalization forms.

A dependency explicitly names either an accepted update/root or an earlier
local change. An authored predecessor must already exist in the same queue and
its candidate graph must equal the child's basis. Root equality never chooses
which parent the author meant. This permits two distinct changes to have identical
candidate roots without losing their identities or collapsing a semantic edit.
The accepted update is supplied by the client's verified accepted state; these
local records are not a replacement for authorization or server validation.

`WorkingTree.captureSourceAdmissionBasis` captures document source, physical source
path, graph and accepted identity synchronously in one actor turn. A later watch
cannot relabel this value. An unaccepted capture requires an explicit retained
predecessor; the client does not guess one from a matching root. The captured value
checks the editor's document reference, revision and exact source before preparing
a record. Existing file edits use `editSource`. The first save of an empty directory
body explicitly creates a snapshot in both languages; it never invents an empty
file hash to use as source material. Generated projections need their own execution
forms.

Preparation and retention are separate so callers can retry an uncertain disk write
with the same record. Retention revalidates the graph, operations, tree scope and
parent chain; it rejects reused identities with changed meaning and altered recovered
records. Exact retries are idempotent. The complete journal is written to a private
temporary file, fsynced, renamed and its directory fsynced before returning. The
Swift queue locks concurrent writers; TS instances serialize within the owning
client process. As with the existing TS sync state, one process must own its state
directory. Cross-process ownership enforcement remains an integration requirement.

The journal is `sync/source-admissions.json`, separate from legacy update control
and editor backup history. Opening a corrupt journal fails without rewriting it.
There is no pruning or coalescing yet. This deliberately preserves all ancestors
after publication settlement; reclamation remains unimplemented. It is not the final
long-running storage policy and does not require packfiles.

## Request preparation

`request(through:)` follows explicit predecessors back to the accepted basis and
returns the original candidate chain. Retrying a suffix after Canopy selected a
peer alternative therefore repeats the original accepted prefix, rather than
rebasing the suffix onto the visible peer. The transport's existing immutable
attempt record still owns freezing the first attempted request. This queue does
not contact Canopy or advertise support for an operation.

## Swift session and publication integration

An enabled session reports `WorkspaceAdmissionPolicy.retainedBasis`. It returns an
opaque revision that binds either an accepted update/root plus document scope, or
a retained local change identity. A byte revision alone never selects that basis.
On admission the coordinator validates the intent against the capture, persists the
complete queue record, and only then returns a local document acknowledgement.
Exact admission retries reuse the retained identity, including concurrent calls.

The installed working tree remains Canopy's projection. Sessions read their latest
pending candidate, including from a second session or after restart. A pending
candidate is not copied over a newer accepted projection. Once Canopy accepts it,
the installed projection becomes authoritative; an editor still authoring against
an earlier local candidate can name that retained predecessor explicitly.

Publication uses the existing coordinator's single-flight scheduling and immutable
request storage. It submits original predecessor chains, checks receipts, installs
reconciliation, and records accepted change identities only after materialization.
A later candidate remains independently durable while an earlier request runs.
Replay catches up to Canopy's current descriptor so an old receipt is not treated
as the latest head. Unsupported or old rejection responses retain the exact request
and queue without creating a new legacy conflict workspace.

Source mode writes local update-control schema 3. A source-disabled coordinator
refuses to open it; default legacy state remains schema 2. Activation refuses
retained legacy heads, requests and conflicts. Structural actions, imports and
assets now share the Swift durable admission path. They stage against the latest local candidate or an atomic accepted capture,
retain a snapshot and explicit predecessor, and only then return to the host.
Provider navigation, reads and source sessions can use pending candidate graphs;
the accepted working tree remains Canopy's projection. Structural captures are
serialized, and a failed retention retries its prepared candidate and identity.

Local Trash is absent from Wire snapshots. Structural records therefore also retain
private Trash nodes and locally held file objects, so deletion does not destroy
the ability to restore after another action or restart. Empty Trash state is retained
after restore to prevent older records from resurrecting it. Existing source-only
journals remain readable. Source-local revision tokens remain recoverable; newer
candidate tokens additionally identify the document within a multi-document snapshot.

The editor bridge checks the session policy when restoring an unsaved draft. A
retained-basis session receives the original basis and guarded patch even when its
current projection differs or has equal resulting bytes. Legacy providers retain
their existing recovery review. No accepted-conflict decision is owned by the bridge.

## TypeScript session and publication integration

`SourceDocumentSession` captures a document from one accepted descriptor and its
immutable snapshot. Its opaque revision retains accepted update/root identity,
logical document path and physical source path. A captured graph remains available
for offline admission. Pending candidates supply local read-your-writes; after
settlement, reads return Canopy's projection. A recovered editor intent can recover
its original accepted graph or retained authored predecessor without rebasing.
Equal source bytes never substitute for accepted identity.

The session validates exact source intent through the queue before acknowledging.
A domain-separated hash of the scoped intent gives concurrent identical admission
retries the same change identity, including across session instances. Distinct
accepted bases or authored predecessors remain distinct even at equal roots.

`SourceAdmissionPublisher` processes the earliest unsettled record, submitting its
original dependency chain. The immutable queue is the retained request: admitting
a successor cannot alter the request already being sent. Failed requests,
malformed receipts, old rejection responses and failed installation leave that
record pending. Publication is serialized across instances in one process.

After acceptance it fetches the current descriptor and snapshot, rather than
installing a historical replay receipt as the latest state. The host installation
callback must durably install projection and accepted identity and serialize with
watch installation. Only then does the publisher atomically write and fsync
`sync/source-settlements.json`. A crash before settlement replays the same request;
a hidden-candidate successor repeats its original accepted prefix. Conflict-bearing
acceptance follows this ordinary path without a client conflict workspace.

These APIs still require a host to own its state directory exclusively, schedule
publication and integrate durable materialization. They do not enable filesystem
source inference or replace the filesystem synchronizer's snapshot path.

## Verification and remaining integration

[Shared vectors](../conformance/source-admission-queue.json) run in Swift and TS and
compare complete request values. They cover nested source paths, exact Unicode/CRLF,
equal-root authored successors and equal-root distinct accepted bases. TS tests also
execute generated operations through Canopy's independent executor and compare
candidate roots. Both queues exercise disk failure, retry, corruption, missing
parents, reused identities and concurrent queue instances.

Swift session tests cover an R1 edit after R2 installation, local read-your-writes,
a successor admitted during publication, a conflict-bearing peer projection,
immutable replay after all eight publication failure points, concurrent admission
retries, and refusing to silently downgrade source state. Bridge tests cover
retained-basis draft recovery without local review alongside legacy recovery.
The shared Swift/TS admission reducers now enforce the session policy: an
unexpected stale/CAS response from a retained-basis provider is a retained failure,
never local conflict review or acknowledgement inferred from equal bytes.
The protocol harness also runs the production Swift session/coordinator through
real disposable Canopy with root and nested range edits: R1 capture, several peer
updates, stale admission,
restart, accepted ambiguity, a hidden-candidate successor, historical inspection,
stale-resolution rejection and resolution from a second client. The test verifies
both retained file hashes and adoption of an equal-root resolution identity.
The harness now also drives real Quagmire editing through the production session
and coordinator. It verifies both direct R1 admission after R2 and recovery from
an editor-only draft with an empty publication queue, followed by client restart,
accepted conflict, another ordinary editor save and Canopy-owned resolution.
Native UI execution and the broader emitted source/structural forms remain release
gates; this does not enable installed-client emission.

Verification for this checkpoint: `bun run typecheck`, `bun run test`,
`bun run test:protocol`, the full `ArborWorkingTree` Swift suite,
`tools/test-arbor-quagmire-local.sh`, and a macOS `Arbor` build using the local
workspace passed. Repository-wide relative-link/fragment checks introduced no
new failures; existing broken links remain outside this change. No installed app
or server was upgraded.

Remaining work in [008](../plans/reliability/008-enable-source-operations.md):

- Connect the TS session/publication APIs to a maintained editor host when that host is built; enforce exclusive state-directory ownership there.
- Verify deployed ancestor acceptance and cover general merged-predecessor suffixes before installed-client activation.
- Add safe coalescing and bounded reclamation of settled ancestry and captured views.
- Enable emission only after Canopy's deployed acceptance covers the emitted forms;
  preserve legacy conflicts until they have been settled or safely transferred.

The TS consumer now passes a disposable-Canopy scenario covering stale R1 admission
after R2, concurrent admission retries, client restart, accepted conflict, hidden
successor publication, inspection, and a second-client equal-root resolution.
Focused tests cover failed materialization, corrupt settlement, old rejection,
receipt mismatch and offline admission from a captured graph. Typecheck, the full
TS unit/integration suite and cross-language protocol gate passed. Installed apps
and the deployed server were not changed by this consumer implementation.

The Swift mixed-admission scenario now exercises create, source edit, directory
creation, move, copy, rename, binary import, asset storage, trash and restore through
real disposable Canopy. It restarts with the queue pending, interrupts after server
acceptance, then replays and publishes the remaining chain. Focused tests also cover
first directory-body saves, failed structural retention, pending reads, read-only
providers and private Trash recovery. Native's activation switch remains off: the
server ancestor acceptance now has dedicated HTTP coverage; deployment and client
release checks are required before ordinary use and legacy recovery UI removal. Interleaved stale
source branches and structural actions across multiple open documents also remain
a release gate; the mixed structural test proves a linear dependency chain.

Validation: 772 TS tests, 70 Swift working-tree tests, the cross-language protocol
gate (including real Quagmire admission), typecheck and the local-workspace macOS
build passed. One full-suite collection-row test failed initially and passed in
isolation and on the subsequent full run. Relative-link checks introduced no new
failures; 24 existing unresolved links remain. No deployed binary was changed.
