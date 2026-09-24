# Working-tree updates
*Part of the [Overstory spec](README.md): how a client that owns a working tree turns its local changes into accepted updates and applies accepted results. Overstory request identity, plural update strings, and watching are defined by [tree operations](01-tree-operations.md); this chapter defines the one client state machine that uses them safely.*

*Owns: the update machine, local changes and the change log, the machine's states, retained durable data, entries, and transitions. References: [tree operations §2–3](01-tree-operations.md) for the request and watch contracts, [source intent](10-source-intent.md) for traces and operations. Reference timing values are not part of Overstory compatibility.*

## 1. Scope and conformance

A **working tree** is what a client edits: the node index of one tree, the
local objects it has produced, a durable **change log** of the local changes
it has not yet seen accepted, and the **update machine** that publishes them.
The daemon's placed folder is a working tree whose object store is the
folder; the native working tree is one whose object store is a layered
overlay in front of a platform store. Both talk to Overstory directly.

There is one machine. An editor that captures authored intent and a folder
that captures only bytes feed it the same way: each appends local changes to
the change log, and the machine decides when and how the log is published.
Nothing between an editor and its working tree is a second synchronization
machine.

Overstory permits a client to post progressively longer append-only strings
while earlier requests are in flight
([tree operations §2.1](01-tree-operations.md#21-the-update-request)). That
permission exists for recovery. A conforming client uses it only in the
transitions named below and otherwise keeps at most one ordinary request in
flight per tree.

The shared fixture
[`conformance/client-state-machines.json`](conformance/client-state-machines.json)
freezes the transition scenarios under `working-tree-updates`. See the
[implementation guide](../implementing-sync-services/update-machine.md) for
the reference reducers, the runner, its storage, and timing choices.

Every state below is durable: a client restarted in any of them resumes
without changing the semantic identity of any request that may have reached
the host.

## 2. Local changes and the change log

A **local change** is one durable authored record:

- its authored identity (`change`);
- its basis: either an accepted `{ root, update }` or the authored identity
  of the local change it was made on;
- its candidate root and the objects the candidate introduces over its basis;
- its `trace` (a frame chain, or `null` for snapshot semantics) and
  `resolves`, exactly as the wire element will carry them
  ([source intent](10-source-intent.md)).

An editor generation carries one frame. A folder scan carries `trace: null`.
A structural action carries its entry operations or an explicitly chosen
snapshot, and a review resolution carries `resolves`. The wire element of a
local change is immutable once the change is durable: every request that
includes it repeats the same element with the same digest. Records keep
hashes and the wire element, never document sources or editor transactions.

The **change log** is the ordered, durable set of local changes for one tree.
A change is durable in the log, together with its basis and the objects it
introduces, before the machine learns of it and before any editor or scan
treats it as saved. The log's newest change is its **tip**. A change is
**settled** once an accepted update incorporates it; a client MAY then
discard it once no unsettled change and no open editor still names it as a
basis.

## 3. The update machine

### 3.1 States

| State | Durable data | Meaning |
|---|---|---|
| `current` | confirmed `{ root, update, cursor }` | Every local change is settled. |
| `locally-pending` | confirmed base plus the change log through its tip | Local changes exist but are not part of any possibly transmitted request. |
| `prepared` | one exact request from the base through a tip, its element digests, **and every object envelope the request carries** | The request is durable, self-contained, before its first network attempt. |
| `submitting` | the same immutable request record | The outcome may become ambiguous; the request is never mutated or replaced. |
| `submitting-pending` | the immutable request record plus a later tip | Later local changes wait as one successor, not another request. |
| `accepted-pending-apply` | the validated authority result, any later tip | The decision is known; the accepted graph is not yet durably applied. |
| `offline` | one of the pending or prepared shapes, whether the request was transmitted, a classified availability failure | Retry resumes from durable state without changing identity. |
| `held` | the rejected or unsupported request, its reason, any later tip | The host definitively refused the request; its chain stops publishing until an explicit action. |
| `terminal` | a diagnostic and the retained files | A validation or programming invariant failed; automatic mutation stops. |

An implementation also carries an `unplaced` pre-state before a snapshot is
installed and the current transport availability.

### 3.2 Entry

There is one normal entry into the machine.

**Installation.** The entry into `current` is the installation of one
validated accepted snapshot with its `{ root, update, cursor }`. A complete
snapshot qualifies. So does a **sparse install**: a validated spine, every
directory and Markdown object present and hash-checked, whose absent hashes
are files the client can resolve on demand through an object store and whose
sizes and media types the bootstrap names. A spine that omits a directory
object is not sparse, it is incomplete, and must fail installation loudly. A
preview, a partial download, or a fetched descriptor cannot enter the machine.
If the host advanced while the snapshot downloaded, the client begins
ordinary catch-up from the installed cursor rather than restarting placement.

When an intermediary supplies that installation, its snapshot **must** be
rooted at the accepted authority root. It must not substitute another working
tree's change log, pending request, held request, or availability state. Each
working tree enters `current` independently and owns only the changes and
exact requests authored after its installation. Shared credentials make
concurrent requests reconcilable at the host; they do not merge client state
or let one client's local condition gate another client's publication.

**Restart.** A client restarted with a retained request re-enters the
machine from `current` with that request: a held request is held again, and
any other is resubmitted exactly, or treated as possibly transmitted while
transport is unavailable. Unsettled local changes behind it are then its tip.

### 3.3 Transitions

1. **Local changes are durable before publication.** A local change becomes
   durable in the change log independently of the network, **together with
   the objects it introduces over its basis**, before the machine learns of
   it. A process that stops before publication recovers the change from the
   log. The machine then arms a trailing publication delay and a maximum
   delay from the first unsent change. Explicit synchronization, shutdown
   drain, reconnection, and a watch event under pending work bypass the
   delay.
2. **Every working tree is a source.** A change observed from disk, from an
   editor, or from an explicit local operation is authored work; the log
   keeps its provenance but the machine treats it the same way. A change
   with a trace carries its authored intent; a change without one asserts
   only its bytes. There is no mode in which disk mirrors another client's
   work.
3. **One request is the log's chain, prepared exactly.** When the delay
   elapses the client persists one exact request: the chain of local changes
   from the accepted basis of its oldest unsettled change through the tip,
   in log order, each as its immutable wire element. A settled change still
   named as a basis is repeated without its objects or deltas, so the host
   trims it by request digest. A request's base, change IDs, traces,
   matching policies, candidates, derived digests, **and the object
   envelopes it carries** are one immutable record from the first attempt
   onward. Resubmission reads only that record, never a live object store:
   collecting the working tree's overlay between attempts must not change
   what is resent. A candidate carries only the objects its base does not
   retain; a file an accepted root already reaches is never packed.
4. **One successor.** Local changes during `prepared`, `submitting`, or
   `accepted-pending-apply` advance one retained tip. The client does not
   send a longer request because another change arrived. After the result
   is durably applied, it publishes the chain through the tip against the
   new base without waiting for the trailing delay. Because every change
   names its authored basis, the successor's request repeats the settled
   prefix exactly and appends the new changes once; the host trims the
   accepted prefix by request digest and reconciles only the new transition.
5. **Racing evidence.** The response and the matching watch event are
   evidence for the same request. The client correlates by request digest
   and accepted identity, applies whichever arrives first, and ignores the
   duplicate receipt. Observation cursors deduplicate stream frames; they are
   not accepted IDs and cannot alone prove that a particular request was
   accepted.
6. **Validate before advancing.** Every returned object, root, transition
   chain, tree boundary, and request digest is rehashed and validated. The
   confirmed `{ root, update, cursor }` advances only after durable
   materialization succeeds; a restart in `accepted-pending-apply` completes
   the same apply idempotently.
7. **Clean catch-up.** A watch event in `current` applies a contiguous
   transport transition batch (including a net transition spanning
   intermediate accepted updates) in memory and materializes its final state
   once, or pulls the current snapshot when the batch does not chain. A watch
   event under pending work triggers publication and never overwrites local
   changes. A client that polls for freshness treats a poll as an
   authoritative catch-up boundary when clean and as a publication boundary
   under pending work.
8. **Accepted ambiguity is ordinary acceptance; rejection is held.** Ordinary
   valid concurrent edits are reconciled or retained as accepted ambiguity by
   the host. A stale basis alone does not enter a client-owned conflict
   workflow. For an accepted update with `conflicted: true`, apply its
   projection, retain its accepted identity and unresolved signal, and
   continue ordinary publication. Equal-root transitions still advance
   accepted identity and observation progress. Inspect and resolve accepted
   decisions through the [source operation contract](10-source-intent.md).
   A definitively rejected request (a conflict the host will not reconcile,
   or any other refusal that repeating the request cannot change) enters
   `held`: it remains durable with its
   original basis, exact elements and any completed-prefix evidence, and
   later changes authored on it wait with it. Rejection does not implicitly
   rebase, resolve, discard or turn unattempted work into a private merge
   workspace. Leaving `held` is an explicit action: discarding the held chain
   (which catches up to the host's current state) or replacing it with fresh
   work. A stale explicit-resolution guard requires refreshed inspection
   while keeping the draft.
9. **Availability is distinct from validity.** Transport failure enters
   `offline` and retries automatically when transport returns or, in a
   client that polls, on the next poll while the network is believed
   available. Authentication failure and revocation enter `offline` with an
   authentication reason and resume only after credentials are refreshed. An
   operation the host does not support enters `held` with reason
   `unsupported`; it requires an upgrade or explicit author action.
   Validation failure is `terminal`.
10. **Ambiguous recovery.** On reconnection, a request that may have reached
    the host is retried exactly. If newer local changes exist behind it, the
    client persists one longer request that repeats the transmitted prefix
    exactly and appends the chain through the tip once. Together with the
    successor handoff in rule 4, these are the only transitions that issue a
    longer append-only string; all rely on the host trimming the already
    accepted prefix by request digest.
11. **A persisted request is transmitted as persisted.** The runner sends
    exactly the elements the persisted request names. A change appended
    after preparation is the retained successor, never a longer version of
    the request in flight. If the change log no longer holds the persisted
    request's chain, for example because a settled prefix was retired between
    preparation and transmission, the runner neither transmits a different
    request nor drops the effect silently: it re-enters the machine from
    durable state exactly as a restart would and publishes what remains. A
    tip whose root equals the accepted base needs no request: the client
    **settles** the chain through it locally so that later changes are not
    blocked.
12. **A re-seeded working tree never re-submits its seed.** When an accepted
    result arrives for a request whose candidate the working tree no longer
    holds and the tree has no local changes of its own (its state was rebuilt
    from the host while the durable request carried the work), the client
    applies the decision, discards the request, and catches up to the host's
    current state instead of preparing a new request from the seed.
13. **One materialization rule.** An applied result becomes the accepted
    base at once. What the working tree presents is the tip's candidate while
    local changes are unsettled, and the accepted root otherwise. A working
    tree whose store cannot be overwritten without losing newer bytes, such
    as a folder, materializes accepted bytes only when its change log is
    settled and its store still equals the tip; otherwise it first records
    the newer bytes as a local change.

## 4. Local changes from editors

An editor is a source like any other: it appends each generation to its
working tree's change log and acknowledges the generation once the change is
durable. A successful append acknowledges durable authored intent, not
acceptance by the host and not agreement with the current projected document.
The reference editor source is described in
[editor sources](../implementing-editors/editor-source.md).

### Exact authored basis

- A local change MUST preserve the exact source basis, its revision, guarded
  edits, resulting source, and document/tree scope. Before publication, the
  client MUST bind this local basis to its retained accepted identity or
  preceding authored change, including the objects needed to express and
  recover that candidate. A content revision or equal source bytes alone
  cannot establish accepted identity.
- If the editor authored against R1 and a watch installs R2 before the change
  is appended, the client MUST retain the R1-based edit. It MUST NOT
  substitute R2 as the basis, replay the edit against R2 merely because its
  byte guards happen to match, or require a local compare-and-swap conflict
  resolution. The host reconciles the original intent and preserves genuine
  overlap as accepted state.
- Appending MUST validate that the edits applied to the captured basis
  produce the declared candidate exactly, frame by frame: the operations a
  client states for one generation MUST reproduce the root that generation
  produced. Local failure is reserved for inability to retain the edit
  durably or express it validly, including unavailable basis material,
  invalid scope, invalid guards, or a read-only document. Network
  availability and a newer accepted projection do not invalidate a change.
- Acknowledgement MUST wait until the basis, intent, candidate and
  publication dependency are recoverable after process loss. The change log
  is that recovery record; an editor-only recovery copy is not a substitute
  for it. The editor continues to read its latest appended change while the
  log retains later edits independently of incoming projections.
- Coalescing MUST preserve causal meaning and the correct basis. Requests
  already attempted remain immutable. A successor authored against a
  submitted candidate MUST retain that dependency, including when the host
  projects a peer alternative. A request that covers several editor
  generations MUST carry one frame per generation, in authored order, rather
  than re-deriving a single claim against the oldest basis. Frames are
  concatenated, never rebased: each frame's references name material in its
  own `before` tree, and operation keys stay unique across the whole trace. A
  client MAY merge adjacent frames only when it can prove the merged frame
  reproduces the same result.
- Restart MUST recover the original basis and pending intent from the change
  log. A newer projection does not turn recovery into a request for local
  merge review. Unknown submission outcomes require exact retry; equality
  with projected bytes is not proof that semantic work was accepted.
- An editor MUST NOT turn a stale-revision response into local merge review
  or acknowledgement based on equal projected bytes. Disk editors for folders
  that are not working trees have no change log and may keep a separate
  compare-and-swap write; that policy MUST NOT leak into host publication.

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
Restart recovery and publication retries MUST retain these claims unchanged.
Clients MUST emit operation kinds only after the destination supports their
execution; an authoritative operation cannot be recorded as an unvalidated hint.

Undo and redo are ordinary source edits. A client MUST NOT assert operation
inversion for an editor undo; it captures the resulting source edit against its
current basis exactly as it captures any other edit. The editor's own undo stack
is client state and is not retained by the synchronization client. Restoring old
bytes is not a causal claim and needs none.

A client MAY discard a settled local change as soon as no unsettled change
depends on it. Discarding MUST preserve any authored basis still exposed to an
open editor until the accepted projection has been installed.

A compound editor action MAY include source edits and structural effects. A
page-creation record retains the branch it introduced and proves that removing
it restores the pre-creation graph, so the record reproduces its original basis;
this is a validity check on the record, not an undo claim. Undoing such an
action in the editor is a source edit like any other and does not remove the
created page. Concurrent changes remain subject to host reconciliation.

A historical inverse candidate describes its authored basis, not necessarily the
current projection. Clients MUST NOT install it as the host's reconciled state.
They MAY await host reconciliation before exposing a successor basis that they
cannot otherwise validly express. Waiting for that basis MUST NOT discard the
durably retained inverse, change its targets, or pause other queued publication.

### Structural changes and mixed generations

Durable acknowledgement applies to structural actions, imports and assets as well
as document edits. A client MUST retain their candidate and exact publication
dependency before reporting success. When a client represents an action as a
snapshot, it MUST choose that form explicitly; it MUST NOT fabricate source
material or operation provenance. A later source edit may depend on that retained
snapshot, and a structural snapshot may depend on a retained source candidate.
Neither kind of successor may be silently rebound to an incoming projection.

Clients need not implement a local merge engine. When pending authored branches
cannot be presented as one coherent candidate, a client MAY temporarily make
structural actions, imports and asset creation unavailable until the host reconciles
them. It MUST report that limitation before acknowledging another such action,
and MUST continue to retain valid document intent from already-open editors against
its original basis. This restriction MUST NOT pause publication of retained work.
The client MUST NOT treat the latest authored candidate as a complete local tree
when that would hide other acknowledged local work.

Client reads MUST make acknowledged local creations and relocations available
while their publication is pending. Private recovery material, such as local
trash omitted from the shared tree, MUST remain recoverable across process loss;
a shared deletion snapshot alone is not sufficient to promise local restoration.

### Accepted-state review

An accepted conflict-bearing receipt follows the ordinary accepted-update path:
validate and durably install its projection and identity, then continue publication.
Clients obtain conflict decisions through the host's tree inspection operations.
Accepted decisions are tree state, not private to the submitting client. An
unavailable inspection request MUST NOT block normal synchronization.

Resolution is an ordinary guarded local change naming accepted decisions in
`resolves`, appended to the change log like any other. A stale resolution guard
requires refreshed evidence while retaining the person's draft; it does not
require a client-owned merge engine or recreation of rejected-update
workspaces. Other validation and authorization failures remain recoverable errors.

An unexpected old durable record MUST be detected before decoding or rewriting
can discard its recovery data. Refusing to open that record with a recovery
diagnostic is permitted; silently treating it as an empty current record is not.

## 5. Accepted conflicts and held local work

The host owns conflict attribution, alternative preservation and resolution.
Clients retain their accepted basis and deliver authored changes; they are not
required to infer conflict meaning or implement merge rules. An accepted unresolved
update is accepted work, not a locally held rejection. Hidden alternatives belong to
the host's accepted state and do not require a client-side review cache.

In this section, held work means the local changes of a `held` request and the
changes authored on them. It does not mean the alternatives of an accepted
unresolved decision.

A conflict MUST NOT by itself pause capture of local changes or all synchronization
for a tree. Accepted unresolved state continues ordinary updates. After a definitive
rejection, clients MUST keep the rejected candidate and unattempted suffix durable
in `held` while allowing provably independent work to proceed. Uncertain transport outcomes
must first use the existing exact-retry/receipt procedure; uncertainty is not
permission to abandon or rewrite a possibly accepted request.

This does not change the protocol's sequential prefix semantics. The client retains the
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
The host establishes whether a snapshot edit continues a displayed alternative.
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
