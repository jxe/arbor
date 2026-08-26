# Arbord REST v1
*Part of the [Arbor spec](../spec.md): the loopback contract for explicit-scope resolution, reads, authored mutations, account bootstrap, and observation.*

Arbord binds to loopback and rejects cross-origin browser requests. JSON is
UTF-8. Request URLs never contain credentials or access-link secrets.

## 1. Shared values

REST v1 uses the transport-neutral types also used by [the wire](wire.md):

```ts
type TreeID = string;
type TreeRef = "local" | "system" | TreeID;
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

type LocalTreeDescriptor = TreeDescriptor & {
  name: string;
  placement: "placed" | "replica" | "remote";
  osPath?: string;
  sync?: "idle" | "syncing" | "offline" | "conflict" | "error";
  missing?: boolean;
};

type RemoteTreeDescriptor = TreeDescriptor & {
  ref: Hash;
  update: string;
};
```

Only actual Arbor `TreeID`s receive descriptors. `local` and `system` are
explicit scopes, not pretend trees. Hosted ordinary trees have non-null
canonical data; the private account-configuration tree has `canonical: null`.

Every `NodeRef`, structural or content operation, result, event, effect, and
relevant error names its tree explicitly. Omitted-tree defaults are invalid.

```ts
type NodeRef =
  | { tree: TreeRef; path: LogicalPath }
  | { tree: TreeRef; pageID: string; pathHint?: LogicalPath };

type ResolvedNodeRef = {
  tree: TreeRef;
  path: LogicalPath;
  pageID?: string;
};

type LocatorResolution = {
  ref: ResolvedNodeRef;
  enclosingTree?: TreeDescriptor;
  historical: boolean;
  observedThrough: EventCursor;
};
```

Arbord includes `enclosingTree` for Arbor trees and omits it for `local` and
`system`. Clients derive writability from effective access and historical state;
resolution does not duplicate a `writable` flag.

## 2. Access and errors

Configuration and mutation requests use rules; safe administrative responses
use entries:

```ts
type AccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID }
  | { kind: "link"; digest: Hash };

type AccessRule = { subject: AccessSubject; access: ReadWriteAccess };

type SafeAccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID; locator?: string }
  | { kind: "link" };

type AccessEntry = {
  id: string;
  subject: SafeAccessSubject;
  access: ReadWriteAccess;
};
```

`none` means removal and is not a stored rule. A link entry exposes neither raw
secret nor digest.

Every non-2xx JSON error uses:

```ts
type ArborError<TDetails = unknown> = {
  error: string;
  message: string;
  retryable: boolean;
  tree?: TreeRef;
  path?: LogicalPath;
  details?: TDetails;
};
```

Shared codes are `invalid-request`, `unauthenticated`, `permission-denied`,
`not-found`, `conflict`, `read-only`, `unsupported-operation`,
`resync-required`, `rate-limited`, `quota-exceeded`, and `internal-error`.
Conflict details are discriminated as `authority-update`,
`workspace-revision`, or `account-configuration`; domain-specific fields live
inside `details`, not alongside the envelope. Clients tolerate unknown codes
and fields but never reinterpret malformed required data.

## 3. Status, trees, and resolution

```text
GET  /v1/status
POST /v1/tree-ids
GET  /v1/trees
GET  /v1/resolve?locator={ArborLocator}
```

Status returns the service and protocol versions plus the current `DeviceID`
when connected. `POST /v1/tree-ids` returns an unreserved client-generated
`{ id }`; it edits no file and reserves no authority state. New IDs are `tr_`
plus 26 lowercase base32 characters encoding 128 random bits.

`GET /v1/trees` returns `{ snapshot: LocalTreeDescriptor[], observedThrough }`.
It includes placed trees, pathless replicas, known remote placements, and the
implicit authenticated account-configuration tree. It never invents a
descriptor for `local` or `system`.

Resolution returns `LocatorResolution`. A remote unplaced result is read
transiently using its explicit tree and authority; it does not create a virtual
tree, placement, or directory.

## 4. Node reads

```text
GET /v1/node?tree={TreeRef}&path={path}[&pageID={id}][&revision={hash}]
GET /v1/file?tree={TreeRef}&path={path}[&revision={hash}]
GET /v1/children?tree={TreeRef}&path={path}[&revision={hash}][&cursor={cursor}]
GET /v1/search?tree={TreeRef}&q={query}[&cursor={cursor}]
GET /v1/backlinks?tree={TreeRef}&path={path}[&pageID={id}][&cursor={cursor}]
GET /v1/collection?tree={TreeRef}&path={path}[&table={name}][&cursor={cursor}]
GET /v1/recovery?tree={TreeRef}[&path={path}][&recursive=true][&cursor={cursor}]
```

Every route requires `tree`, even where it is `local` or `system`. Logical
paths are decoded exactly once. Revision reads are immutable and read-only.
Mutable JSON reads include `observedThrough`; lists and bare arrays use explicit
snapshot/page envelopes. `GET /v1/file` returns exact bytes and does not need an
independent cursor because its guarding content revision is obtained from the
node snapshot.

Directory source and logical-node rules are defined in [format.md](format.md).
Children, search, backlinks, collections, recovery entries, mounted boundaries,
events, and effects all retain explicit tree scope.

## 5. Authored mutations

```text
POST /v1/mutations
POST /v1/assets
POST /v1/imports
```

`/v1/mutations` accepts `{ mutationID, operations }`. `mutationID` is a stable
client-generated idempotency identity for one exact serialized intent.
Operations include ordinary content and structural actions: `writeText`,
`writeMarkdown`, `create`, `move`, `copy`, `trash`, `restore`, and supported
collection mutations. Each operation includes explicit tree-scoped references
and the appropriate content or directory base revision.

`writeText` is the exact guarded UTF-8 operation for ordinary files such as the
configuration YAML:

```ts
type WriteText = {
  op: "writeText";
  ref: { tree: TreeRef; path: LogicalPath };
  baseContentRevision: string;
  source: string;
};
```

Arbord rejects `writeText` for non-UTF-8 content, protected private state,
historical reads, and stale revisions. A successful edit of account YAML is an
ordinary file edit locally; configuration governance is applied when the
candidate account-tree update is synchronized.

Markdown writes submit the complete operational source and its exact
`baseContentRevision`. Optional ordered nonoverlapping UTF-8 source edits may
prove editor provenance, but the complete source remains authoritative.
Structural operations guard the relevant directory revisions. Multipart assets
and imports contain explicit destination `NodeRef`s and are idempotent under the
same mutation identity rules.

A successful receipt includes the mutation identity, committed tree-scoped
result/effects, and `observedThrough`. Acknowledgement means the authored intent
and eventual receipt are crash-recoverable. An exact replay returns the same
receipt. Reusing an ID for different bytes is `conflict`; ambiguous transport
failure permits only exact replay.

Steady-state placement, ACL, canonical-boundary, profile/community,
administrator, and device-revocation changes are not special arbord mutations.
Human clients and the CLI perform source-preserving transformations of
`account.yaml`, `trees.yaml`, or the authorized device file. REST v1 therefore
has no `connectCommunity`, `disconnectCommunity`, `createGroupProfile`,
`promoteTree`, `placeTree`, `removeTreePlacement`, `setTreeAccess`, local device
list/revoke proxy, or `/v1/remote` route.

## 6. Bootstrap and local recovery

Narrow operations remain for states that cannot yet be represented by editing
an authenticated configuration tree:

```text
POST /v1/bootstrap/claims
POST /v1/bootstrap/pairings
POST /v1/local/forget
POST /v1/conflicts/{TreeID}/resolve
```

Claim bootstrap generates the profile, configuration, and device identities
and device credential locally, stores the raw credential immediately in the OS
credential store, constructs the initial snapshots, and calls the authority
claim endpoint. It is restart-idempotent and never rewrites user-authored YAML
to insert IDs or normalize it. Pairing creates or claims the authority pairing
while similarly keeping the raw new-device credential local. Local forget
disconnects this data home without revoking the authority device or deleting
user files. Typed conflict resolution names an exact stored private conflict
identity and never adds a resolution field to YAML.

## 7. Snapshot then observe

All mutable snapshots establish an observation boundary. Clients first read a
snapshot and then observe strictly after its cursor:

```ts
type ObservationEvent<TKind extends string, TChange> = {
  cursor: EventCursor;
  tree: TreeRef;
  kind: TKind;
  change: TChange;
};
```

```text
GET /v1/events?after={cursor}
Last-Event-ID: {cursor}
```

`after` and `Last-Event-ID` are equivalent; supplying both with different
values is `invalid-request`. The stream is UTF-8 SSE. Frames are separated by a
blank line; multiple `data:` lines join with newline; comments and keepalives
are ignored. Every semantic frame satisfies `id === data.cursor` and
`event === data.kind`. Events invalidate or describe domain-specific local
changes but do not replace a confirming snapshot.

If a cursor is no longer replayable, arbord sends one terminal
`resync-required` event using the same envelope and closes. The client reads a
fresh snapshot and resumes after its cursor. This guarantees no gap between the
snapshot and following stream.

Local workspace events and authority accepted-update events deliberately keep
different `kind` and `change` payloads. Sharing the observation framing does
not claim the domain events are identical.

## 8. Conformance

Implementations consume the language-neutral valid/invalid JSON, error,
descriptor, resolution, and SSE fixtures under [`spec/fixtures`](fixtures).
Conformance includes mandatory explicit tree scope, write guards, exact replay,
snapshot/SSE gap freedom, multiline data, keepalives, conflicting-cursor
rejection, and terminal resynchronization.
