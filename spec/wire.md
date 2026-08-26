# Arbor wire protocol
*Part of the [Arbor spec](../spec.md): community identity, governed account configuration, immutable trees, synchronization, access, and observation.*

An Arbor authority represents one community. It owns accounts and profile
claims, canonical tree boundaries, the private account-configuration trees,
credential bindings, ACL enforcement, one mutable accepted ref per tree,
immutable objects, and observation streams. It need not implement a local
workspace or UI.

## 1. Shared public contract

The wire uses the `TreeID`, `TreeRef`, `TreeKind`, `TreeDescriptor`,
`RemoteTreeDescriptor`, `AccessRule`, `AccessEntry`, `LocatorResolution`,
`ArborError`, and `ObservationEvent` definitions in [REST v1](arbord-rest.md).
Language bindings must be equivalent, and TypeScript and Swift consume the same
language-neutral fixtures.

Authority resolution always supplies `enclosingTree`. Ordinary hosted trees
have complete non-null canonical data. The authenticated account-configuration
tree is returned only to its account and has `kind: "account-configuration"`
and `canonical: null`.

Every tree operation, result, event, effect, and relevant error names its tree.
The authority does not accept `local` or `system`; those scopes exist only at
arbord. Writability is derived from effective access and historical state.

The shared error envelope and common codes are normative. Narrow authority-only
codes include `already-claimed` and `tree-id-conflict`. Base/update mismatch,
reserved boundaries, policy failures, and merge conflicts use `conflict` with
discriminated `authority-update` or `account-configuration` details where
applicable.

## 2. Authentication and secrets

Authenticated requests use:

```text
Authorization: Bearer <device credential>
Arbor-Access-Link: <access-link secret>
```

The authority stores only cryptographic digests and grants the maximum access
of all valid presented subjects. Raw credentials and link secrets never appear
in URLs, redirects, response bodies, errors, logs, refs, objects, YAML, access
lists, or events. Link entries returned to administrators reveal neither secret
nor digest.

A `DeviceID` identifies one credential binding for one account. Deleting its
file from the accepted account configuration atomically revokes the credential
and permanently retires the ID. Credential validity is derived from the current
accepted config root plus authority-held digest binding; caller claims do not
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
form. Generating an ID neither reserves it nor contacts the authority.

### Profile claim

```text
PUT /.arbor/claims/{handle}
```

The body names a generated profile `TreeID`, account-configuration `TreeID`,
generated `DeviceID`, device label, device credential digest, initial profile
snapshot, and complete initial configuration snapshot. The configuration
snapshot contains `account.yaml`, `trees.yaml`, and that device's file and
makes the device the first administrator.

The authority validates both graphs and atomically creates the profile,
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
initial placements, and pairing secret. The authority atomically adds the new
device file to the config tree and binds the digest. The new device is ordinary,
not an administrator. Exact claim retry is idempotent; concurrent or expired
reuse fails. No response returns the raw new credential.

## 5. Account-configuration policy

Each account owns one private, noncanonical tree whose closed internal policy
is `account-config-v1`; all other trees use `ordinary`. There is no generic
policy extension framework. The tree uses the ordinary object, snapshot,
accepted-update, merge, replica, and watch machinery.

The complete path and YAML contract is normative in [system.md](system.md).
For every direct candidate and every automatic merge, the authority:

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

The request contains the complete initial snapshot. The authority validates
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

Possession of a hash is not authorization. The authority first verifies read
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
tree, and required canonical objects. The authority verifies graph completeness,
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
byte replacements. The authority hash-verifies the reconstructed canonical
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

## 11. Public projection and conformance

Readable canonical paths have safe HTTP and `arbor://` projections. HTML,
Markdown, files, and redirects retain canonical tree/path provenance and never
broaden access. Historical roots remain immutable and read-only. The authority
does not publish or resolve the account-configuration tree.

Language-neutral fixtures cover descriptors, access, errors, resolution,
objects, updates, snapshots, SSE framing/resume, bootstrap idempotency, pairing,
configuration merge/governance, activation, and tree-scoped reachability.
TypeScript `@arbor/wire`, Swift `ArborWire`, and Swift `ArborClient` consume the
same valid and invalid cases.
