# Arbor Wire API
*Part of the [Arbor spec](../spec.md): the portable wire protocol for community identity, governed configuration, immutable trees, synchronization, executable-document data, access, and observation.*

An Arbor server represents one community. It owns accounts and profile
claims, canonical tree boundaries, the private account-configuration trees,
credential bindings, ACL enforcement, one mutable accepted ref per tree,
immutable objects, and observation streams. It need not implement a local
workspace or UI.

## 1. Core data API

The core wire API has two data paths:

1. **Durable tree state** is read as an immutable snapshot, changed by
   submitting a candidate graph, and followed through an ordered watch stream.
2. **Derived query state** is read and followed through one stateless streaming
   request whose results are complete public replacements.

The first path is the storage and synchronization substrate. The second lets an
executable document expose live, permissioned results without exposing its raw
store. Identity, bootstrap, governed configuration, activation, and access
management use these same primitives but are described after the core paths.

### 1.1 Read durable tree state

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

The descriptor's `ref` is the current accepted root and its `update` is the
accepted-update ID that produced that root. `observedThrough` is the cursor
after which a client can begin watching without a read/watch race.

`GET .../snapshot` is the self-contained current-state read:

```ts
type TreeSnapshot = {
  root: Hash;
  objects: Array<{ hash: Hash; bytes: string }>;
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

`GET .../objects/{hash}` returns the exact canonical CBOR bytes for one object.
It uses `application/vnd.ipld.dag-cbor`, an ETag equal to the quoted hash, and
immutable cache headers. Possession of a hash is not authorization: the object
must be reachable from the current readable root of the named tree. Retained
accepted history does not create historical-object access. A snapshot is the
ordinary bootstrap and resynchronization read; the object endpoint is useful
for incremental graph traversal.

All three routes require read access. The ref and snapshot responses are
mutable observations and therefore carry `observedThrough`; immutable object
bytes do not need an independent observation cursor.

### 1.2 Submit durable tree changes

```text
POST /.arbor/trees/{TreeID}/updates
Content-Type: application/json
```

The client submits one complete candidate state against the exact accepted base
it previously observed:

```ts
type FilePatch = {
  base: Hash;
  result: Hash;
  edits: Array<{
    offset: number;
    length: number;
    bytes: string;
  }>;
};

type UpdateRequest = {
  base: {
    root: Hash;
    update: string;
  };
  candidate: Hash;
  objects: Array<{
    hash: Hash;
    bytes: string;
  }>;
  filePatches?: FilePatch[];
  returnSnapshot?: true | "if-result-differs";
};
```

`base.root` and `base.update` bind reconciliation to one retained accepted
event, including the case where the same root appears again later. `candidate`
names the desired complete root. `objects` supplies canonical CBOR objects the
server does not already retain; a client normally walks base and candidate
together and omits unchanged objects. The candidate must still be complete and
provable from retained base objects, supplied objects, and valid `filePatches`.

The optional file-patch representation reconstructs a changed UTF-8 file
without retransmitting its complete file object. Each edit addresses bytes in
the decoded `file.bytes`, not CBOR offsets, Unicode scalars, or editor blocks.
Offsets and lengths are nonnegative safe JSON integers. Edits are nonempty,
sorted by ascending offset, non-overlapping, in bounds, and applied
simultaneously to the unmodified base payload. Replacement bytes use canonical
padded base64.

The patch's `base` must be a file object reachable from the request's retained
`base.root`. The server hash-verifies that object, applies the edits, canonically
encodes the resulting file object, and requires its hash to equal `result`.
It then treats that object exactly as if its complete bytes had appeared in
`objects`. Duplicate patch results, a result also supplied as a complete object,
noncanonical base64, overlapping edits, arithmetic overflow, and quota excess
are invalid. New files and unsuitable or larger patches use complete objects.

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
};

type MergeSummary =
  | { version: "markdown-additive-v1"; approximatePlacements: number }
  | { version: "account-config-v1"; mergedFields: number };

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
credential. `objects`, `filePatches`, their ordering, and `returnSnapshot` are
transport choices and are excluded. An ambiguous retry may therefore replace a
patch with complete bytes without changing identity. Exact accepted or merged
replay returns the original result and creates no duplicate accepted update.
Clients durably retain the base, candidate, required content, and any conflict
draft until the result has been applied.

### 1.3 Patch push and watch roundtrip

A small editor change normally completes this end-to-end path:

1. The client first makes the edit durable locally and records the accepted
   `{ root, update }` from which it was made.
2. It builds the new candidate graph. Unchanged objects are omitted; the
   changed file may be represented by `filePatches`, while changed ancestor
   directory objects are sent in `objects`.
3. It posts the candidate with
   `returnSnapshot: "if-result-differs"`. A patch is only a compact transport
   for the named candidate and never a partially applied tree mutation.
4. The server reconstructs and hash-verifies the file, validates the complete
   candidate, performs any required merge, atomically records one accepted
   update, and returns its accepted-update record, request digest, and
   `observedThrough`.
5. The same accepted update appears on every open authorized tree watch as a
   `tree.ref` event whose `cursor` and descriptor `update` equal that accepted
   update ID. For the exact bearer credential that submitted it, the event's
   change may also contain the same `requestDigest`; other readers never see
   that correlation value.
6. The submitting client treats the response and watch event idempotently. It
   must not create another local edit or accepted base merely because both
   arrive. Other clients use the event as an invalidation: a clean replica reads
   the coherent snapshot, while a replica with local changes submits its own
   candidate for reconciliation.

Local durability therefore precedes network acknowledgement, the server
accepts complete graph states rather than imperative edit commands, and watch
publishes only accepted state. A rejected conflict never appears on watch.

### 1.4 Observe accepted tree changes

```text
GET /.arbor/trees/{TreeID}/watch?after={cursor}
Last-Event-ID: {cursor}
Accept: text/event-stream
```

The client reads a ref or snapshot and then observes strictly after its
`observedThrough`. `after` and `Last-Event-ID` are equivalent; supplying both
with different values is `invalid-request`. The response is UTF-8 SSE with
blank-line frame separation, newline joining of multiple `data:` lines, and
ignored comments and keepalives.

Every frame satisfies `id === data.cursor` and `event === data.kind`. Its JSON
body is:

```ts
type TreeRefEvent = {
  cursor: EventCursor;
  tree: TreeID;
  kind: "tree.ref";
  change: {
    descriptor: RemoteTreeDescriptor;
    requestDigest?: Hash;
  };
};
```

For `tree.ref`, `change.requestDigest` is present only when the stream is
authenticated by the exact bearer credential that submitted the accepted
request. It is correlation data, not authority. Account status and activation
use their own kinds and may advance the observation stream without changing the
accepted content update. Watch events are ordered changes and invalidations,
not substitute snapshots. A non-retained cursor produces one terminal
`resync-required` event and closes; the client reads a new snapshot and resumes
after its cursor.

Tree watch and query result streams use one SSE framing rule: `event` names the
typed event and `data` is one canonical JSON value. Producers use the same
escaping, cancellation, bounded-buffer, and terminal-close behavior. This is a
transport reconciliation, not a cursor reconciliation. A tree watch additionally
sets replayable `id` and carries the complete `ObservationEvent`; a query stream
deliberately omits `id`, sends the remaining members of its event after `type`,
and establishes current derived state with `ready`. `Last-Event-ID`, retained
history, and `resync-required` therefore remain watch-only concepts.

### 1.5 Stream live query updates

```text
POST /.arbor/query-stream
Content-Type: application/json
Accept: text/event-stream
```

An execution host may serve a reviewed [executable document](executable-documents.md)
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

type QueryStreamRequest = {
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

The query array is nonempty and its IDs are nonempty and unique within this
request. The host verifies the coherent document version, reviewed handle
membership, input schema, authenticated user context, effective access, and
current backing identities. A `knownOutputHash` permits omission of unchanged
bytes only after fresh authorization and reevaluation; it is neither
authorization nor evidence of current state. Output hashes are SHA-256 of RFC
8785 canonical JSON for the complete public result.

The UTF-8 SSE response has these semantic events:

```ts
type PublicQueryError = {
  code: string;
  message: string;
  retryable: boolean;
};

type QueryStreamEvent =
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

The response lifetime is the subscription lifetime. There is no durable
execution ID, acknowledgement, SSE replay cursor, or resumable server-side
subscription. Reconnection repeats and reauthorizes the complete POST. When the
mounted query graph changes, the client opens a complete replacement request
and retains the old response only until the replacement sends `ready`. Source
or access changes send `reload` when possible and close. Listener loss, backing
uncertainty, process restart, or irrecoverable backpressure closes rather than
publishing a result known to be stale; hosts may coalesce intermediate complete
states.

Mutation calls carry the reviewed handle identity and version, validated input,
authenticated subject, and caller-stable mutation identity:

```ts
type MutationCallRequest = {
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
  result: Result;
};
```

The host validates the document/handle versions and input before opening the
store. Mutation semantic identity is the SHA-256 of RFC 8785 canonical JSON for
`{ version: "mutation-call-v1", handle, input }`. Durable lookup is scoped by
the source tree, authenticated subject, and `mutationID`. Reusing that identity
with a different request digest is a conflict; an exact ambiguous retry returns
the original receipt and creates no second effect. This is the same committed-
intent pattern as an accepted tree update: transport representation is excluded
from the semantic digest, the subject scopes replay, and the receipt identifies
the committed observation boundary. The mutation payload and transaction domain
remain distinct from `UpdateRequest`; SQLite rows are never represented as
`filePatches` or exposed as tree-object transport.

This version does not assign the mutation envelope a standalone HTTP path.
Document React Actions and named-call adapters bind it to a host after compiler
manifests exist; both must preserve this exact request/receipt identity.
The durable receipt and corresponding query result may arrive in either order;
clients correlate them idempotently and treat the query result as authoritative.

Query streaming is derived-result delivery, not tree history. A mutation of an
Arbor tree advances its ordinary accepted ref and may therefore also cause a
`tree.ref` watch event. A mutation of an external store can update query results
without changing the document's source-tree ref. Neither execution nor network
reachability grants historical-object access, broadens the readable tree graph,
or exposes raw stores, credentials, private handler source, unrelated rows, or
private diagnostics. Cross-server query discovery, delegated authorization,
and server-to-server execution routing remain unspecified.

## 2. Protocol conventions

These conventions apply across the core data API and the administrative
endpoints that follow.

### 2.1 Shared values and descriptors

The wire owns these transport-neutral values. Language bindings must be
equivalent and consume the language-neutral vectors under
[`conformance`](../conformance).

```ts
type TreeID = string;
type LogicalPath = string;
type EventCursor = string;
type Hash = `sha256:${string}`;
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
  ref: { tree: TreeID; path: LogicalPath; pageID?: string };
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
```

New tree IDs are `tr_` plus 26 lowercase base32 characters encoding 128 random
bits. New device IDs use the same encoding after `dv_`. Existing shorter IDs
may remain valid during migration, but activation and pairing require the new
form. Generating an ID neither reserves it nor contacts the server.

Server resolution always supplies `enclosingTree`. Ordinary hosted trees
have complete non-null canonical data. The authenticated account-configuration
tree is returned only to its account and has `kind: "account-configuration"`
and `canonical: null`.

Every tree operation, result, event, effect, and relevant error names its `TreeID`. `local` and `system` are not wire values. Writability is derived from effective access and historical state.

### 2.2 Deterministic objects and tree-scoped authorization

An immutable tree snapshot names a root directory object and all objects are
canonical CBOR addressed by `sha256:<lowercase-hex>` of their exact bytes.
Directories map normalized UTF-8 names to file, directory, or nested-tree
entries. Files contain exact bytes and media metadata. Names reject NUL,
slashes, backslashes, dot segments, non-NFC text, and reserved ambiguity.
Directory entries are canonically ordered; decoders reject noncanonical
encodings and hash mismatches.

Possession of a hash is not authorization. The server checks reachability from
the named tree's current readable root; retained accepted history does not
create historical-object access, and the server must not scan every readable
root.

A nested tree entry is a boundary, not an object copy. Parent reachability stops
there and the child's ref, objects, history, and ACL remain independent.

### 2.3 Authentication and secrets

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

### 2.4 Errors

The shared error envelope and common codes are normative. Narrow server-only
codes include `already-claimed` and `tree-id-conflict`. Base/update mismatch,
reserved boundaries, policy failures, and merge conflicts use `conflict` with
discriminated `server-update` or `account-configuration` details where
applicable.

## 3. Finding trees

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

## 4. Accounts and devices

### 4.1 Profile claim

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

### 4.2 Device pairing

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

## 5. Governing trees

### 5.1 Account-configuration policy

Each account owns one private, noncanonical tree whose closed internal policy
is `account-config-v1`; all other trees use `ordinary`. There is no generic
policy extension framework. The tree uses the ordinary object, snapshot,
accepted-update, merge, replica, and watch machinery.

The complete path and YAML contract is normative in [configuration](configuration.md).
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

### 5.2 Declaring and activating a tree

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

### 5.3 Access

```text
GET /.arbor/trees/{TreeID}/access
```

The response is a snapshot envelope of safe `AccessEntry`s. Steady-state ACL
mutation occurs by editing the authenticated account's `trees.yaml`; there is
no separate access-mutation endpoint. Rules use `everyone`, profile `TreeID`,
or link digest and `read`/`write`. `none` removes a rule and is never stored.
An access-link secret is generated and shown locally once; only its digest is
submitted in configuration.

## 6. Public HTTP projection

Readable canonical paths have safe HTTP and `arbor://` projections. HTML,
Markdown, files, and redirects retain canonical tree/path provenance and never
broaden access. Historical roots remain immutable and read-only. The server
does not publish or resolve the account-configuration tree.

## 7. Conformance

Language-neutral vectors under [`conformance`](../conformance) cover
descriptors, access, errors, resolution, objects, updates, snapshots, SSE
framing/resume, bootstrap idempotency, pairing, configuration merge/governance,
activation, and tree-scoped reachability.
