# Exact source admission queue

This is a client implementation checkpoint for the
[exact authored basis contract](../spec/09-client-synchronization.md#exact-authored-basis).
`SourceAdmissionQueue` exists in `ArborWorkingTree` and `@arbor/canopy-client`.
The Swift queue is connected to document acknowledgement, recovery and publication
behind `UpdateCoordinator.sourceOperationEmission` (default `false`). Native passes
its coordinator to the provider, which selects this path only when explicitly enabled.
Installed clients still use the existing head/attempt/rejection path. The TS queue
currently prepares durable requests; it has no working-tree session/publication runner yet.
This checkpoint does not enable emission in installed clients or migrate legacy work.

## Retained records and enforced policy

Each immutable record carries a client-generated change identity, tree scope,
exact source basis and guarded edits, a sparse basis graph, and the generated
candidate and `editSource` operations. The queue builds the candidate by replacing
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
a record. This first builder replaces existing file sources; missing directory
bodies, generated projections and structural changes need their own execution forms.

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
assets are disabled in the source provider prototype until they share the durable
admission path. These are implementation staging limits, not Wire restrictions.

The editor bridge checks the session policy when restoring an unsaved draft. A
retained-basis session receives the original basis and guarded patch even when its
current projection differs or has equal resulting bytes. Legacy providers retain
their existing recovery review. No accepted-conflict decision is owned by the bridge.

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
Publication integration tests currently use a controlled transport; the complete
real-server/editor/second-client scenario remains a release gate.

Verification for this checkpoint: `bun run typecheck`, `bun run test`,
`bun run test:protocol`, the full `ArborWorkingTree` Swift suite,
`tools/test-arbor-quagmire-local.sh`, and a macOS `Arbor` build using the local
workspace passed. Repository-wide relative-link/fragment checks introduced no
new failures; existing broken links remain outside this change. No installed app
or server was upgraded.

Remaining work in [008](../plans/reliability/008-enable-source-operations.md):

- Build the TS working-tree session/publication consumer with the same policies.
- Integrate structural writes and other source forms, then exercise real Canopy
  acceptance and resolution through a second client.
- Add safe coalescing and bounded reclamation of settled ancestry and captured views.
- Enable emission only after Canopy's deployed acceptance covers the emitted forms;
  preserve legacy conflicts until they have been settled or safely transferred.
