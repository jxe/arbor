# Client synchronization
*Part of the [Arbor spec](../spec.md): how a client that owns a durable replica submits local work to a tree authority and applies accepted results. Wire request identity, plural update strings, and watching are defined by [tree operations](01-tree-operations.md); this chapter defines the client state machine that uses them safely.*

*Owns: the direct Canopy synchronization machine, its states, retained durable data, and transitions. References: [tree operations §2–3](01-tree-operations.md) for the request and watch contracts. Reference timing values are not part of Wire compatibility.*

## 1. Scope and conformance

A **direct client** holds a durable replica of one tree (Arbor Sync's placed
workspace, the native replica) and talks to Arbor Wire. Arbor Wire permits a
client to post progressively longer append-only strings while earlier requests
are in flight ([tree operations §2.1](01-tree-operations.md#21-the-update-request)).
That permission exists for recovery. A conforming direct client uses it only
in the one transition named below and otherwise keeps at most one ordinary
request in flight per tree.

The shared fixture
[`conformance/client-state-machines.json`](../conformance/client-state-machines.json)
freezes the transition scenarios under `direct-canopy-synchronization`. The
reference reducers are `reduceSync` in `@arbor/canopy-client` and
`DirectSyncMachine` in `CanopyClient`.

Every state below is durable: a client restarted in any of them resumes
without changing the semantic identity of any request that may have reached
the authority.

## 2. Direct Canopy synchronization

### 2.1 States

| State | Durable data | Meaning |
|---|---|---|
| `current` | confirmed `{ root, update, cursor }` | Local state equals the last applied accepted root. |
| `locally-pending` | confirmed base plus the latest durable local head | Local work exists but is not part of any possibly transmitted request. Intermediate generations may be compacted. |
| `prepared` | one exact request from the base to the latest head, its element digests | The request is durable before its first network attempt. |
| `submitting` | the same immutable request | The outcome may become ambiguous; the request is never mutated or replaced. |
| `submitting-pending` | the immutable request plus one latest durable head | Later local work is a replaceable successor, not another request. |
| `accepted-pending-apply` | the validated authority result, any later head | The decision is known; the accepted graph is not yet durably applied. |
| `conflict` | the complete validated conflict, the local root at conflict, any later head | Client-owned and restart-safe; the authority stores no rejected history. |
| `offline` | one of the pending or prepared shapes, whether the request was transmitted, a classified availability failure | Retry resumes from durable state without changing identity. |
| `terminal` | a diagnostic and the retained files | A validation or programming invariant failed; automatic mutation stops. |

An implementation also carries an `unplaced` pre-state before a complete
snapshot is installed, a **filesystem role** (`source` or `editor-mirror`)
where disk can be an independent source of local heads, and the current
transport availability. The role is an input, not a fourth pending state.

### 2.2 Entry

The only entry into `current` is the installation of one complete, validated
accepted snapshot with its `{ root, update, cursor }`. A preview, a partial
download, or a fetched descriptor cannot enter the machine. If the authority
advanced while that snapshot downloaded, the client begins ordinary catch-up
from the installed cursor rather than restarting placement.

### 2.3 Transitions

1. **Local work is durable before publication.** A local head becomes durable
   in the replica independently of the network. The machine then arms a
   trailing publication delay and a maximum delay from the first unsent head
   (reference values 250 ms and 1 s). Explicit synchronization, shutdown
   drain, reconnection, and a watch event under pending work bypass the delay.
2. **Filesystem role.** A head observed from disk while the role is
   `editor-mirror` creates no candidate; the client reconciles disk to the
   accepted state and may replace disk with newer accepted state only when
   disk still equals the last root it materialized. Any other divergence is
   preserved and surfaced as a workspace-revision conflict. The role stays
   `editor-mirror` while any editor admission is retained and for a bounded
   grace period after the latest basis or admission. A head from an explicit
   local API mutation keeps its provenance and is authored intent regardless
   of the role.
3. **One request, prepared exactly.** When the delay elapses the client
   persists one exact request from the applied base to the latest head,
   collapsing every unsent intermediate generation, then transmits it. A
   request's base, elements, matching policies, candidates, and derived
   digests are immutable from the first attempt onward.
4. **One successor.** Local work during `prepared`, `submitting`, or
   `accepted-pending-apply` replaces one successor head. The client does not
   send a longer prefix because another edit arrived. After the result is
   durably applied, it publishes the successor against the new base without
   waiting for the trailing delay.
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
8. **Conflict.** A conflict retains base, local, current, draft, and reasons
   durably, permits further local work, and exits only through explicit
   resolution: keeping local work becomes a new ordinary request at the
   verified current base; taking the current or draft state applies it.
9. **Availability is distinct from validity.** Transport failure enters
   `offline` and retries automatically when transport returns.
   Authentication failure and revocation enter `offline` with an
   authentication reason and resume only after credentials are refreshed.
   Validation failure is `terminal`.
10. **Ambiguous recovery.** On reconnection, a request that may have reached
    the authority is retried exactly. If newer durable heads exist behind
    it, the client persists one longer request that repeats the transmitted
    prefix exactly and appends the latest head once. This is the only
    transition that issues a longer append-only string, and it relies on
    the authority trimming the already accepted prefix.

### 2.4 Non-normative timing

The reference delays coalesce interactive bursts without visible latency and
are configurable per client. Changing them requires request-count evidence
and matching test updates; they are not Wire compatibility values.

## 3. Relationship to editor admission

An editor that talks to a local daemon runs the document admission machine
described in [client state machines](../docs/client-state-machines.md). Its
successful admission is local durability, not accepted history; the daemon's
direct machine publishes the durable generations as described here and
reports incorporated request digests with its observations. The two machines
compose in sequence and must not be merged into one coordinator.
