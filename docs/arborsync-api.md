# Local Arbor REST API
*Reference API for the current local daemon and its TypeScript and Swift clients. It is not part of the portable Arbor specification.*

The current version is Arbor Sync REST v1.

Arbor Sync binds to loopback and rejects cross-origin browser requests. JSON is
UTF-8. It rejects non-loopback `Host` headers so DNS rebinding cannot turn an
attacker-controlled origin into a local file reader. Request URLs never contain
credentials or access-link secrets.

**REST v1 is a control surface, not an editor path.** The daemon is the
placed folder's synchronization client plus the loopback services a
working-tree client needs: `GET /v1/status`, `GET /v1/trees`,
`GET /v1/accounts`, `GET /v1/resolve`, `GET /v1/conflicts` and
`POST /v1/conflicts/resolve`, `POST /v1/sync`, `POST /v1/placements/move`,
`GET /v1/bootstrap` and `GET /v1/credential` (§3b),
`GET /v1/objects/{hash}` (§3a), the account bootstrap routes (§4), and
`GET /v1/events` (§5). The Swift package `ArborSyncClient` launches or
attaches to the control-mode daemon (`arborsync --control`) and uses exactly
these routes. The former node, children, search, backlinks, recovery, file,
mutation, document-admission, asset, and import routes were deleted with the
daemon's editor path (Native 022 Phase 7): editors run the document admission
and update machines against their own working tree. Those paths now answer
`405 unsupported-operation` like any unknown `/v1/` route. **The web editor is
unavailable until Plan B** rebuilds it as a working-tree client; app routes
serve a short notice instead of the bundle, while static hosting of tree files
at OS-shaped routes (§6) continues.

## 1. Shared values

REST v1 reuses the portable model, read, locator, access, update, and
observation values defined across the specification. In particular,
`TreeID`, `LogicalPath`, `JSONValue`, and `NodeRef` come from the
[Arbor data model](../spec/01-tree-operations.md#the-arbor-data-model), while
`EventCursor`, `Hash`, `AccessLevel`, `TreeKind`, `TreeDescriptor`, and
`RemoteTreeDescriptor` come from the
[current-tree read](../spec/01-tree-operations.md#111-reading-the-current-tree).
REST v1 adds the following local values:

```ts
// Only actual Arbor TreeIDs name a scope; the former `local` and `system`
// scopes went with the editor path.
type TreeRef = TreeID;

type Diagnostic = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  path?: LogicalPath;
  row?: number;
  field?: string;
};

type LocalTreeDescriptor = TreeDescriptor & {
  // The accepted Canopy base this placement derives from: the same `root`
  // and `update` a Wire RemoteTreeDescriptor carries, absent until one exists.
  root?: Hash;
  update?: string;
  name: string;
  placement: "placed" | "replica" | "remote";
  osPath?: string;
  sync?: "idle" | "syncing" | "offline" | "conflict" | "error";
  reviewableConflict?: boolean;
  missing?: boolean;
};

type LocatorResolution = {
  ref: NodeRef;
  enclosingTree?: TreeDescriptor;
  historical: boolean;
  observedThrough: EventCursor;
};
```

- Arbor Sync speaks the Wire vocabulary wherever the two overlap. `TreeDescriptor`,
  `LocatorResolution`, `PairingOffer`, `LocalAccountSummary`, and
  `ProfileIdentity` are single definitions in `@arbor/core` (Swift:
  `ArborWire` and `ArborSyncClient` share `WireCanonicalDescriptor`); a
  local descriptor adds only what a local daemon knows.
- `GET /v1/trees` returns `LocalTreeDescriptor`s. Hosted ordinary trees have
  non-null canonical data and the private account-configuration tree has
  `canonical: null`.
- `LocatorResolution.enclosingTree` is present whenever the daemon knows the
  tree locally; on the wire it is always present.

Every `NodeRef`, event, effect, and relevant error names its tree explicitly.
Omitted-tree defaults are invalid. Clients derive writability from effective
access and historical state; resolution does not duplicate a `writable` flag.

## 2. Access and errors

Access subjects, levels, and the `none` removal rule are defined once in
[configuration](../spec/04-accounts-and-devices.md#3-configuration-yaml). Configuration
and mutation requests use the wire's `AccessRule`; safe administrative
responses use `AccessEntry`, whose link subject exposes neither raw secret nor
digest ([access control §1](../spec/05-access-control.md#1-subjects-and-rules)).

Every non-2xx JSON error uses the wire's `ArborError` envelope with
`tree?: TreeRef`. Shared codes are `invalid-request`, `unauthenticated`,
`permission-denied`, `not-found`, `conflict`, `read-only`,
`unsupported-operation`, `resync-required`, `rate-limited`, `quota-exceeded`,
and `internal-error`. Conflict details are discriminated as `server-update`,
`workspace-revision`, or `account-configuration`; domain-specific fields live
inside `details`, not alongside the envelope. Clients tolerate unknown codes
and fields but never reinterpret malformed required data.

## 3. Status, trees, and resolution

```text
GET  /v1/status
POST /v1/sync
POST /v1/placements/move
GET  /v1/trees
GET  /v1/accounts
POST /v1/me
GET  /v1/resolve?locator={ArborLocator}
```

Status returns the service and protocol versions, an opaque process
`instanceID`, the `runtimeKind` (`persistent`, `foreground`, or `cloud`), and
the current `DeviceID` when connected. The instance ID lets an owner verify
that a PID or loopback port still belongs to the runtime it created; clients
must not assign meaning to its contents.

`POST /v1/sync` accepts an optional
`{ configurationTree: TreeID }` body, waits for the matching account's current
synchronization pass, and lets attached CLI clients use the same process rather
than creating a second writer. With no body it waits for every account. An
account-qualified operation scopes this boundary so an unrelated offline
Canopy remains visibly errored without blocking healthy accounts.
Completion means that the pass ran, not that every tree is ready: clients that
need a readiness boundary must inspect the exact `GET /v1/trees` descriptors
and reject missing, offline, conflicting, errored, or still-syncing targets.
`POST /v1/placements/move` (`{ source, destination, check? }`)
relocates one placed root on disk and in `placements.yaml` after an explicit
synchronization boundary; `check: true` validates without moving.
New TreeIDs are minted by the client (`generateArborID` in `@arbor/core`,
`generateArborID(prefix:)` in `CanopyClient`): `tr_` plus 26 lowercase base32
characters encoding 128 random bits. Minting edits no file and reserves no
server state, so it is not a daemon operation.

`GET /v1/trees` returns `{ snapshot: LocalTreeDescriptor[], observedThrough }`.
When `sync` is `conflict`, `reviewableConflict: true` means the daemon can
produce durable content evidence through the conflict endpoint. Clients must
not infer that a conflict is resolvable merely from its status label.
It includes placed trees, pathless replicas, known remote placements, and the
implicit authenticated account-configuration tree.

`GET /v1/accounts` returns `{ accounts: LocalAccountSummary[], identity }`, a
safe list keyed by configuration TreeID. Each
entry reports its Canopy origin, profile TreeID, current DeviceID, credential
availability, diagnostics, and an optional Canopy-specific presentation
handle. The handle and origin are never account identity or credential keys.
The same response carries `identity`: the local self-certifying person
identity (`profileTree`, `profilePath`, `keyAvailable`) or `null` before
`arbor me create`. `POST /v1/me` creates that identity at a profile path.

Fresh v2 account bootstrap and account-qualified pairing use:

```text
POST /v1/bootstrap/accounts
POST /v1/bootstrap/pairings
```

The first accepts `{ account, path, displayName? }`, where `account` is the
complete Canopy-allocated account URL and `path` is the local person-profile
root already bound by `arbor me create` to the current self-certifying identity.
It creates no profile identity or tree placement. The pairing route accepts
`{ configurationTree? }`; the field is mandatory when more than one account
exists. There is no handle-shaped account-claim route.

Resolution returns `LocatorResolution`. A local path resolves only when it
lies inside a placed or session root (else `404 not-found`); an `arbor://tree/`
locator names a known tree directly; an `http(s)` or community `arbor://`
locator is resolved by that Canopy through the matching account client, and
`enclosingTree` is the local descriptor when the tree is placed here. Nothing
is placed, visited, or cached by resolution.

### 3a. Objects

```text
GET /v1/objects/{hash}?tree={TreeID}[&origin={url}]
```

Serves one canonical wire object (`application/cbor`) by its `sha256:<64 hex>`
hash. The response carries `ETag: "<hash>"` and
`Cache-Control: private, immutable, max-age=31536000`; clients may cache it
forever because the body is content-addressed. A malformed hash or missing
`tree` is `400 invalid-request`; an object the daemon cannot produce is
`404 not-found`.

The daemon looks the object up in this order:

1. The placed workspace's object index (`objects` table, see
   `local-system.md`): a file row re-reads the file and re-encodes it as a wire
   file object; a directory row re-encodes the directory from its children
   rows, walking the subtree only where a child row is missing or invalid.
2. The tree's stored pending update body, including transmitted successors.
3. Canopy, through the tree's account client, or through an anonymous client
   for `origin` when the tree has no local placement (a visit). Fetched bytes
   are retained in a bounded in-memory LRU (64 MiB by default) keyed by hash.

The index is an optimization, never authority. A file row is valid only while
its complete stat tuple (size, mtime, ctime, inode, device) still matches;
directory rows are trusted only because the produced object is verified. Every
served body is hash-verified before it leaves the daemon: a mismatch from the
index path deletes the row and falls through to the next source, so a stale
row can at worst produce a 404 or a slower answer, never wrong bytes.

### 3b. Bootstrap and credential

```text
GET /v1/bootstrap?tree={TreeID}
GET /v1/credential[?configurationTree={TreeID}]
```

`GET /v1/bootstrap` gives a loopback client everything it needs to open a
placed tree as its own working tree, without walking the folder or fetching
every object. The tree must have a local placement (else `404 not-found`) and
an accepted base already recorded by synchronization (else `409 conflict`
with `details.kind: "unsynchronized"`). The response is:

```ts
{
  tree: LocalTreeDescriptor,
  accepted: { root: Hash, update: string, cursor: string },   // cursor === update
  spine: string,          // base64 sparse CBOR snapshot bundle
  files: Record<string /* wire path */, { size: number, mtime: number }>,
  pending?: { base: string | null, updates: CandidateUpdateJSON[], requestDigests: Hash[] },
  blocked?: "conflict" | "unsettled",
  observedThrough: string,
}
```

`accepted` is the daemon's recorded base: the last accepted root and update
for the placement. `cursor` is the Wire watch cursor a client seeds its own
watch from, which is the update id.

**The sparse spine.** `spine` is a snapshot bundle in the exact CBOR shape of
the immutable Canopy snapshot bundle (`{ version: 1, objects: [...] }`,
objects sorted by hash, no duplicates), but it deliberately does not satisfy
the complete-graph check: it holds every directory object and every file
object whose entry name ends in `.md`, walked from the current folder root and
stopping at nested tree boundaries. Every other file's object is left out and
listed in `files` instead, keyed by wire path (`/photo.bin`,
`/sub/data.bin`) with its byte size and modification time (milliseconds since
the epoch). A client resolves those objects on demand through `/v1/objects`.
`files` exists because a `WireDirectoryEntry` carries only a name and a hash:
a sparse bundle alone cannot tell a deliberately omitted file from a missing
directory. A client therefore cross-checks every payload-less entry against
`files` and fails the bootstrap loudly when one is absent, so a daemon bug can
never silently collapse a subtree into one lazy "file". The spine always
describes the folder as it is now, even when the response is blocked.

**Pending, verbatim.** When the daemon holds a stored update string for the
tree (`pending` in its sync state), it is returned verbatim, as the exact
`{ base, updates }` request body it will send to Canopy, only when
`base` equals the accepted update and the last element's `candidate` equals
the current folder root, that is, when the string still ends exactly at the
folder. `requestDigests` are the per-element request digests
(`updateRequestDigests` in `@arbor/wire`); they exclude object envelopes, so a
client that adopts the string as its own first in-flight request may re-pack
objects and still match what Canopy will accept and trim by digest. A stored
string that does not meet both conditions is not returned; the response is
`blocked: "unsettled"` instead.

**Blocked.** `blocked` tells a client why it must not treat the folder as a
clean base, in priority order:

- `conflict`: the daemon holds a durable synchronization conflict for the
  tree. Open read-only from the spine and route the user to the conflict
  review endpoint.
- `unsettled`: the folder root differs from the accepted root and no stored
  string ends at it (the daemon has not yet built or has outrun its request).
  Ask for `POST /v1/sync` and retry.

When `blocked` is absent and `pending` is absent, the folder equals the
accepted root: a clean bootstrap.

**Credential.** `GET /v1/credential` returns `{ token }`, the Canopy account
credential stored for `configurationTree`, so that several local clients on one
installation share the daemon's device identity and request-digest scope.
Without the parameter it answers for the only connected account (or the
legacy community configuration); with several accounts connected the parameter
is required (`400 invalid-request`). A missing credential is `404 not-found`.
Serving the token over loopback is deliberate and adds no authority: any
local process running as the user can already read the credential store and
write the placed folders the daemon synchronizes. `local-system.md` records
the exposure.

## 4. Account bootstrap, forget, and conflict review

Narrow operations remain for states that cannot yet be represented by editing
an authenticated configuration tree:

```text
POST /v1/bootstrap/accounts
POST /v1/bootstrap/pairings
POST /v1/local/forget
```

Account bootstrap requires an existing self-certifying profile identity. It
generates the private configuration TreeID, DeviceID, and device credential
locally, stores the raw credential in the operating-system credential store,
constructs the initial configuration snapshots, signs the Canopy challenge
with the profile key, and submits the account claim. It is restart-idempotent
and never rewrites user-authored YAML to insert IDs or normalize it. Pairing
creates or claims the server pairing while similarly keeping the raw
new-device credential local. Local forget disconnects this data home without
revoking the server device or deleting user files.

Steady-state placement, ACL, canonical-boundary, profile/community,
administrator, and device-revocation changes are not arborsync operations.
Human clients and the CLI perform source-preserving transformations of
`account.yaml`, `trees.yaml`, or the authorized device file, and
`POST /v1/sync` lets them wait for the daemon's resulting pass. REST v1
therefore has no `connectCommunity`, `disconnectCommunity`,
`createGroupProfile`, `promoteTree`, `placeTree`, `removeTreePlacement`,
`setTreeAccess`, local device list/revoke proxy, or `/v1/remote` route.

Tree-level conflict review uses:

```text
GET  /v1/conflicts?tree=<TreeID>
POST /v1/conflicts/resolve
```

The read returns an identity-fenced workspace containing Canopy's reported
paths and reasons plus hash-validated Base, Current, Mine, and Draft content.
`Both` is advertised only when Canopy's draft has a distinct combined value;
textual paths may also be edited. Resolution submits a choice for every path
with the workspace identity. Arbor Sync rechecks the accepted Canopy update
and the local candidate before recording the reviewed result as new durable
intent. It never asks a REST client to merge object graphs. The daemon
submits one filesystem head per request, so `unattemptedCount` is always `0`
here; a working-tree client that retains a suffix behind the failed element
reports its own count.

A tree may report `sync: "conflict"` while review evidence is unavailable—for
example, legacy in-memory state created before a durable conflict body was
written. In that case the conflict endpoint returns an error and clients must
not invent choices or clear state.

## 5. Snapshot then observe

All mutable snapshots establish an observation boundary. Clients first read a
snapshot (`GET /v1/trees` carries `observedThrough`) and then observe strictly
after its cursor:

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
`event === data.kind`. The daemon emits placement events (a tree-wide
`updated` at `/` with `origin: "sync"` whenever it materializes accepted
Canopy state, carrying the accepted request digests when a watch batch
supplied them), external filesystem changes it observes in placed folders,
status changes, conflict diagnostics, and account/credential changes. Events
invalidate or describe local changes but do not replace a confirming snapshot.

If a cursor is no longer replayable, arborsync sends one terminal
`resync-required` event using the same envelope and closes. The client reads a
fresh snapshot and resumes after its cursor. This guarantees no gap between the
snapshot and following stream.

Local workspace events and server accepted-update events deliberately keep
different `kind` and `change` payloads. Sharing the observation framing does
not claim the domain events are identical.

## 6. Static hosting

Any request outside `/v1/` is the file surface. An ordinary file's OS-shaped
path (`GET /Users/joe/notes/photo.png`, also under the `/render` prefix so
authored relative references keep resolving) serves its bytes with an `ETag`,
`Accept-Ranges`, and `?raw` for a document's stored body, dispatched into the
placed or session root that owns the path; a tree-rooted spelling resolves in
the scope of the `Referer` document. Paths outside every root and every app
route answer the Plan B notice. Nothing outside placed and session roots is
readable through the daemon.

## 7. Reference fixtures

The TypeScript and Swift reference clients consume the REST JSON and SSE
fixtures under [`tests/fixtures/arborsync`](../tests/fixtures/arborsync):
`status.json`, `conflict-workspace.json`, `error.json` and `errors.json`,
`cursors.json`, and the `events.sse` / `malformed-event.sse` frames. Their
shared tests cover explicit tree scope, snapshot/SSE gap freedom, multiline
data, keepalives, conflicting-cursor rejection, and terminal
resynchronization. Another local implementation may expose the same underlying
Arbor behavior through a different client/daemon boundary.
The bootstrap and credential routes are fixed by `bootstrap.json` (a clean
bootstrap with a sparse spine and one listed binary), `bootstrap-pending.json`
(the same tree with a verbatim pending string and its request digests), and
`credential.json`.
