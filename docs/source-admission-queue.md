# Exact source admission queue

This is a client implementation checkpoint for the
[exact authored basis contract](../spec/09-client-synchronization.md#exact-authored-basis).
`SourceAdmissionQueue` exists in `ArborWorkingTree` and `@arbor/canopy-client`.
It is not yet connected to editor acknowledgement or automatic publication.
Installed clients still use the existing head/attempt/rejection path. This work
neither emits new operations nor migrates or deletes existing client state.

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
until publication settlement and retention rules are connected; it is not the final
long-running storage policy and does not require packfiles.

## Request preparation

`request(through:)` follows explicit predecessors back to the accepted basis and
returns the original candidate chain. Retrying a suffix after Canopy selected a
peer alternative therefore repeats the original accepted prefix, rather than
rebasing the suffix onto the visible peer. The transport's existing immutable
attempt record still owns freezing the first attempted request. This queue does
not contact Canopy or advertise support for an operation.

## Verification and remaining integration

[Shared vectors](../conformance/source-admission-queue.json) run in Swift and TS and
compare complete request values. They cover nested source paths, exact Unicode/CRLF,
equal-root authored successors and equal-root distinct accepted bases. TS tests also
execute generated operations through Canopy's independent executor and compare
candidate roots. Both clients exercise disk failure, retry, corruption, missing
parents, reused identities and concurrent queue instances. The real Swift working
tree test captures R1, installs R2, durably retains the R1 edit, then recovers its
original request after closing the tree; R2 stays installed throughout.

Remaining work in [008](../plans/reliability/008-enable-source-operations.md):

- Carry the captured basis through real document sessions and recovery, including
  equal-source observations with different accepted identities. A byte revision
  alone is insufficient to select a capture.
- Route editor admission through this queue and provide read-your-writes over
  retained local candidates, without overwriting the newer accepted projection.
- Integrate publication, receipts, dependent edits, safe coalescing and settlement;
  retain all unpublished objects and identities when reclaiming old records.
- Enable emission only after Canopy's deployed acceptance covers the emitted forms;
  preserve legacy conflicts until they have been settled or safely transferred.
