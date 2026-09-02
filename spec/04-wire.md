# Arbor Wire API
*Part of the [Arbor spec](../spec.md): the portable wire protocol for community identity, governed configuration, immutable trees, synchronization, executable-document data, access, and observation.*

An Arbor server represents one community. It owns accounts and profile
claims, canonical tree boundaries, the private account-configuration trees,
credential bindings, ACL enforcement, one mutable accepted ref per tree,
immutable objects, and observation streams. It need not implement a local
workspace or UI.

## Protocol relationship to the data model

Wire transports observations and changes of the [Arbor data model](01-data-model.md).
Its envelopes may include access, capabilities, materialization state,
diagnostics, cursors, exact encoding revisions, and transport hints that are
not stored model properties.

The operations have distinct relationships to the model:

- `ref` observes the current accepted tree state, while `snapshot` and
  `objects` transfer its deterministic lossless Wire encoding;
- `updates` proposes a complete candidate tree state through that encoding;
- `watch` monitors ordered accepted tree-state transitions with replay;
- `queries` derives current typed values from any reviewed logical nodes; and
- `mutate` executes reviewed transactional model intent.

The synchronized root identifies the exact Wire encoding of one accepted tree
state and serves as its compare-and-swap key. It is not a universal logical
hash: different roots may decode to model-state-equivalent trees when authored
representation details differ. Equivalence of directory, store, and
materialization projections is defined by the data model and their projection
specs; Wire does not require one universal logical serialization or hash.

## 1. Accepted tree synchronization

### 1.1 Lifecycle overview

Accepted tree synchronization has three operations with distinct durability
and replay behavior:

| Operation | Purpose | Durable effect | Replay boundary |
|---|---|---|---|
| `ref`, `snapshot`, `objects` | Read one accepted tree state | None | `observedThrough` starts a watch without a read/watch gap |
| `updates` | Propose a complete candidate state | May append one accepted update | Semantic request identity recovers an ambiguous result |
| `watch` | Follow ordered accepted transitions | None | An event cursor resumes retained observation history |

The deterministic lossless graph is both the synchronization representation
and the faithful roundtrip encoding of accepted tree state. The server accepts
complete candidate states rather than imperative edit commands; only accepted,
merged, or restored states enter its ordered history. Identity, bootstrap,
governed configuration, activation, and access management use these same
primitives but are described after the core protocol sections.

### 1.2 Read accepted tree state

```text
GET /.arbor/trees/{TreeID}/ref
GET /.arbor/trees/{TreeID}/snapshot
GET /.arbor/trees/{TreeID}/objects/{hash}
```

`GET .../ref` is the small current-state read. It returns:

```ts
type CurrentTreeRef = {
  snapshot: RemoteTreeDescriptor;
  observedThrough: EventCursor;
};
```

The descriptor's `ref` is the exact Wire encoding root of the current accepted
tree state and `update` is the accepted-update ID that produced it.
`observedThrough` is the cursor after which a client can begin watching without
a read/watch race.

`GET .../snapshot` is the self-contained accepted-tree-state read:

```ts
type ObjectEnvelope = { hash: Hash; bytes: string };

type TreeSnapshot = {
  root: Hash;
  objects: ObjectEnvelope[];
};

type CurrentTreeSnapshot = {
  tree: RemoteTreeDescriptor;
  snapshot: TreeSnapshot;
  observedThrough: EventCursor;
};
```

Object bytes in JSON use canonical padded base64. The server captures one
accepted update and returns the complete graph for that update even if a newer
update is accepted while the response is being encoded. The response therefore
satisfies `tree.ref === snapshot.root`; it is an atomic current-state read, not
an accepted-history query.

`GET .../objects/{hash}` returns the exact canonical CBOR bytes for one
immutable component of the lossless Wire encoding. It uses
`application/cbor`, an ETag equal to the quoted hash, and immutable
cache headers. Possession of a hash is not authorization: the object must be
reachable from the current readable root of the named tree. Retained accepted
history does not create historical-object access. A snapshot is the ordinary
bootstrap and resynchronization read; the object endpoint is useful for
incremental graph traversal.

All three routes require read access. The ref and snapshot responses are
mutable observations and therefore carry `observedThrough`; immutable object
bytes do not need an independent observation cursor.

### 1.3 Sparse graph transfer

Updates and accepted transitions transfer the same content-addressed graph.
Each changed object travels either as its complete canonical bytes or as a
delta against an object that is reachable in the relevant basis graph:

| Representation | Update submission | Accepted transition | Intended use |
|---|---|---|---|
| `ObjectEnvelope` | Yes | Yes | New objects, or whenever complete canonical bytes are smallest |
| `ObjectDelta` | Yes | Yes | Any changed file or directory whose predecessor shares most of its bytes |

```ts
type ObjectDelta = {
  base: Hash;
  result: Hash;
  instructions: Array<
    | { copy: { offset: number; length: number } }
    | { insert: string }
  >;
};
```

An `ObjectDelta` concatenates ordered instructions into the complete canonical
bytes of the `result` object. `copy` addresses the exact canonical bytes of the
`base` object and `insert` is canonical padded base64. Copy ranges are
nonempty, nonnegative safe JSON integers wholly within the base bytes; inserts
and the instruction list are nonempty. Because instructions address encoded
bytes rather than a decoded payload, one rule covers every object kind: a
one-entry change to a large directory or a one-paragraph change to a large
file costs a few instructions instead of the whole object, and a moved region
is a copy rather than a retransmission.

A file object's canonical encoding carries its payload length, so a sender
deriving a delta from editor edits inserts the result's header bytes and copies
the unchanged payload ranges at their base offsets. Any instruction sequence
that reconstructs the exact result is valid; the diff algorithm is the
sender's choice and never part of identity.

The base must be reachable in the relevant basis graph: the retained accepted
base for a submission, or the previous accepted root for a transition. The
receiver hash-verifies that base, applies the instructions, requires the
reconstructed bytes to hash to `result`, and decodes them as a valid canonical
object. It then treats the result exactly like a complete object. A result
appears exactly once across complete objects and deltas. New objects use
complete bytes. The sender chooses whichever representation is smaller. The
encoding is a transport choice: the identified result object and accepted
roots remain canonical, and retries or later storage packing may select a
different representation without changing semantic identity. Duplicate
results, a result also supplied as a complete object, noncanonical base64,
out-of-bounds copies, arithmetic overflow, and quota excess are invalid.

### 1.4 Submit a candidate state

#### Request

```text
POST /.arbor/trees/{TreeID}/updates
Content-Type: application/json
```

The client submits one complete candidate state against the exact accepted base
it previously observed:

```ts
type UpdateRequest = {
  base: {
    root: Hash;
    update: string;
  };
  candidate: Hash;
  objects: ObjectEnvelope[];
  deltas?: ObjectDelta[];
  returnSnapshot?: true | "if-result-differs";
};
```

`base.root` and `base.update` bind reconciliation to one retained accepted
event, including the case where the same root appears again later. `candidate`
names the exact Wire root encoding the desired complete candidate tree state.
The authority decodes and validates its modeled state and all
projection-specific fidelity required by that encoding. `objects` supplies
canonical CBOR objects the server does not already retain; a client normally
walks base and candidate together and omits unchanged objects. The candidate
must still be complete and provable from retained base objects, supplied
objects, and valid `deltas`. The [sparse graph transfer](#13-sparse-graph-transfer)
rules define those interchangeable representations; they do not change the
candidate's identity.

#### Authority decision

After reconstructing and validating the candidate graph, the server makes one
of these decisions:

1. If the candidate already equals current, return `200 current` and create no
   accepted update.
2. If the candidate equals the base while current has advanced, return the
   current accepted update and create no new update.
3. If current equals the base, atomically accept the candidate and return
   `201 accepted`.
4. If both sides changed safely and disjointly, perform the sole authoritative
   three-way merge, atomically accept it, and return `201 merged`.
5. If they overlap unsafely, return `409 conflict` with the current update,
   structured reasons, and a complete client-owned draft snapshot. Accepted
   state does not advance and the rejected candidate does not become history.

#### Results, reconciliation, and retry

A successful response is:

```ts
type AcceptedUpdate = {
  id: string;
  tree: TreeID;
  sequence: number;
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
  | { version: "rollup-rows-v1"; mergedRows: number };

type UpdateResult =
  | {
      outcome: "current";
      current: AcceptedUpdate;
      requestDigest: Hash;
      observedThrough: EventCursor;
      snapshot?: TreeSnapshot;
    }
  | {
      outcome: "accepted";
      update: AcceptedUpdate;
      requestDigest: Hash;
      observedThrough: EventCursor;
      snapshot?: TreeSnapshot;
    }
  | {
      outcome: "merged";
      update: AcceptedUpdate;
      merge: MergeSummary;
      requestDigest: Hash;
      observedThrough: EventCursor;
      snapshot?: TreeSnapshot;
    };
```

A conflict uses the shared `ArborError` envelope with
`details.kind: "server-update" | "account-configuration"`. Its details include
the current `AcceptedUpdate`, submitted base and candidate roots, a complete
portable `draft`, structured conflict reasons, and `currentSnapshot` when the
request asked the server to return an authoritative snapshot.

For an ordinary accepted ref change, `observedThrough` is that accepted
update's watch cursor. `returnSnapshot` is a transport-only response hint. With
`true`, the server returns the complete accepted snapshot. With
`"if-result-differs"`, it omits the snapshot only when the accepted root equals
the submitted candidate; a remote-current, merged, or conflicted result returns
the complete authoritative snapshot needed for immediate reconciliation.

Semantic request identity is the SHA-256 of RFC 8785 canonical JSON for
`{ version: "updates-v1", tree, base, candidate }`, scoped to the authenticated
credential. `objects`, `deltas`, their ordering, and `returnSnapshot` are
transport choices and are excluded. An ambiguous retry may therefore replace a
delta with complete bytes without changing identity. Exact accepted or merged
replay returns the original result and creates no duplicate accepted update.
Clients durably retain the base, candidate, required content, and any conflict
draft until the result has been applied.

#### Projection-specific candidates

When a candidate changes a recognized file child rollup, the submitted root
names the exact lossless encoding of that candidate tree state. The authority
decodes coherent base, current, and candidate representations under schema and
resource bounds, recomputes logical row identities and the store codec's scoped
model digest, merges disjoint changes by stable row identity, validates all
keys, foreign keys, and constraints, and encodes the accepted representation.
It never trusts a client-supplied model digest. Formatting-only changes may
advance the accepted root without changing model-state equivalence or logical
query dependencies. SQLite and Postgres changes use the database transaction,
observation, and semantic-checkpoint protocol specified separately; live
database storage bytes are never submitted or merged as a rollup object.

### 1.5 Watch accepted transitions

```text
GET /.arbor/trees/{TreeID}/watch?after={cursor}
Last-Event-ID: {cursor}
Accept: text/event-stream
```

The client reads a ref or snapshot and then observes strictly after its
`observedThrough`. `after` and `Last-Event-ID` are equivalent; supplying both
with different values is `invalid-request`.

Every frame satisfies `id === data.cursor` and `event === data.kind`. Its JSON
body is:

```ts
type AcceptedTransition = {
  update: AcceptedUpdate;
  objects: ObjectEnvelope[];
  deltas?: ObjectDelta[];
  requestDigest?: Hash;
};

type TreeRefEvent = {
  cursor: EventCursor;
  tree: TreeID;
  kind: "tree.ref";
  change: {
    descriptor: RemoteTreeDescriptor;
    transitions: AcceptedTransition[];
    requestDigest?: Hash;
  };
};
```

Accepted updates have a gap-free, one-based `sequence` within their tree. The
sequence orders accepted content only; `EventCursor` continues to order the
combined observation stream. Initial accepted updates have no transition.
Every later accepted update durably records one replay payload from its exact
`previousRoot` to `root`, regardless of whether the authority directly accepted,
merged, or restored that result.

The replay payload is a sparse proof of the target graph. `objects` contains
canonical target objects not reconstructed by a delta under the
[sparse graph transfer](#13-sparse-graph-transfer) rules. Submission and watch
share the `ObjectDelta` primitive, but not editor history: after validation and
any merge, the authority derives the transition from the actual accepted
endpoints, diffing every changed directory and file against its predecessor at
the same path.

Transition identity is the ordered accepted update and its previous/target
roots, not the selected byte encoding. Canopy may replace or pack physical
representations later without changing accepted history or observable Wire
semantics. Content-addressed objects and accepted roots remain canonical;
transition chains are replay acceleration and never the sole recovery source.

`transitions` is nonempty, contiguous by `sequence`, chains exactly by root, and
ends at `change.descriptor.update` and `change.descriptor.ref`. The frame ID is
the final transition's update ID. Live delivery normally has one entry. Replay
groups consecutive retained accepted-update events into bounded batches without
crossing another observation event; it does not structurally simplify or
re-diff them. A client may apply a batch sequentially in memory and commit only
the final materialization.

For `tree.ref`, a transition's `requestDigest` is present only when the stream
is authenticated by the exact bearer credential that submitted that accepted
request. For compatibility, `change.requestDigest` may repeat the final
transition's digest. It is correlation data, not authority. Account status and
activation use their own kinds and may advance the observation stream without
changing the accepted content update. A non-retained event cursor, a retained
accepted update without a replay payload, or a batch too old for retained
transition data produces one terminal `resync-required` event and closes; the
client reads a new snapshot and resumes after its cursor.

### 1.6 Example: editor edit roundtrip

This non-normative example shows how the preceding operations compose:

1. The client makes an editor change durable locally and records its accepted
   `{ root, update }` base.
2. It builds the complete candidate graph, omitting unchanged objects and using
   an `ObjectDelta` when that is smaller than the complete changed object.
3. It submits the candidate with `returnSnapshot: "if-result-differs"`. The
   authority validates it, performs any merge, and atomically records at most
   one accepted update.
4. The response and the corresponding `tree.ref` event may arrive in either
   order. The submitting client handles them idempotently; a matching private
   `requestDigest` is a causal acknowledgement of the frozen semantic intent.
5. A clean replica applies a contiguous transition batch in memory and durably
   materializes only its final state. A replica with local changes submits its
   own candidate. Missing history or any failed guard falls back to a coherent
   snapshot.

The client clears its durable attempt only after applying the accepted or
merged graph and advancing its local base. The event acknowledges candidate
intent, not the submitted delta bytes: a merge may produce a different accepted
representation. Rejected conflicts never appear on watch.

## 2. Executable-document operations

Executable documents use two reviewed logical-model operations. Queries safely
derive current permissioned values without exposing raw stores; mutations
execute reviewed transactional intent. Neither operation is accepted-tree
synchronization, even when a mutation also advances an Arbor-canonical data
tree.

### 2.1 Evaluate and stream named queries

```text
QUERY /.arbor/trees/{SourceTreeID}/queries
Content-Type: application/json
Accept: text/event-stream
```

An execution host may serve a reviewed [executable document](07-executable-documents.md)
while its permitted data lives on the same or another Arbor server. The request
completely describes the coherent document version and its currently mounted
query graph. A server without an executable-document runtime, or without
hosting activated for the source tree, returns `422 unsupported-operation`.

```ts
type QueryCursor = string;

type QueryHandleRef = {
  tree: TreeID;
  module: LogicalPath;
  export: string;
  version: Hash;
};

type QueriesRequest = {
  document: {
    tree: TreeID;
    path: LogicalPath;
    version: Hash;
  };
  queries: Array<{
    id: string;
    handle: QueryHandleRef;
    input: unknown;
    knownOutputHash?: Hash;
  }>;
};
```

`document.tree` must equal the route `SourceTreeID`. The query array is nonempty
and its IDs are nonempty and unique within this request. A handle from another
tree is allowed only when it is an imported reviewed handle in this document's
manifest. The host verifies the coherent document version, reviewed handle
membership, input schema, authenticated user context, effective access, and all
bound node roots, edge/schema fingerprints, and provider identities. The
request and events are independent of whether those nodes are expanded files,
rollups, SQLite, Postgres, mounted trees, or remote providers. A
`knownOutputHash` permits omission of unchanged bytes only after fresh
authorization and reevaluation; it is neither
authorization nor evidence of current state. Output hashes are SHA-256 of RFC
8785 canonical JSON for the complete public result.

Every provider translates the reviewed query into conservative logical
sensitivities. An ordinary `.children` query depends on its resolved parent's
membership and schema, the sampled child identities/revisions, and every
property field used by filtering or selection. A provider-owned mutation may
publish the exact changed property names; an external or imprecise observation
omits them and therefore widens invalidation. Relational providers may prove
narrower row/edge sensitivities, but missing precision never permits a skipped
reevaluation.

The UTF-8 SSE response has these semantic events:

```ts
type PublicQueryError = {
  code: string;
  message: string;
  retryable: boolean;
};

type QueryEvent =
  | {
      type: "result";
      id: string;
      observedThrough: QueryCursor;
      outputHash: Hash;
      value: unknown;
      error?: never;
    }
  | {
      type: "result";
      id: string;
      observedThrough: QueryCursor;
      error: PublicQueryError;
      outputHash?: never;
      value?: never;
    }
  | {
      type: "ready";
      queries: Array<{
        id: string;
        observedThrough: QueryCursor;
        outputHash?: Hash;
      }>;
    }
  | {
      type: "reload";
      reason: "source-changed" | "access-changed";
    };
```

The SSE `event` field supplies `type`; JSON `data` supplies the remaining
members. Each `result` is a complete authorized replacement for one query, not
a raw driver event or patch. `ready` is sent only after every query has
established a race-free snapshot-then-follow boundary. Before `ready`, changed
hashes produce complete `result` values and an unchanged retained value may be
confirmed by its hash in `ready`. Identical output hashes produce no payload.
The observation listener is active before sampling. Events racing evaluation
are checked against both the former and newly sampled dependencies; a relevant
event forces another complete evaluation before that result is published. This
is the no-gap guarantee. It does not require a retained query-event replay log.

`QUERY` has the safe and idempotent semantics defined by
[RFC 10008](https://www.rfc-editor.org/rfc/rfc10008.html). Evaluating or
subscribing to a query never performs a mutation. The response is
user/access dependent and long-lived, so it carries `Cache-Control: no-store`;
automatic retry still reauthorizes and reestablishes current state rather than
reusing a cached body.

The response lifetime is the subscription lifetime. There is no durable
execution ID, acknowledgement, SSE replay cursor, or resumable server-side
subscription. Reconnection repeats and reauthorizes the complete `QUERY`. When
the mounted query graph changes, the client opens a complete replacement request
and retains the old response only until the replacement sends `ready`. Source
or access changes send `reload` when possible and close. Listener loss, backing
uncertainty, process restart, or irrecoverable backpressure closes rather than
publishing a result known to be stale; hosts may coalesce intermediate complete
states.

### 2.2 Execute named mutations

Mutation calls carry the reviewed handle identity and version, validated input,
authenticated subject, and caller-stable mutation identity:

```text
POST /.arbor/trees/{SourceTreeID}/mutate
Content-Type: application/json
```

```ts
type MutateRequest = {
  document: {
    tree: TreeID;
    path: LogicalPath;
    version: Hash;
  };
  handle: MutationHandleRef;
  mutationID: string;
  input: unknown;
};

type MutationHandleRef = QueryHandleRef;

type MutationResultReceipt<Result = unknown> = {
  mutationID: string;
  requestDigest: Hash;
  observedThrough: EventCursor;
  affected?: {
    tree: TreeID;
    update: string;
    root: Hash;
    cursor: EventCursor;
  };
  result: Result;
};
```

`document.tree` must equal the route `SourceTreeID`. The host validates the
document/handle versions and input before opening the transaction domain.
Mutation semantic identity is the SHA-256 of RFC 8785 canonical JSON for
`{ version: "mutate-v1", handle, input, sources }`, where `sources` is the
activated handle's complete, authored-path-sorted set of
`{ authoredPath, tree, path, schemaFingerprint }` bindings. The bindings are
reviewed manifest state, not caller-selected destinations. This prevents an
ambiguous retry from executing the same code and input against a newly resolved
store, relation, or schema. Durable lookup is scoped by
the source tree, authenticated subject, and `mutationID`. Reusing that identity
with a different request digest is a conflict; an exact ambiguous retry returns
the original receipt and creates no second effect. This is the same committed-
intent pattern as an accepted tree update: transport representation is excluded
from the semantic digest, the subject scopes replay, and the receipt identifies
the committed observation boundary. When the transaction advances an Arbor-
canonical data tree, `affected` identifies its accepted update, Wire root, and
gap-free watch cursor. A shared external-store mutation may omit `affected`
and uses `observedThrough` for the derived-query observation domain. The mutate
payload remains distinct from `UpdateRequest`: it carries reviewed intent and
authorization context, while updates carry complete candidate tree state.

Document React Actions may use the document's ordinary canonical HTTP action
surface, while a named Wire call uses the endpoint above. Both bind through the
compiled manifest and preserve this exact request/receipt identity.
The durable receipt and corresponding query result may arrive in either order;
clients correlate them idempotently and treat the query result as authoritative.

### 2.3 Relationship to tree synchronization

The four operations remain distinct even when their implementations share
authentication, semantic digests, receipts, observation brokers, SSE framing,
and tree-scoped authorization:

- `POST .../updates` proposes a complete candidate tree state against an
  accepted base and may merge or conflict;
- `GET .../watch` replays accepted tree observations from a retained cursor;
- `QUERY .../queries` safely derives a fresh user-dependent result over any
  reviewed logical nodes and has no retained replay identity;
- `POST .../mutate` executes one reviewed transactional procedure with
  exactly-once retry semantics.

Combining update and mutate payloads would obscure their different transaction
and conflict domains. Combining watch and queries would either discard useful
watch replay or invent durable query-subscription state. Endpoint
consolidation therefore consists of shared conventions and implementation
machinery, not one polymorphic mutation or stream endpoint.

Query streaming is derived-result delivery, not tree history. A mutation of an
Arbor-canonical data tree advances that data tree's ordinary accepted ref and
therefore also causes a `tree.ref` watch event; it does not change the
executable document's source-tree ref. A mutation of a shared external store can
update query results without an Arbor data-tree update. Neither execution nor
network reachability grants historical-object access, broadens the readable tree graph,
or exposes raw stores, credentials, private handler source, unrelated rows, or
private diagnostics. Cross-server query discovery, delegated authorization,
and server-to-server execution routing remain unspecified.

## 3. Protocol conventions

These conventions apply across synchronization, executable-document
operations, and the administrative endpoints that follow.

### 3.1 Server-sent event streams

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

### 3.2 Shared values and descriptors

The wire owns these transport-neutral values. Language bindings must be
equivalent and consume the language-neutral vectors under
[`conformance`](../conformance).

```ts
type TreeID = string;
type LogicalPath = string;
type EventCursor = string;
type Hash = `sha256:${string}`;
type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [name: string]: JSONValue };
type Diagnostic = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  path?: LogicalPath;
  row?: number;
  field?: string;
};
type AccessLevel = "none" | "read" | "write";
type ReadWriteAccess = "read" | "write";

type TreeKind =
  | "community-profile"
  | "person-profile"
  | "group-profile"
  | "shared-subtree"
  | "account-configuration";

type TreeDescriptor = {
  id: TreeID;
  kind: TreeKind;
  access: AccessLevel;
  canonical: {
    locator: string;
    path: LogicalPath;
    endpoint: string;
    httpURL: string;
    parentTree: TreeID | null;
  } | null;
};

type RemoteTreeDescriptor = TreeDescriptor & {
  ref: Hash;
  update: string;
};

type AccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID }
  | { kind: "link"; digest: Hash };

type AccessRule = { subject: AccessSubject; access: ReadWriteAccess };

type AccessEntry = {
  id: string;
  subject:
    | { kind: "everyone" }
    | { kind: "profile"; tree: TreeID; locator?: string }
    | { kind: "link" };
  access: ReadWriteAccess;
};

type LocatorResolution = {
  ref: { tree: TreeID; path: LogicalPath; stableKey: string | null };
  enclosingTree: TreeDescriptor;
  historical: boolean;
  observedThrough: EventCursor;
};

type ArborError<TDetails = unknown> = {
  error: string;
  message: string;
  retryable: boolean;
  tree?: TreeID;
  path?: LogicalPath;
  details?: TDetails;
};

type ObservationEvent<TKind extends string, TChange> = {
  cursor: EventCursor;
  tree: TreeID;
  kind: TKind;
  change: TChange;
};

type NodeRef = {
  tree: TreeID;
  path: LogicalPath;
  stableKey: string | null;
};

type WritePropertiesOperation = {
  op: "writeProperties";
  ref: NodeRef;
  basePropertiesRevision: string;
  properties: Record<string, JSONValue>;
};

type IdentityRule = {
  properties: string[];
};

type ChildRepresentationSummary =
  | { type: "expanded" }
  | {
      type: "rollup";
      codec: "csv" | "json" | "jsonl" | "sqlite";
      scope: "children" | "subtree";
      modelDigest: Hash;
    }
  | { type: "external"; driver: string };

type NodeCapabilities = {
  properties?: { revision: string; schema?: Hash; writable: boolean };
  content?: {
    revision: string;
    mediaType: string;
    format?: "markdown" | "mdx" | "tsx" | "json";
    writable: boolean;
  };
  children?: {
    revision: string;
    schema?: Hash;
    representation?: ChildRepresentationSummary;
    total?: number;
    writable: boolean;
  };
  executable?: {
    version: Hash;
    state: "runnable" | "diagnostic" | "inactive";
  };
};

type NodeContent = {
  source: string;
  representation?: {
    state: "stored" | "implicit";
    origin?: "sibling" | "index";
  };
};

type NodeSummary = {
  ref: NodeRef;
  name: string;
  revision: string;
  properties: Record<string, JSONValue>;
  capabilities: NodeCapabilities;
  materialization: "available" | "placeholder";
  diagnostics: Diagnostic[];
};

type NodeSnapshot = NodeSummary & {
  content?: NodeContent;
  observedThrough: EventCursor;
};

type ChildrenPage = {
  parent: NodeRef;
  items: NodeSummary[];
  nextCursor: string | null;
  observedThrough: EventCursor;
};
```

These are model-sampling values, not another stored graph. `ref` is the sole
tree/path/identity carrier; snapshots and summaries do not repeat `tree`,
`path`, `kind`, `pageID`, or collection-specific fields. Properties and
content remain independent, and an omitted content payload does not negate a
content capability—for example, clients normally fetch large file bytes
separately. Capability names and states are fail-closed: an unknown capability
or format may be retained or ignored for forward compatibility but never
grants editing, execution, traversal, or file access.

Clients may derive a parsed Markdown document from exact `NodeContent.source`;
that derived representation is not a second authored value. Markdown property
and content operations are addressed separately even when their capability
revisions name the same exact source bytes. A `ChildRepresentationSummary` describes the observed placement;
it does not make backing or projection topology part of node identity. The
exact synchronized rollup form remains the `RollupDescriptor` below.

The local HTTP adapter carries this same reference without inventing a second
locator shape. Requests to `/v1/node`, `/v1/file`, `/v1/children`,
`/v1/backlinks`, and `/v1/recovery` require the `tree`, `path`, and `stableKey`
query parameters. An empty `stableKey` parameter encodes JSON `null`; a
non-empty value is the canonical identity-key JSON, percent-encoded by the HTTP
client. JSON mutation and transfer requests embed the three fields directly.
The removed `pageID | pathHint` request union is invalid on every route. The
local-only `local` and `system` tree scopes use the same three-field shape even
though those sentinel scopes never cross Arbor Wire.

New tree IDs are `tr_` plus 26 lowercase base32 characters encoding 128 random
bits. New device IDs use the same encoding after `dv_`. Existing shorter IDs
may remain valid during migration, but activation and pairing require the new
form. Generating an ID neither reserves it nor contacts the server.

Server resolution always supplies `enclosingTree`. Ordinary hosted trees
have complete non-null canonical data. The authenticated account-configuration
tree is returned only to its account and has `kind: "account-configuration"`
and `canonical: null`.

Every tree operation, result, event, effect, and relevant error names its `TreeID`. `local` and `system` are not wire values. Writability is derived from effective access and historical state.

### 3.3 Deterministic lossless encoding and tree-scoped authorization

The current canonical lossless Wire encoding of an immutable tree snapshot
names a root directory object. This directory-shaped object graph is a
synchronization encoding of accepted tree state, not Arbor's logical node
ontology and not a requirement that every backing be physically directory
shaped. All objects are canonical CBOR addressed by
`sha256:<lowercase-hex>` of their exact bytes. Directories map normalized UTF-8
names to file, directory, nested-tree, or versioned rollup entries. Files
contain exact bytes and media metadata. A rollup entry references its exact
source object, schema fingerprint, provider scope, and authority-derived
logical child/subtree root:

```ts
type RollupDescriptor = {
  version: 1;
  codec: "csv" | "json" | "jsonl";
  source: Hash;
  schemaSource: Hash;
  schema: Hash;
  scope: "children" | "subtree";
  modelDigest: Hash;
};
```

`schemaSource` references the exact `schema.ts` file object. The authority
executes that source through the same restricted application-code runtime used
locally, recomputes `schema`, and never trusts client-asserted compiled
metadata. Schema execution shares the future isolation boundary with SSR,
queries, mutations, and executable documents; it does not require a second
authored schema. The descriptor lets remote resolution, paging, querying, search, and semantic
merge address rolled-up children without converting them into Markdown files
or making the reserved source file a visible row. A decoder recomputes schema
and the codec/schema-scoped `modelDigest` from `source`; a mismatch is invalid.
This is not a universal tree serialization or hash. Exact source bytes and
model-state equivalence remain distinct. Names reject NUL,
slashes, backslashes, dot segments, non-NFC text, and reserved ambiguity.
Directory entries are canonically ordered; decoders reject noncanonical
encodings and hash mismatches.

The reference validation profile bounds one exact file rollup to 16 MiB,
`schema.ts` to 1 MiB, and the normalized row set to 100,000 rows. Authorities
may advertise smaller quotas but never accept a rollup they cannot validate
completely. Semantic merge reports `rollup-row-conflict`,
`rollup-schema-conflict`, or `rollup-constraint-conflict`; a row conflict path
uses the parent logical path plus its `arbor-key` identity suffix.

Database placements may expose the same logical subtree, but they do not use
this exact-source descriptor. Wire database synchronization names committed
logical changes and, when required for resync, a content-addressed canonical
logical checkpoint produced at one database snapshot. Such a checkpoint is an
explicit synchronization artifact, not an ordinary database revision, and
contains no SQLite pages/WAL bytes or Postgres storage representation. Its
change-log/checkpoint format is deferred to Data 005.

Possession of a hash is not authorization. The server checks reachability from
the named tree's current readable root; retained accepted history does not
create historical-object access, and the server must not scan every readable
root.

A nested tree entry is a boundary, not an object copy. Parent reachability stops
there and the child's ref, objects, history, and ACL remain independent.

### 3.4 Authentication and secrets

Authenticated requests use:

```text
Authorization: Bearer <device credential>
Arbor-Access-Link: <access-link secret>
```

The server stores only cryptographic digests and grants the maximum access
of all valid presented subjects. Raw credentials and link secrets never appear
in URLs, redirects, response bodies, errors, logs, refs, objects, YAML, access
lists, or events. Link entries returned to administrators reveal neither secret
nor digest.

A `DeviceID` identifies one credential binding for one account. Deleting its
file from the accepted account configuration atomically revokes the credential
and permanently retires the ID. Credential validity is derived from the current
accepted config root plus server-held digest binding; caller claims do not
authorize a transition.

### 3.5 Errors

The shared error envelope and common codes are normative. Narrow server-only
codes include `already-claimed` and `tree-id-conflict`. Base/update mismatch,
reserved boundaries, policy failures, and merge conflicts use `conflict` with
discriminated `server-update` or `account-configuration` details where
applicable.

## 4. Finding trees

```text
GET /.arbor/health
GET /.arbor/account
GET /.arbor/trees
GET /.well-known/arbor[/{path}]
```

Authenticated account and tree-list reads use explicit envelopes carrying
`observedThrough`; bare arrays and descriptors are not mutable responses. The
same snapshot-then-observe rule as the core tree API applies. For an ordinary
tree, its accepted-update ID is its `observedThrough` cursor unless a later
non-ref event advances that tree's observation stream; `tree.update` remains
the content synchronization base.

Well-known and canonical-path resolution return `LocatorResolution`, using the
longest readable registered boundary. Inaccessible nested boundaries cannot be
read through a parent. The private account-configuration tree is absent from
public discovery and canonical resolution.

## 5. Accounts and devices

### 5.1 Profile claim

```text
PUT /.arbor/claims/{handle}
```

The body names a generated profile `TreeID`, account-configuration `TreeID`,
generated `DeviceID`, device label, device credential digest, initial profile
snapshot, and complete initial configuration snapshot. The configuration
snapshot contains `account.yaml`, `trees.yaml`, and that device's file and
makes the device the first administrator.

The server validates both graphs and atomically creates the profile,
account, public canonical profile boundary and ACL, private config tree,
credential binding, accepted updates, and first administrator. Exact retry is
idempotent. Any different attempt after success returns `already-claimed`. No
response returns a raw device credential.

### 5.2 Device pairing

```text
POST /.arbor/pairings
PUT  /.arbor/pairings/{PairingID}/claim
```

An authenticated device creates a short-lived, single-use pairing secret. The
claimant locally generates a new `DeviceID` and credential, stores the raw
credential immediately, and sends only its digest together with the label,
initial placements, and pairing secret. The server atomically adds the new
device file to the config tree and binds the digest. The new device is ordinary,
not an administrator. Exact claim retry is idempotent; concurrent or expired
reuse fails. No response returns the raw new credential.

## 6. Governing trees

### 6.1 Account-configuration policy

Each account owns one private, noncanonical tree whose closed internal policy
is `account-config-v1`; all other trees use `ordinary`. There is no generic
policy extension framework. The tree uses the ordinary object, snapshot,
accepted-update, merge, replica, and watch machinery.

The complete path and YAML contract is normative in [configuration](05-configuration.md).
For every direct candidate and every automatic merge, the server:

1. authenticates the submitting device using the current accepted root;
2. parses and validates the complete candidate graph and semantic diff;
3. enforces allowed paths and per-device/administrator write rules;
4. rejects `.state`, aliases, duplicate keys, unknown fields, ambiguous IDs,
   and an implicit config-tree declaration or placement; and
5. accepts the new root and applies credential revocation, administrators,
   existing-tree ACLs, and canonical boundaries in one transaction.

Ordinary devices may change only their own device file. Administrators may
change `account.yaml` and `trees.yaml` or delete another device file, but may
not edit another device's placements. Administrators remain a nonempty subset
of active devices. Kind cannot change after activation. A removed active tree
declaration is rejected; removing an uninitialized declaration cancels its
reservation.

Merge is semantic: device files, placements, administrators, tree declarations,
and ACL subjects are independent keys. Disjoint edits merge. Delete versus
unchanged yields delete. Administrator revocation defeats a concurrent edit by
the revoked device. Incompatible same-field edits return `conflict` with exact
typed `account-configuration` details and a private draft snapshot. Resolution
is a later explicit candidate; the accepted YAML contains no markers or
resolution/status field.

### 6.2 Declaring and activating a tree

Adding an unknown client-generated `TreeID` to `trees.yaml` first accepts and
reserves its identity, canonical path, immutable kind, and ACL. Private derived
status becomes `awaiting-initialization`. At least one active administrator's
placements must name it. Pending trees are unreadable, unresolved, and
unattached.

An eligible administrator snapshots its filesystem placement or pathless
replica and calls:

```text
PUT /.arbor/trees/{TreeID}
```

The request contains the complete initial snapshot. The server validates
the graph and applicable profile schema, creates the first accepted update,
applies the declared ACL and parent boundary, marks the tree active, and emits
observation events atomically. First valid activation wins; an identical replay
succeeds and incompatible content is `tree-id-conflict`. Removing the pending
declaration cancels the reservation. Pending, activating, active, and error
status remains derived private state and events, never YAML.

### 6.3 Access

```text
GET /.arbor/trees/{TreeID}/access
```

The response is a snapshot envelope of safe `AccessEntry`s. Steady-state ACL
mutation occurs by editing the authenticated account's `trees.yaml`; there is
no separate access-mutation endpoint. Rules use `everyone`, profile `TreeID`,
or link digest and `read`/`write`. `none` removes a rule and is never stored.
An access-link secret is generated and shown locally once; only its digest is
submitted in configuration.

## 7. Public HTTP projection

Readable canonical paths have safe HTTP and `arbor://` projections. HTML,
Markdown, files, and redirects retain canonical tree/path provenance and never
broaden access. Historical roots remain immutable and read-only. The server
does not publish or resolve the account-configuration tree.

Rows in a recognized synchronized CSV/JSON/JSONL child rollup have the same
ordinary public path and stable-key locator projection as expanded children.
The parent page lists those logical rows rather than `_store.*` or `schema.ts`.
A path lookup or stable-key lookup may render a row as an HTML property page or
a Markdown data projection; a stale readable path redirects permanently to the
current row path while preserving the key, application query, and content
fragment. Public projection never materializes a row as a Markdown file and
never exposes the reserved representation objects as children.

## 8. Conformance

Language-neutral vectors under [`conformance`](../conformance) cover
descriptors, access, errors, resolution, objects, updates, snapshots, SSE
framing/resume, bootstrap idempotency, pairing, configuration merge/governance,
activation, and tree-scoped reachability.
