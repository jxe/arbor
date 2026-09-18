# Exact source admission queue

This is a client implementation checkpoint for the
[exact authored basis contract](../spec/09-client-synchronization.md#exact-authored-basis).
`SourceAdmissionQueue` exists in `ArborWorkingTree` and `@arbor/canopy-client`.
The Swift queue is connected to document acknowledgement, recovery and publication
behind `UpdateCoordinator.sourceOperationEmission` (default `false`). Native passes
its coordinator to the provider, which selects this path only when explicitly enabled.
Installed Native clients use source admission after the [verified cutover](native-source-cutover.md). The TS queue now has a `SourceDocumentSession` and `SourceAdmissionPublisher` consumer;
these are library APIs and are not connected to an installed editor host.
Native now always enables this path; unexpected legacy work is preserved for recovery rather than opening the retired rejected-update UI.

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
Schema 2 stores only roots, ordered object hashes and authored metadata. Accepted
graph bytes resolve through the client's existing content-addressed object API:
Native iOS uses its durable replica store, Native macOS uses Arbor Sync's object
route, and a TS host can supply its direct object store. The queue-owned CAS keeps
only objects introduced by pending updates (and Swift's private Trash material),
so an unchanged large tree is not copied into admission state. A standalone queue
without a platform store remains self-contained for library use.

Settlement compacts records only when no pending authored descendant depends on
them. It retains the latest settled lineage while the process may still have an
open editor revision for a hidden candidate; a restart with an entirely settled
journal releases that lineage. Object collection follows the smaller durable
journal. The iOS replica store uses retain-all policy for accepted objects, so an
older captured basis remains resolvable until a future explicit store lifecycle
policy replaces it. On upgrade, a fully settled legacy embedded-object journal is
identified by a bounded-memory top-level identity scan and retired without decoding
its snapshots. Unsettled legacy records migrate into the hash journal normally.

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
- Verify deployment of ancestor and merged-predecessor acceptance before installed-client activation.
- Add any desired long-horizon lifecycle policy for the retain-all iOS replica CAS.
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

## Bounded local behavior while Canopy reconciles branches

Native now preserves the pending structural view when an older open editor adds a
source branch. Further structural actions, imports and assets are unavailable
until the pending graph is coherent again; source admission and publication keep
running. The queue and accepted receipts determine this state after restart.
Provider capabilities report it and the coordinator enforces it, including calls
made through stale UI capabilities. There is no local branch merger.

Focused tests cover creating A, admitting R1-based B, continuing both documents,
failed structural/import/asset attempts and restart with unchanged durable records.
A separate test keeps a peer-created entry visible when an old source candidate
predates the installed accepted graph. The live scenario covers restart, uncertain
acceptance, reconciliation of A and B, a continuation of A, and structural actions
resuming after publication.

A stronger live trial with a second B edit reached the existing Canopy guard for a
successor of a merged predecessor. B's first candidate excludes A, whereas its
accepted projection includes A; the successor must retain the candidate basis.
Do not rebase that successor locally to bypass the guard. This remains a server
acceptance gate in 008, and the Native activation switch remains off.

Validation: typecheck, all 779 TS product tests, the full cross-language protocol
gate (73 working-tree tests, including the new live branch scenario), and the
local-workspace macOS build passed. Relative-link checks introduced no new
failures; 24 existing unresolved links remain. No installed app or server was
changed by this client checkpoint.

## Merged predecessor continuation

Canopy now admits source successors whose original predecessor candidate differs
from its accepted projection. The validated/replayed prefix supplies correspondence;
accepted history supplies concurrent contributions. Unrelated accepted entries
survive, and same-file uncertainty becomes accepted alternatives. Source basis and
operation evidence remain authored values. No Wire or schema change is required.
The stronger live branch scenario now includes B's second edit and A's continuation,
then verifies retry after uncertain acceptance, accepted publication, and resumed
structural actions. This closes the server rejection recorded above; deployment
verification and Native release/compatibility checks remain before activation.

## Native activation preparation

The [server continuation upgrade](merged-successor-deployment.md) is deployed.
Native now selects source mode for settled coordinator records on both platforms.
Retained legacy work still opens its original recovery path; after settlement a
subsequent open selects source mode. The constructor rejects incompatible state
and source-mode journals cannot reopen in snapshot mode. This is a local
compatibility gate, not capability negotiation with Canopy. Installed apps are not
changed by the source edit; their backup, upgrade and restart checks remain before
removing legacy code and UI.

Activation preparation validation: all 74 working-tree tests, the full protocol
gate, and signed Debug builds for macOS and iOS passed. Relative-link checks added
no unresolved links. The installed app transition has not yet run.

## Installed-client cutover complete

The [Mac/iPhone cutover](native-source-cutover.md) is complete. Both installed apps
activated source mode, each published three accepted `editSource` changes on the
temporary test page, received the other device's edits, and preserved their receipts
through restart. Cleanup restored the original content root. Both devices report
current state with identical accepted/local roots and no pending or legacy work.
The installed-client gate for removing legacy recovery machinery and UI is passed;
that code cleanup remains in 008. Historical backups remain intact.

## Rejected-update retirement (September 17)

The Native app no longer selects a legacy publication path or presents rejected
updates as a private conflict workspace. Swift's coordinator removes conflict
records, submission holds and client-owned resolution; both update reducers remove
the corresponding states, events and effects. Accepted unresolved results still
advance projection and identity and allow later edits. A rejected request retains
its exact body and basis across restart without implicit resolution or rebasing.

The control loader detects any non-null old `conflict` or `hold` payload before
Codable could ignore it, and refuses to open without rewriting the saved bytes.
Source activation still refuses pending snapshot work. Clean older controls can
activate source mode. The previous installed builds and private cutover backups
remain available for unexpected recovery needs.

Verification: 782 product tests, TypeScript checking/build, shared reducer fixtures,
73 Swift working-tree tests and the live cross-language protocol scenarios, plus
macOS and iOS app builds. The first combined run exposed a fixed-duration wait in
the existing filesystem-acknowledgement test; it now waits for the observed state
with a bounded deadline. This cleanup has not been installed on either device.
Canopy-backed Native review remains separate work in
[Reliability 010](../plans/reliability/010-client-conflict-review.md).

## Supported-operation capture checkpoint — September 17

The current implementation extends the existing queue without introducing an
unvalidated-intent mode or changing public Wire. Server execution support precedes
client emission.

- Swift and TypeScript source edits carry optional verified preservation lineage.
  Both validate byte equality, scalar boundaries, replacement order and distinct
  source occurrences. Queue recovery reconstructs the same operations.
- Arbor's Quagmire adapter uses stable block identities and exact retained source
  ranges to preserve unchanged blocks through reorder and compound edits. It keeps
  the original revision's ledger through debounce and in-flight admission, retains
  captured lineage in editor recovery, and does not treat equal-byte reorders as
  already saved. The shared admission-machine fixture exercises this distinction.
- `EntryTransfer` / `prepareEntryTransfer` build exact move/copy candidates from an
  explicit editor action. Native rename, move and copy emit those operations through
  the existing queue. A Native copy's fresh page IDs become subsequent `editSource`
  operations against the copy's operation-result reference. TypeScript exposes the
  corresponding durable `prepareEntryAdmission` path.
- `EntryActions` / `prepareEntryActions` retain one compound action against one
  original graph. Native moves, renames and copies both the directory and its
  sibling Markdown body, including a shadowed sibling beside `_index.md`. Each
  operation has a distinct key; copy metadata edits reference the corresponding
  copy result. Intermediate directory hashes never become basis references.
  Construction rejects overlapping/dependent entries and verifies the complete
  candidate. Swift and TypeScript replay the same shared entry-action fixtures.
- Trash remains private local storage, absent from Wire. Trashing emits one
  `removeEntry` per physical entry, atomically retained with local Trash bytes and
  metadata. Restore recreates those entries through an ordinary snapshot, retaining
  the private data through restart until restoration is durably admitted. It does
  not claim a move from a nonexistent server-side `/Trash` or invent a causal undo.
- Tree-boundary entries, creation and imports retain their existing snapshot path.
  Filesystem observations remain snapshots; matching bytes do not manufacture a
  move or copy claim.

Quagmire now exposes explicit same-document duplication evidence during the commit
callback. The Arbor adapter maps source-backed, unchanged copied blocks to exact
UTF-8 spans, including descendants whose source layout is unchanged. Copies retain
source formatting; any necessary Markdown separators are newly authored bytes.
Evidence survives debounce, deferred host callbacks, editor recovery and the
publication journal. Recovery immediately submits the retained copy generation
before new editing can coalesce away its evidence; later edits retain its accepted
ledger. Ordinary insertion/paste does not acquire copy provenance.

Swift and TypeScript patches carry `copies` separately from preservation lineage.
The queue excludes ordered preserved spans from the authored edit footprint.
A simple duplicate insertion emits `copySource` directly. For mixed replacements,
it constructs the exact replacement and then replaces each copied span with
`copySource` material, removing its temporary authored counterpart through an
operation-result reference. This uses existing authoritative Wire operations;
it neither reuses an original occurrence nor leaves duplicated placeholder text in
the candidate. A copied occurrence has independent provenance. Plain-text concurrent source
edits merge independently; the deployed Markdown structural rule may instead
retain both branches for review when copying changes host structure. Shared fixtures cover repeated copies, Unicode/CRLF and invalid claims; live
editor tests cover draft loss, restart and actual Canopy publication.

This capture does not yet describe copies of newly authored or transformed source
without a matching basis span, cross-document copies, or causal undo/redo. These
need richer transaction capture rather than guesses from matching bytes. The
Quagmire API addition and Arbor adapter are tested through the local override;
release/pin status must be checked before installation. Remaining work stays in [Reliability 008](../plans/reliability/008-enable-source-operations.md).
Native review UI remains [Reliability 010](../plans/reliability/010-client-conflict-review.md).

Verification includes shared preservation fixtures, equal-byte editor admission,
queue restart, compound sibling-body move/copy/removal, shadowed source fidelity,
private Trash restoration, concurrent child edits transported by a move,
copy-result editing, actual Swift/TypeScript protocol execution
against disposable Canopy, and macOS/iOS Simulator application builds. This
checkpoint is implementation evidence, not an installed-client deployment record.

Copy-capture verification: 976 product tests pass, together with the Swift/TS
protocol suite, real editor copy/recovery/continued-edit publication through a
disposable Canopy, local Mac/iOS Simulator app builds, and Quagmire's full package
and four-target build verification. One CLI reconnect test failed in an earlier
parallel run; its complete test file and a subsequent complete suite both passed.
Release and exact dependency pinning remain pending; no live service or app was
changed by this checkpoint.
