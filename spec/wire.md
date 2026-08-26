# Arbor Wire API
*Part of the [Arbor spec](../spec.md): the portable wire protocol for community identity, governed configuration, immutable trees, synchronization, executable-document data, access, and observation.*

An Arbor server represents one community. It owns accounts and profile
claims, canonical tree boundaries, the private account-configuration trees,
credential bindings, ACL enforcement, one mutable accepted ref per tree,
immutable objects, and observation streams. It need not implement a local
workspace or UI.

## 1. Shared public contract

The wire owns these transport-neutral values. Language bindings must be equivalent and consume the language-neutral vectors under [`conformance`](../conformance).

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

Server resolution always supplies `enclosingTree`. Ordinary hosted trees
have complete non-null canonical data. The authenticated account-configuration
tree is returned only to its account and has `kind: "account-configuration"`
and `canonical: null`.

Every tree operation, result, event, effect, and relevant error names its `TreeID`. `local` and `system` are not wire values. Writability is derived from effective access and historical state.

The shared error envelope and common codes are normative. Narrow server-only
codes include `already-claimed` and `tree-id-conflict`. Base/update mismatch,
reserved boundaries, policy failures, and merge conflicts use `conflict` with
discriminated `server-update` or `account-configuration` details where
applicable.

## 2. Authentication and secrets

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

## 3. Discovery and mutable snapshots

```text
GET /.arbor/health
GET /.arbor/account
GET /.arbor/trees
GET /.arbor/trees/{TreeID}/ref
GET /.arbor/trees/{TreeID}/snapshot
GET /.arbor/trees/{TreeID}/access
GET /.well-known/arbor[/{path}]
```

Authenticated account, tree-list, ref, access-list, and current-snapshot reads
use explicit envelopes carrying `observedThrough`; bare arrays and descriptors
are not mutable responses. A current snapshot is:

```ts
type CurrentTreeSnapshot = {
  tree: RemoteTreeDescriptor;
  snapshot: TreeSnapshot;
  observedThrough: EventCursor;
};
```

For an ordinary tree, its accepted-update ID is its `observedThrough` cursor
unless a later non-ref event advances that tree's observation stream.
`tree.update` remains the content synchronization base. Account-configuration
activation/status events may advance `observedThrough` without changing the
accepted content update.

Well-known and canonical-path resolution return `LocatorResolution`, using the
longest readable registered boundary. Inaccessible nested boundaries cannot be
read through a parent. The private account-configuration tree is absent from
public discovery and canonical resolution.

## 4. Client-generated identity and bootstrap

New tree IDs are `tr_` plus 26 lowercase base32 characters encoding 128 random
bits. New device IDs use the same encoding after `dv_`. Existing shorter IDs
may remain valid during migration, but activation and pairing require the new
form. Generating an ID neither reserves it nor contacts the server.

### Profile claim

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

### Pairing

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

## 5. Account-configuration policy

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

## 6. Two-stage tree activation

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

## 7. Deterministic objects and tree-scoped authorization

An immutable tree snapshot names a root directory object and all objects are
canonical CBOR addressed by `sha256:<lowercase-hex>` of their exact bytes.
Directories map normalized UTF-8 names to file, directory, or nested-tree
entries. Files contain exact bytes and media metadata. Names reject NUL,
slashes, backslashes, dot segments, non-NFC text, and reserved ambiguity.
Directory entries are canonically ordered; decoders reject noncanonical
encodings and hash mismatches.

```text
GET /.arbor/trees/{TreeID}/objects/{hash}
```

Possession of a hash is not authorization. The server first verifies read
access to the named tree, then checks reachability from that tree's retained
authorized roots. It must not scan every readable root. Immutable object and
byte responses need no independent observation cursor and use immutable cache
headers and the hash as ETag.

A nested tree entry is a boundary, not an object copy. Parent reachability stops
there and the child's ref, objects, history, and ACL remain independent.

## 8. Update submission and convergence

```text
POST /.arbor/trees/{TreeID}/updates
```

An update names the exact retained `{ update, root }` base, candidate root,
tree, and required canonical objects. The server verifies graph completeness,
hashes, schema, access, and boundaries. If base is current it accepts; for
one-sided change it fast-forwards; for safely disjoint edits it performs the
sole authoritative three-way merge. Unsafe overlap returns a complete
client-owned typed conflict draft and does not advance accepted state or retain
the rejected candidate as history.

Semantic request identity is the SHA-256 of RFC 8785 canonical JSON for
`{ version: "updates-v1", tree, base, candidate }`, scoped to the authenticated
credential. Transport object ordering and optional verified file-patch
representations are excluded. Exact semantic replay returns the original
accepted result without another update. Clients persist the base, candidate,
required objects, and any received conflict before acknowledgement.

Successful update responses return the descriptor, resulting snapshot when
requested, semantic request digest, merge summary, and `observedThrough`.
For ordinary ref changes the accepted update is the observation cursor.

A verified UTF-8 file-patch transport extension may reconstruct a named
candidate file from a retained reachable base file using sorted simultaneous
byte replacements. The server hash-verifies the reconstructed canonical
file object and otherwise treats it exactly like supplied complete bytes. This
is an optimization only; it does not alter semantic request identity, merge
ownership, or the requirement that complete immutable content be provable.

## 9. Access

```text
GET /.arbor/trees/{TreeID}/access
```

The response is a snapshot envelope of safe `AccessEntry`s. Steady-state ACL
mutation occurs by editing the authenticated account's `trees.yaml`; there is
no separate access-mutation endpoint. Rules use `everyone`, profile `TreeID`,
or link digest and `read`/`write`. `none` removes a rule and is never stored.
An access-link secret is generated and shown locally once; only its digest is
submitted in configuration.

## 10. Snapshot then observe

```text
GET /.arbor/trees/{TreeID}/watch?after={cursor}
Last-Event-ID: {cursor}
```

Clients read a current snapshot and observe strictly after its
`observedThrough`. `after` and `Last-Event-ID` are equivalent; differing values
are `invalid-request`. The stream is UTF-8 SSE with blank-line frame separation,
newline joining of multiple `data:` lines, and ignored comments/keepalives.
Every frame satisfies `id === data.cursor` and `event === data.kind` and its
JSON body is:

```ts
type ObservationEvent<TKind extends string, TChange> = {
  cursor: EventCursor;
  tree: TreeID;
  kind: TKind;
  change: TChange;
};
```

Accepted ordinary refs use domain event kind `tree.ref`; account status and
activation use their own kinds and may advance the stream without changing the
accepted content update. A non-retained cursor yields one terminal
`resync-required` event and closes. A client then reads a new snapshot and
resumes after its cursor. Watch events are invalidations/changes, not substitute
snapshots.

## 11. Executable-document data and effects

An execution host may serve a reviewed [executable document](executable-documents.md) while its permitted data lives on the same or another Arbor server. The wire carries only validated public query results and mutation calls; raw stores, credentials, private handler source, diagnostics containing private values, and unrelated rows do not cross the disclosure boundary.

A live client makes one streaming HTTP request that completely describes the document and its currently mounted query graph. The response lifetime is the subscription lifetime. When the graph changes, the client opens a complete replacement request and may retain the old response only until the replacement becomes ready.

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

The query array is nonempty and its IDs are nonempty and unique within the request. The host verifies the coherent document version, reviewed handle membership, input schema, authenticated user context, effective access, and current backing identities. A `knownOutputHash` suppresses bytes only; it is not authorization or evidence of current state. Output hashes are SHA-256 of RFC 8785 canonical JSON for the complete public result.

The UTF-8 SSE response has these semantic event values:

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

The SSE `event` field supplies `type`; JSON `data` supplies the remaining members. Results are complete replacements. `ready` is sent only after every query has established a race-free snapshot-then-follow boundary. Before it, changed hashes produce complete `result` values; an unchanged retained value may be confirmed by its hash in `ready`. Identical output hashes produce no payload.

The stream has no durable execution ID, acknowledgement, replay cursor, or resumable server-side subscription. Reconnection repeats and reauthorizes the complete request. Source or access changes send `reload` when possible and close the stream. Listener loss, backing uncertainty, process restart, or irrecoverable backpressure closes the response rather than publishing a result known to be stale. Hosts may coalesce intermediate replacement states but raw driver changes never enter the stream.

Mutation calls carry the reviewed handle identity and version, validated input, authenticated subject, and caller-stable mutation identity. Expected failures expose only stable safe public errors; other failures are sanitized. An exact ambiguous retry reuses the mutation identity. The durable receipt and corresponding query result may arrive in either order, and clients correlate them idempotently while treating the query result as authoritative.

Executable-document execution does not grant historical-object access or broaden the readable tree graph. A tree mutation advances its ordinary accepted ref; a mutation against an external store may update query results without changing the source tree ref. Cross-server query discovery, delegated authorization, and server-to-server execution routing remain unspecified; network reachability alone never grants authority.

## 12. Public projection and conformance

Readable canonical paths have safe HTTP and `arbor://` projections. HTML,
Markdown, files, and redirects retain canonical tree/path provenance and never
broaden access. Historical roots remain immutable and read-only. The server
does not publish or resolve the account-configuration tree.

Language-neutral vectors under [`conformance`](../conformance) cover descriptors, access, errors, resolution,
objects, updates, snapshots, SSE framing/resume, bootstrap idempotency, pairing,
configuration merge/governance, activation, and tree-scoped reachability.
