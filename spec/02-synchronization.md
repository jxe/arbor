# Synchronization
*Part of the [Arbor spec](../spec.md): how tree state moves between a client and a server: reading a tree, proposing a transition to it, and watching its accepted transitions.*

*Owns: what a server is and must implement; the routes that read, update, and
watch a tree; transitions and their replay; streams; and errors. References:
the [model and Wire encoding](01-model-and-wire.md) for logical nodes, accepted
state, objects, deltas, shared values, and hash meanings.*

## 1. A server and its trees

Synchronization transports observations and changes of the
[model](01-model-and-wire.md). Its
envelopes may include access, capabilities, materialization state,
diagnostics, cursors, bytes hashes, and transport hints that are
not stored model properties.

The operations have distinct relationships to the model:

- `GET /.arbor/trees/{TreeID}` observes the current accepted tree state,
  while `snapshot` and `objects` transfer its deterministic lossless encoding;
- `updates` proposes a complete candidate tree state through that encoding;
- `watch` monitors ordered accepted tree-state transitions with replay;
- `queries` derives current typed values from any reviewed logical nodes; and
- `mutate` executes reviewed transactional model intent.

The synchronized root is a [bytes hash](01-model-and-wire.md#4-change-and-equivalence):
it identifies the exact Wire encoding of one accepted tree state and serves as
its compare-and-swap key. Different roots may decode to model-equivalent trees
when authored representation details differ.

An Arbor server represents one community. It owns accounts and profile
claims, canonical tree boundaries, the private account-configuration trees,
credential bindings, access enforcement, one mutable accepted root per tree,
immutable objects, and observation streams. It need not implement a local
placement, filesystem replica, or UI. Because it accepts complete candidate
states and merges them itself, it is more than a content-addressed store. It
implements:

- the content-addressed object store, one compare-and-swap root per tree, and
  the ordered observation log with watch replay ([§2](#2-reading-a-tree), [§4](#4-watching-a-tree));
- the merge of disjoint nodes under `ifMatch: "modelHash"`, and the
  `markdown-additive-v1` merge rule for two edits to one Markdown node
  ([§3](#3-updating-a-tree));
- collection-file decoding, the `collection-file-rows-v1` merge rule, and a
  restricted runtime that executes `schema.ts` to recompute schema
  fingerprints and child-set hashes
  ([model and Wire §5](01-model-and-wire.md#5-accepted-state-and-canonical-wire-encoding));
- the `account-config-v1` merge rule and the governed configuration tree
  ([accounts §6](05-accounts-and-devices.md#6-governed-account-tree));
- profile claims, device pairing, access evaluation, and the public HTTP
  projection ([accounts §1.1](05-accounts-and-devices.md#11-profile-claim), [accounts §4](05-accounts-and-devices.md#4-device-pairing), [access control §1](06-access-control.md#1-subjects-and-rules), [locators §6](04-locators.md#6-public-http-projection)).

Hosting executable documents ([executable documents §12](08-executable-documents.md#12-wire-operations))
is optional; a server without that runtime answers those routes with `422 unsupported-operation`.

| Operation | Purpose | Durable effect | Replay boundary |
|---|---|---|---|
| descriptor, `snapshot`, `objects` | Read one accepted tree state | None | `observedThrough` starts a watch without a read/watch gap |
| `updates` | Propose a transition to a candidate state, matching on its bytes hash or its model hashes, or activate a reserved tree with a null base | May append one accepted update | Semantic request identity recovers an ambiguous result; a merged result carries the transition back |
| `watch` | Follow ordered accepted transitions | None | An event cursor resumes retained observation history |

The deterministic lossless graph is both the synchronization representation
and the faithful roundtrip encoding of accepted tree state. The server accepts
complete candidate states rather than imperative edit commands; only accepted,
merged, or restored states enter its ordered history. Identity, bootstrap,
governed configuration, activation, and access management use these same
primitives; [accounts and devices](05-accounts-and-devices.md) and
[access control](06-access-control.md) describe them.

## 2. Reading a tree

```text
GET /.arbor/trees/{TreeID}
GET /.arbor/trees/{TreeID}/snapshot
GET /.arbor/trees/{TreeID}/objects/{hash}
```

`GET /.arbor/trees/{TreeID}` is the tree resource itself: the small
current-state read. It returns:

```ts
type CurrentTree = {
  tree: RemoteTreeDescriptor;
  observedThrough: EventCursor;
};
```

The descriptor's `root` is the bytes hash of the current accepted tree state
and `update` is the accepted-update id that produced it.
`observedThrough` is the cursor after which a client can begin watching without
a read/watch race.

`GET .../snapshot` is the self-contained accepted-tree-state read: the
transition from nothing to the current root, so it carries only complete
objects.

```ts
type ObjectEnvelope = { hash: Hash; bytes: string };

type CurrentTreeSnapshot = {
  tree: RemoteTreeDescriptor;
  root: Hash;
  objects: ObjectEnvelope[];
  observedThrough: EventCursor;
};
```

Object bytes in JSON use canonical padded base64. The server captures one
accepted update and returns the complete graph for that update even if a newer
update is accepted while the response is being encoded. The response therefore
satisfies `tree.root === root`; it is an atomic current-state read, not an
accepted-history query.

`GET .../objects/{hash}` returns the exact canonical CBOR bytes for one
immutable component of the lossless Wire encoding. It uses
`application/cbor`, an ETag equal to the quoted hash, and immutable
cache headers. Possession of a hash is not authorization: the object must be
reachable from the current readable root of the named tree. Retained accepted
history does not create historical-object access. A snapshot is the ordinary
bootstrap and resynchronization read; the object endpoint is useful for
incremental graph traversal.

All three routes require read access. The descriptor and snapshot responses
are mutable observations and therefore carry `observedThrough`; immutable
object bytes do not need an independent observation cursor.

## 3. Updating a tree

```text
POST /.arbor/trees/{TreeID}/updates
```

### 3.1 Request

The client submits one complete candidate state, derived from an accepted
base it observed, together with which hash must still match for the
candidate to be accepted:

```ts
type TransitionPayload = {
  objects: ObjectEnvelope[];
  deltas?: ObjectDelta[];
};

type UpdateRequest = TransitionPayload & {
  base: string | null;
  candidate: Hash;
  ifMatch: "bytesHash" | "modelHash";
  onConflict?: "reject" | "merge";
};
```

An update proposes a transition from the accepted base to the candidate root;
the authority accepts it, or merges and answers with the transition from the
candidate to what it accepted; watch ([§4](#4-watching-a-tree))
delivers every accepted transition in order. One payload shape serves all
three.

`base` is the id of the retained accepted update the candidate was derived
from; the authority knows that update's root, so the pair binds reconciliation
to one accepted event even when the same root appears again later. A `null`
base activates a reserved tree ([accounts §5](05-accounts-and-devices.md#5-declaring-and-activating-a-tree))
with its complete initial snapshot and carries no deltas. `candidate`
names the exact Wire root encoding the desired complete candidate tree state.
The authority decodes and validates its modeled state and all
projection-specific fidelity required by that encoding. `objects` supplies
canonical CBOR objects the server does not already retain; a client normally
walks base and candidate together and omits unchanged objects. The candidate
must still be complete and provable from retained base objects, supplied
objects, and valid `deltas`. The
[deltas](01-model-and-wire.md#53-deltas)
rules define those interchangeable representations; they do not change the
candidate's identity.

`ifMatch` names which hash of the [model](01-model-and-wire.md#4-change-and-equivalence)
must still match its value at base for the candidate to be accepted; `base`
supplies the values, as an ETag does for HTTP `If-Match`:

- `bytesHash`: the tree's bytes hash must still match, so current must still
  equal base. Any other change is a conflict and is always rejected; matching
  on bytes means "exactly what I saw", so a merge would contradict it.
  Activation uses it, and so does any tool that must replace the tree's exact
  state.
- `modelHash`: the model hash of each node the candidate changed must still
  match. The authority takes every node whose bytes differ between base and
  candidate, the candidate's *touched* nodes, and checks that each has the
  same model hash in current as it had at base. Nodes that current has reformatted without
  changing their model do not conflict, and neither does anything current
  changed elsewhere. `onConflict`, which defaults to `merge`, says what to do
  when a touched node's model did change in current: `reject` the candidate,
  or resolve each conflicting node with the representation's merge rule.

### 3.2 Authority decision

After reconstructing and validating the candidate graph, the server makes one
of these decisions:

1. If the candidate already equals current, return `200 current` and create no
   accepted update.
2. If the candidate equals the base while current has advanced, return the
   current accepted update and create no new update.
3. If current equals the base, atomically accept the candidate and return
   `201 accepted`.
4. Otherwise, if `ifMatch` is `modelHash` and every touched node still
   matches, or every conflicting
   node is resolved by a merge rule under `onConflict: "merge"`, merge: the
   result is current with the candidate's bytes for its touched nodes and the
   rule's output for any resolved node. Atomically accept it and return
   `201 merged`.
5. Otherwise return `409 conflict` with the current update, structured reasons
   naming each conflicting node, and the `draft` transition the client keeps.
   Accepted state does not advance and the rejected candidate does not become
   history.

A merge rule is the representation-specific way to combine two changes to
one node: `markdown-additive-v1` for Markdown,
`collection-file-rows-v1` for a collection file, and `account-config-v1` for
the governed configuration tree. A node
with no merge rule, or one the rule cannot combine, is a conflict.

### 3.3 Results, reconciliation, and retry

A successful response is:

```ts
type AcceptedUpdate = {
  id: string;
  tree: TreeID;
  root: Hash;
  previousRoot: Hash | null;
  kind: "initial" | "accepted" | "merged" | "restored";
  acceptedAt: number;
  subject: string | null;
  merge?: MergeSummary;
};

type MergeSummary =
  | { version: "markdown-additive-v1"; approximatePlacements: number }
  | { version: "account-config-v1"; mergedFields: number }
  | { version: "collection-file-rows-v1"; mergedRows: number };

type UpdateResult = {
  outcome: "current" | "accepted" | "merged";
  update: AcceptedUpdate;
  requestDigest: Hash;
  observedThrough: EventCursor;
  reconciliation?: TransitionPayload;
};
```

`update` is the accepted update that stands after the decision: the untouched
current one for `current`, or the newly accepted or merged one. `merge` is
present only when a merge rule ran; a merge of disjoint nodes carries none. An accepted update's `id` is the decimal ordinal
of the observation that recorded it, so it is also that update's `tree.update`
cursor and `observedThrough`. `reconciliation` is present exactly when the accepted root differs from the
submitted candidate: it is the transition from the candidate root to
`update.root` under the [deltas](01-model-and-wire.md#53-deltas) rules, so
a superseded, merged, or replayed result is applied with the same code that
applies a watch frame. An accepted candidate returns none.

A conflict uses the shared `ArborError` envelope with
`details.kind: "server-update" | "account-configuration"`. Its details include the current `AcceptedUpdate`, the base and candidate
roots, structured conflict reasons naming each conflicting node, and `draft`,
the transition from the candidate root to the draft root the client keeps.

Semantic request identity is the SHA-256 of the
[canonical CBOR encoding](01-model-and-wire.md#52-canonical-encoding-and-hashes)
of `{ version: "updates-v1", tree, base, candidate, ifMatch, onConflict }`,
with `onConflict` as its effective value, scoped to the
authenticated credential. `objects`, `deltas`, and their ordering are
transport choices and are excluded. An ambiguous retry may therefore replace a
delta with complete bytes without changing identity. Exact accepted or merged
replay returns the original result and creates no duplicate accepted update.
Clients durably retain the base, candidate, required content, and any conflict
draft until the result has been applied.

### 3.4 Collection files in a candidate

When a candidate changes a recognized collection file, the submitted root
names the exact lossless encoding of that candidate tree state. The authority
decodes coherent base, current, and candidate representations under schema and
resource bounds, recomputes logical row identities and the collection file's
child-set hash, applies `collection-file-rows-v1` to a conflicting collection
file, validates all
keys, foreign keys, and constraints, and encodes the accepted representation.
It never trusts a client-supplied schema fingerprint or child-set hash.
Formatting-only changes advance the accepted root without changing the
child-set hash, so they invalidate no logical query dependency.

The update setting `ifMatch: "modelHash"` is intentionally not renamed: it
compares the complete model hash of every touched logical node, not the
collection file's narrower `childSetHash`. The latter is used while decoding
and merging the node's child-set contribution. SQLite and Postgres changes use
the database transaction,
observation, and semantic-checkpoint protocol specified separately; live
database storage bytes are never submitted or merged as a collection-file
object.

## 4. Watching a tree

```text
GET /.arbor/trees/{TreeID}/watch?after={cursor}
```

The request carries `Accept: text/event-stream` and may carry `Last-Event-ID: {cursor}`.

The client reads the descriptor or a snapshot and then observes strictly after its
`observedThrough`. `after` and `Last-Event-ID` are equivalent; supplying both
with different values is `invalid-request`.

Every frame satisfies `id === data.cursor` and `event === data.kind`. Its JSON
body is:

```ts
type AcceptedTransition = TransitionPayload & {
  update: AcceptedUpdate;
  requestDigest?: Hash;
};

type TreeUpdateEvent = {
  cursor: EventCursor;
  tree: TreeID;
  kind: "tree.update";
  change: {
    descriptor: RemoteTreeDescriptor;
    transitions: AcceptedTransition[];
  };
};
```

Accepted updates are ordered within their tree by their `id`, the observation
ordinal that recorded them; the same ordinal orders the combined observation
stream, so one counter yields update ids and event cursors. Initial accepted
updates have no transition.
Every later accepted update durably records one replay payload from its exact
`previousRoot` to `root`, regardless of whether the authority directly accepted,
merged, or restored that result.

The replay payload is a sparse proof of the target graph. `objects` contains
canonical target objects not reconstructed by a delta under the
[deltas](01-model-and-wire.md#53-deltas) rules. Submission and watch
share the `ObjectDelta` primitive, but not editor history: after validation and
any merge, the authority derives the transition from the actual accepted
endpoints, diffing every changed directory and file against its predecessor at
the same path.

Transition identity is the ordered accepted update and its previous/target
roots, not the selected byte encoding. Canopy may replace or pack physical
representations later without changing accepted history or observable Wire
semantics. Content-addressed objects and accepted roots remain canonical;
transition chains are replay acceleration and never the sole recovery source.

`transitions` is nonempty, chains exactly by root (each `previousRoot` is the
preceding `root`), and ends at `change.descriptor.update` and `change.descriptor.root`. The frame ID is
the final transition's update ID. Live delivery normally has one entry. Replay
groups consecutive retained accepted-update events into bounded batches without
crossing another observation event; it does not structurally simplify or
re-diff them. A client may apply a batch sequentially in memory and commit only
the final materialization.

For `tree.update`, a transition's `requestDigest` is present only when the stream
is authenticated by the exact bearer credential that submitted that accepted
request. It is correlation data, not authority. A non-retained event cursor, a
retained accepted update without a replay payload, or a batch too old for
retained transition data produces one terminal `resync-required` event and
closes; the client reads a new snapshot and resumes after its cursor.

`tree.activation` is the one observation kind that is not an accepted update. When a tree declared in
`trees.yaml` becomes active ([accounts §5](05-accounts-and-devices.md#5-declaring-and-activating-a-tree)), the
authority records one event on the declaring account's configuration-tree
stream:

```ts
type TreeActivationEvent = {
  cursor: EventCursor;
  tree: TreeID; // the account-configuration tree carrying the event
  kind: "tree.activation";
  change: { tree: TreeID; status: "active" };
};
```

`change.tree` names the newly active tree. The event advances the
configuration tree's observation stream and `observedThrough` without changing
its accepted content update; a watcher applies no transition for it.

## 5. Streams and errors

Tree watch and query result streams use one UTF-8 SSE framing rule: blank lines
separate frames, multiple `data:` lines join with newlines, and clients ignore
comments and keepalives. The `event` field names the typed event and `data` is
one canonical JSON value. Producers share escaping, cancellation,
bounded-buffer, and terminal-close behavior.

This shared transport does not imply shared cursor semantics. A tree watch sets
a replayable `id`, carries the complete `ObservationEvent`, and supports
`Last-Event-ID`, retained history, and `resync-required`. A query stream omits
`id`, sends the remaining event members after `type`, and establishes fresh
derived state with `ready`; reconnection repeats the complete query.

The shared error envelope and common codes are normative. Narrow server-only
codes include `already-claimed`. Base/update mismatch,
reserved boundaries, policy failures, and merge conflicts use `conflict` with
discriminated `server-update` or `account-configuration` details where
applicable.

## 6. Example: editor edit roundtrip

This non-normative example shows how the preceding operations compose:

1. The client makes an editor change durable locally and records its accepted
   `{ root, update }` base.
2. It builds the complete candidate graph, omitting unchanged objects and using
   an `ObjectDelta` when that is smaller than the complete changed object.
3. It submits the candidate against its accepted base update id. The
   authority validates it, performs any merge, and atomically records at most
   one accepted update.
4. The response and the corresponding `tree.update` event may arrive in either
   order. The submitting client handles them idempotently; a matching private
   `requestDigest` is a causal acknowledgement of the frozen semantic intent.
5. A clean replica applies a contiguous transition batch in memory and durably
   materializes only its final state. A replica with local changes submits its
   own candidate. Missing history or any failed check falls back to a coherent
   snapshot.

The client clears its durable attempt only after applying the accepted or
merged graph and advancing its local base. The event acknowledges candidate
intent, not the submitted delta bytes: a merge may produce a different accepted
representation. Rejected conflicts never appear on watch.
