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
| `conflict` | the complete validated conflict, exact prepared request, successful-prefix boundary, failed element, unattempted suffix, and any later head | Client-owned and restart-safe; the authority stores no rejected history. The final local root does not replace the retained element boundaries. |
| `offline` | one of the pending or prepared shapes, whether the request was transmitted, a classified availability failure | Retry resumes from durable state without changing identity. |
| `terminal` | a diagnostic and the retained files | A validation or programming invariant failed; automatic mutation stops. |

An implementation also carries an `unplaced` pre-state before a snapshot is
installed and the current transport availability.

### 2.2 Entry

There are two entries into the machine. Both are normative.

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

**Adoption.** A client on the same installation, under the same credential,
may enter `prepared` directly by adopting another working tree's persisted
request verbatim: the same base, the same elements in the same order, the
same matching policies. The adopter recomputes every element digest and must
find them equal to the digests the author persisted; a mismatch refuses the
adoption. Digests exclude object envelopes, so the adopter may pack the
objects the elements need differently from the author. The adopted request is
the adopter's own immutable record from then on; its elements form an
**adopted prefix** the adopter did not author. Adoption is refused while the
adopter already retains a request or a conflict.

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
   request's base, elements, matching policies, candidates, derived digests,
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
   and by accepted update or cursor, applies whichever arrives first, and
   ignores the other.
6. **Validate before advancing.** Every returned object, root, transition
   chain, tree boundary, and request digest is rehashed and validated. The
   confirmed `{ root, update, cursor }` advances only after durable
   materialization succeeds; a restart in `accepted-pending-apply` completes
   the same apply idempotently.
7. **Clean catch-up.** A watch event in `current` applies a contiguous
   transition batch in memory and materializes its final state once, or
   pulls the current snapshot when the batch does not chain. A watch event
   under pending work triggers publication and never overwrites the head.
8. **Conflict is sequential and owned by its author.** A conflict stops at
   the first failed element. The machine retains the returned successful
   prefix, the failed element at `failedIndex`, and every unattempted suffix
   element from the exact prepared request. It reviews only the failed element
   against the verified current state. Once the reviewed element is durably
   submitted and applied, the machine replays the retained suffix changes in
   order. A replay applies the exact local change between adjacent original
   candidates to the newly accepted state; if its guards no longer match, that
   element becomes the next client-owned conflict before submission. The
   machine must not collapse the failed element and suffix into the final
   local root, submit an old suffix candidate against a different logical
   base, or describe unattempted work as conflicted. Further local work
   remains one successor behind the sequence. **A failed element that lies
   within an adopted prefix is owned by the working tree that authored it**:
   the adopter holds (submission paused, the request and any head kept
   durable, status reported as conflict with the reason) and defers to the
   author's review flow rather than reviewing the element itself.
9. **Availability is distinct from validity.** Transport failure enters
   `offline` and retries automatically when transport returns.
   Authentication failure and revocation enter `offline` with an
   authentication reason and resume only after credentials are refreshed.
   Validation failure is `terminal`.
10. **Ambiguous recovery.** On reconnection, a request that may have reached
    the authority is retried exactly. If newer durable heads exist behind
    it, the client persists one longer request that repeats the transmitted
    prefix exactly and appends the latest head once. An adopted prefix is
    treated the same way: it is retried exactly, and an offline head behind it
    is appended to it once. Together with the merged-result handoff in
    rule 4, these are the only transitions that issue a longer
    append-only string; all rely on the authority trimming the already
    accepted prefix by request digest, which is also what lets an adopted
    request that its author has meanwhile submitted resolve as a replay.
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

An editor runs the document admission machine described in
[client state machines](../docs/client-state-machines.md) against its own
working tree. A successful admission is working-tree durability, not accepted
history: the working tree holds the admitted bytes as its local head, and the
update machine described here publishes durable heads as requests and
materializes only accepted state. Nothing edits through another client; the
daemon's folder is itself a working tree whose object store is the folder.
The two machines compose in sequence, admission first and publication second,
and must not be merged into one coordinator.
