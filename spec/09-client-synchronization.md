# Working-tree updates
*Part of the [Arbor spec](../spec.md): how a client that owns a working tree turns its local heads into accepted updates and applies accepted results. Wire request identity, plural update strings, and watching are defined by [tree operations](01-tree-operations.md); this chapter defines the client state machine that uses them safely.*

*Owns: the update machine, its states, retained durable data, entries, and transitions. References: [tree operations §2–3](01-tree-operations.md) for the request and watch contracts. Reference timing values are not part of Wire compatibility.*

## 1. Scope and conformance

A **working tree** is what an editor edits: the node index of one tree, the
local objects it has produced, and the machine that turns its heads into
accepted updates. The daemon's placed folder is a working tree whose object
store is the folder; the native working tree is one whose object store is a
layered overlay in front of a platform store. Both talk to Arbor Wire
directly. Arbor Wire permits a client to post progressively longer append-only
strings while earlier requests are in flight
([tree operations §2.1](01-tree-operations.md#21-the-update-request)). That
permission exists for recovery. A conforming client uses it only in the
transitions named below and otherwise keeps at most one ordinary request in
flight per tree.

The shared fixture
[`conformance/client-state-machines.json`](../conformance/client-state-machines.json)
freezes the transition scenarios under `working-tree-updates`. The reference
reducers are `UpdateMachine` in `ArborWorkingTree` (Swift, run by
`UpdateCoordinator`) and `reduceUpdate` in `@arbor/canopy-client` (TypeScript,
run by the daemon's `TreeSynchronizer`; it moves to `@arbor/working-tree` in
Plan B).

Every state below is durable: a client restarted in any of them resumes
without changing the semantic identity of any request that may have reached
the authority.

## 2. The update machine

### 2.1 States

| State | Durable data | Meaning |
|---|---|---|
| `current` | confirmed `{ root, update, cursor }` | Local state equals the last applied accepted root. |
| `locally-pending` | confirmed base plus the latest durable local head **together with the objects the head introduces over that base** | Local work exists but is not part of any possibly transmitted request. Intermediate generations may be compacted; the head's objects are durable with it. |
| `prepared` | one exact request from the base to the latest head, its element digests, **and every object envelope the request carries** | The request is durable, self-contained, before its first network attempt. |
| `submitting` | the same immutable request record | The outcome may become ambiguous; the request is never mutated or replaced. |
| `submitting-pending` | the immutable request record plus one latest durable head with its objects | Later local work is a replaceable successor, not another request. |
| `accepted-pending-apply` | the validated authority result, any later head | The decision is known; the accepted graph is not yet durably applied. |
| `offline` | one of the pending or prepared shapes, whether the request was transmitted, a classified availability failure | Retry resumes from durable state without changing identity. |
| `terminal` | a diagnostic and the retained files | A validation or programming invariant failed; automatic mutation stops. |

An implementation also carries an `unplaced` pre-state before a snapshot is
installed and the current transport availability.

### 2.2 Entry

There is one normal entry into the machine.

**Installation.** The entry into `current` is the installation of one
validated accepted snapshot with its `{ root, update, cursor }`. A complete
snapshot qualifies. So does a **sparse install**: a validated spine, every
directory and Markdown object present and hash-checked, whose absent hashes
are files the client can resolve on demand through an object store and whose
sizes and media types the bootstrap names. A spine that omits a directory
object is not sparse, it is incomplete, and must fail installation loudly. A
preview, a partial download, or a fetched descriptor cannot enter the machine.
If the authority advanced while the snapshot downloaded, the client begins
ordinary catch-up from the installed cursor rather than restarting placement.

When an intermediary supplies that installation, its snapshot **must** be
rooted at the accepted authority root. It must not substitute another working
tree's mutable head, pending request, conflict, or availability state. Each
working tree enters `current` independently and owns only the heads and exact
requests authored after its installation. Shared credentials make concurrent
requests reconcilable at the authority; they do not merge client state or let
one client's local condition gate another client's publication.

### 2.3 Transitions

1. **Local work is durable before publication.** A local head becomes durable
   in the working tree independently of the network, **together with the
   objects it introduces over the accepted base**, before the machine learns
   of it. A process that stops before publication recovers the head as one
   exact request. The machine then arms a trailing publication delay and a
   maximum delay from the first unsent head (reference values 250 ms and 1 s).
   Explicit synchronization, shutdown drain, reconnection, and a watch event
   under pending work bypass the delay.
2. **Every working tree is a source.** A head observed from disk, from an
   editor, or from an explicit local operation is authored intent; the
   machine keeps its provenance but treats it the same way. There is no mode
   in which disk mirrors another client's work.
3. **One request, prepared exactly.** When the delay elapses the client
   persists one exact request from the applied base to the latest head,
   collapsing every unsent intermediate generation, then transmits it. A
   request's base, change IDs, operations, matching policies, candidates, derived digests,
   **and the object envelopes it carries** are one immutable record from the
   first attempt onward. Resubmission reads only that record, never a live
   object store: collecting the working tree's overlay between attempts must
   not change what is resent. A candidate carries only the objects its base
   does not retain; a file an accepted root already reaches is never packed.
4. **One successor.** Local work during `prepared`, `submitting`, or
   `accepted-pending-apply` replaces one successor head. The client does not
   send a longer prefix because another edit arrived. After the result is
   durably applied, it publishes the successor against the new base without
   waiting for the trailing delay. If a successor the working tree cannot
   overwrite (a folder working tree whose newer bytes were authored on disk)
   prevents materializing a merged result without overwriting newer durable
   bytes, the client instead persists one longer string: it repeats the
   transmitted prefix exactly and appends the successor once. The authority trims the
   accepted prefix by request digest and reconciles only the new transition.
5. **Racing evidence.** The response and the matching watch event are
   evidence for the same request. The client correlates by request digest
   and accepted identity, applies whichever arrives first, and ignores the duplicate
   receipt. Observation cursors deduplicate stream frames; they are not accepted
   IDs and cannot alone prove that a particular request was accepted.
6. **Validate before advancing.** Every returned object, root, transition
   chain, tree boundary, and request digest is rehashed and validated. The
   confirmed `{ root, update, cursor }` advances only after durable
   materialization succeeds; a restart in `accepted-pending-apply` completes
   the same apply idempotently.
7. **Clean catch-up.** A watch event in `current` applies a contiguous
   transport transition batch (including a net transition spanning intermediate
   accepted updates) in memory and materializes its final state once, or
   pulls the current snapshot when the batch does not chain. A watch event
   under pending work triggers publication and never overwrites the head.
8. **Accepted ambiguity is ordinary acceptance.** Ordinary valid concurrent
   edits are reconciled or retained as accepted ambiguity by Canopy. A stale
   basis alone does not enter a client-owned conflict workflow. For an accepted
   update with `conflicted: true`, apply its projection, retain its accepted
   identity and unresolved signal, and continue ordinary publication. Equal-root
   transitions still advance accepted identity and observation progress. Inspect
   and resolve accepted decisions through the [source operation contract](10-source-intent.md).
   A rejected request remains durable with its original basis, exact elements
   and any completed-prefix evidence. Rejection does not implicitly rebase,
   resolve, discard or turn unattempted work into a private merge workspace.
   A stale explicit-resolution guard requires refreshed inspection while keeping
   the draft. Unsupported operations require an upgrade or explicit author action.
   Compatibility recovery for old rejected updates is separate from this machine.
9. **Availability is distinct from validity.** Transport failure enters
   `offline` and retries automatically when transport returns.
   Authentication failure and revocation enter `offline` with an
   authentication reason and resume only after credentials are refreshed.
   Validation failure is `terminal`.
10. **Ambiguous recovery.** On reconnection, a request that may have reached
    the authority is retried exactly. If newer durable heads exist behind
    it, the client persists one longer request that repeats the transmitted
    prefix exactly and appends the latest head once. Together with the
    merged-result handoff in rule 4, these are the only transitions that issue a longer
    append-only string; all rely on the authority trimming the already
    accepted prefix by request digest.
11. **A persisted request is transmitted as persisted.** The runner sends
    exactly the elements the persisted request names. A generation admitted
    after preparation is the retained successor, never a longer version of
    the request in flight. If the durable chain no longer begins with the
    persisted request, for example because an acknowledged prefix was retired
    between preparation and transmission, the runner neither transmits a
    different request nor drops the effect silently: it re-enters the machine
    from durable state exactly as a restart would and publishes what remains.
    A durable generation whose head equals the accepted base needs no
    request; a runner that records per-generation acknowledgements
    acknowledges such a generation locally so that the generations behind it
    are not blocked.
12. **A re-seeded working tree never re-submits its seed.** When an accepted
    result arrives for a request whose candidate the working tree no longer
    holds and the tree has no pending work of its own (its state was rebuilt
    from the authority while the durable request or head carried the work),
    the client applies the decision, discards the request and next base, and
    catches up to the authority's current state instead of preparing a new
    request from the seed.

### 2.4 Non-normative timing

The reference delays coalesce interactive bursts without visible latency and
are configurable per client. Changing them requires request-count evidence
and matching test updates; they are not Wire compatibility values.

## 3. Relationship to editor admission

An editor runs a document admission machine against its own working tree. A
successful admission acknowledges durable authored intent, not acceptance by
Canopy and not agreement with the current projected document. The admission and
publication machines remain separate. The reference reducers are described in
[client state machines](../docs/client-state-machines.md).

### Exact authored basis

- An admission MUST preserve the exact source basis, its revision, guarded edits,
  resulting source, and document/tree scope. Before publication, the client MUST
  bind this local basis to its retained accepted identity or preceding authored
  candidate, including the objects needed to express and recover that candidate.
  A content revision or equal source bytes alone cannot establish accepted identity.
- If the editor authored against R1 and a watch installs R2 before admission, the
  client MUST retain the R1-based edit. It MUST NOT substitute R2 as the basis,
  replay the edit against R2 merely because its byte guards happen to match, or
  require a local compare-and-swap conflict resolution. Canopy reconciles the
  original intent and preserves genuine overlap as accepted state.
- Admission MUST validate that the edits applied to the captured basis produce
  the declared candidate exactly, frame by frame: the operations a client states
  for one generation MUST reproduce the root that generation produced. Local failure is reserved for inability to
  retain the edit durably or express it validly, including unavailable basis
  material, invalid scope, invalid guards, or a read-only document. Network
  availability and a newer accepted projection do not invalidate admission.
- Acknowledgement MUST wait until the basis, intent, candidate and publication
  dependency are recoverable after process loss. An editor-only recovery copy
  is not a substitute for a durable publication queue. The editor continues to
  read its admitted generation while the queue retains later edits independently
  of incoming projections.
- Coalescing MUST preserve causal meaning and the correct basis. Requests already
  attempted remain immutable. A successor authored against a submitted candidate
  MUST retain that dependency, including when Canopy projects a peer alternative.
  A client that coalesces several editor generations into one change MUST emit
  one frame per generation, in authored order, rather than re-deriving a single
  claim against the oldest basis. Frames are concatenated, never rebased: each
  frame's references name material in its own `before` tree, and operation keys
  stay unique across the whole trace. A client MAY merge adjacent frames only
  when it can prove the merged frame reproduces the same result.
- Restart MUST recover the original basis and pending intent. A newer projection
  does not turn recovery into a request for local merge review. Unknown submission
  outcomes require exact retry; equality with projected bytes is not proof that
  semantic work was accepted.
- An intent-retaining document session MUST NOT turn a stale-revision response
  into local merge review or acknowledgement based on equal projected bytes. If
  its provider unexpectedly requires compare-and-swap resolution, retain the
  original basis and pending edits and report an admission failure. Legacy or
  disk-only sessions may retain their separate compare-and-swap policy during
  compatibility; that policy MUST NOT leak into Canopy intent admission.

### Captured operations and preserved source

A client that captures an explicit move, copy, or preservation claim MUST retain
that claim with the exact authored basis and candidate before acknowledging it.
Preservation lineage MUST select scalar-aligned UTF-8 ranges with identical bytes,
without duplicating a source occurrence. Copying material is distinct from
preserving it. A captured source-copy span MAY reuse the same source occurrence
more than once, but each destination span MUST be distinct, scalar-aligned and
byte-identical to the observed source. It MUST NOT also claim that destination as
preserved lineage. A client MUST derive copy intent from an explicit authoring
action, never from equal bytes alone. Equal candidate bytes MUST NOT erase captured operation identity.
A claim MUST be stated in the frame whose basis it was captured against, so
coalescing never forces a client to re-derive lineage or copies across generations.
Editor recovery and publication retries MUST retain these claims unchanged.
Clients MUST emit operation kinds only after the destination supports their
execution; an authoritative operation cannot be recorded as an unvalidated hint.

Undo and redo are ordinary source edits. A client MUST NOT assert operation
inversion for an editor undo; it captures the resulting source edit against its
current basis exactly as it captures any other edit. The editor's own undo stack
is client state and is not retained by the synchronization client. Restoring old
bytes is not a causal claim and needs none.

A client MAY discard a retained admission record as soon as its change is
accepted and no pending admission depends on it. Records MUST NOT retain
document sources or editor transactions; they retain hashes, the wire element,
and enough of the capture to serve a document's hidden candidate and recognize
an exact retry. Discarding MUST preserve any authored basis still exposed to an
open editor until the accepted projection has been installed.

A compound editor action MAY include source edits and structural effects. A
page-creation record retains the branch it introduced and proves that removing
it restores the pre-creation graph, so the record reproduces its original basis;
this is a validity check on the record, not an undo claim. Undoing such an
action in the editor is a source edit like any other and does not remove the
created page. Concurrent changes remain subject to Canopy reconciliation.

A historical inverse candidate describes its authored basis, not necessarily the
current projection. Clients MUST NOT install it as Canopy's reconciled state.
They MAY await Canopy reconciliation before exposing a successor basis that they
cannot otherwise validly express. Waiting for that basis MUST NOT discard the
durably retained inverse, change its targets, or pause other queued publication.

### Structural admissions and mixed generations

Durable acknowledgement applies to structural actions, imports and assets as well
as document edits. A client MUST retain their candidate and exact publication
dependency before reporting success. When a client represents an action as a
snapshot, it MUST choose that form explicitly; it MUST NOT fabricate source
material or operation provenance. A later source edit may depend on that retained
snapshot, and a structural snapshot may depend on a retained source candidate.
Neither kind of successor may be silently rebound to an incoming projection.

Clients need not implement a local merge engine. When pending authored branches
cannot be presented as one coherent candidate, a client MAY temporarily make
structural actions, imports and asset creation unavailable until Canopy reconciles
them. It MUST report that limitation before acknowledging another such action,
and MUST continue to retain valid document intent from already-open editors against
its original basis. This restriction MUST NOT pause publication of retained work.
The client MUST NOT treat the latest authored candidate as a complete local tree
when that would hide other acknowledged local work.

Client reads MUST make acknowledged local creations and relocations available
while their publication is pending. Private recovery material, such as local
trash omitted from the shared tree, MUST remain recoverable across process loss;
a shared deletion snapshot alone is not sufficient to promise local restoration.

### Accepted-state review and compatibility

An accepted conflict-bearing receipt follows the ordinary accepted-update path:
validate and durably install its projection and identity, then continue publication.
Clients obtain conflict decisions through Canopy's tree inspection operations.
Accepted decisions are tree state, not private to the submitting client. An
unavailable inspection request MUST NOT block normal synchronization.

Resolution is an ordinary guarded update naming accepted decisions. A stale
resolution guard requires refreshed evidence while retaining the person's draft;
it does not require a client-owned merge engine or recreation of rejected-update
workspaces. Other validation and authorization failures remain recoverable errors.

During the implementation transition, clients MUST preserve existing retained
local conflicts, exact rejected requests, drafts and unattempted suffixes, and
continue handling responses from the authorities they still use. Remove the legacy
review/hold machinery only after the deployed authority covers the client's emitted
forms and every legacy record has been settled or durably transferred with its
original basis and attribution. Transfer must not silently reauthor an old request
against the latest projection. This compatibility path is not part of the target
ordinary-edit workflow. After retiring it, an unexpected old durable record MUST
be detected before decoding or rewriting can discard its recovery data. Refusing
to open that record with a recovery diagnostic is permitted; silently treating it
as an empty current record is not.

## Accepted conflicts and unaccepted local work

The authority owns conflict attribution, alternative preservation and resolution.
Clients retain their accepted basis and deliver authored changes; they are not
required to infer conflict meaning or implement merge rules. An accepted unresolved
update is accepted work, not a locally held rejection. Hidden alternatives belong to
the authority's accepted state and do not require a client-side review cache.

In this section, held work means unaccepted local edits after a definitive rejection.
It does not mean the alternatives of an accepted unresolved decision.

A conflict MUST NOT by itself pause capture of local changes or all synchronization
for a tree. Accepted unresolved state continues ordinary updates. After a definitive
rejection, clients MUST keep the rejected candidate and unattempted suffix durable
while allowing provably independent work to proceed. Uncertain transport outcomes
must first use the existing exact-retry/receipt procedure; uncertainty is not
permission to abandon or rewrite a possibly accepted request.

This does not change the Wire's sequential prefix semantics. The client retains the
original request, basis, rejected and unattempted elements, and later local changes.
It may prepare a separate candidate against a verified accepted state only after
establishing that the selected local effects are independent of held work. Different
paths alone are insufficient: entry ancestry, moves, material/operation-result references,
structural/schema constraints and user transaction boundaries can introduce
relationships. A transaction MUST NOT be split if that would change its meaning.
Unproven independence remains held; the client MUST NOT guess or silently omit work.

Separately prepared work must explain its entire candidate and use fresh change and
request identity when its semantics or basis change. Original prepared requests stay
immutable. The client MUST durably record which effects were published separately,
so later review/replay of held work neither repeats them nor overwrites their results.
Dependent suffixes retain their original ordering. The independent-work procedure
grants no authority to resolve an element held by another working tree; that state
is never imported into this client. Authentication, authorization and transport failures retain
their existing constraints; this procedure is not a bypass for them.

Filesystem clients materialize ordinary projected files and keep accepted identity,
the unresolved signal, and unaccepted work in durable client state outside authored
files. They need not retain accepted alternatives or inspection evidence locally.
They MUST retain the exact accepted projection underlying each captured local change.
The authority establishes whether a snapshot edit continues a displayed alternative.
When attribution is ambiguous, it retains the ambiguity if representable within the
contract limits; otherwise it rejects the edit, which remains locally recoverable.
The client MUST NOT preemptively hold an edit solely because its basis is unresolved.
Safe edits in another region of the same file may proceed when independence is proven.
There is no requirement to lock an entire file simply because one region is ambiguous.

Remote advancement MUST preserve unaccepted local bytes and their bases before any
materialization. The client's accepted remote state and locally edited projection
must remain distinguishable. Review metadata may be fetched on demand. Offline review
and durable inspection caching are optional; any locally authored review draft and
its submission basis remain subject to ordinary local-work durability requirements.
Status MUST distinguish captured locally, accepted remotely, and unresolved versus
resolved. A locally retained rejection MUST NOT be reported as remotely backed up.
