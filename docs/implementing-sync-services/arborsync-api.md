# Local Arbor Sync REST API
*Reference API for the current local daemon and its two clients: the CLI's `packages/cli/src/daemon-client.ts` and the Mac app's `swift/CanopyApp/ArborSync/`. It is not part of the portable Overstory specification.*

The current version is Arbor Sync REST v1.

The protocol request grammar is in [tree operations §2.1](../overstory-spec/01-tree-operations.md#21-the-update-request); these local REST routes and filesystem scheduling
do not acquire new capabilities from that specification.

Arbor Sync makes placed folders content-addressable and keeps each one equal
to canopyd's accepted root in both directions. Everything below is either that
store's read surface (objects, bootstrap, credential) or the control surface
for placements, accounts, and declined changes.

Arbor Sync binds to loopback and rejects cross-origin browser requests. JSON is
UTF-8. It rejects non-loopback `Host` headers so DNS rebinding cannot turn an
attacker-controlled origin into a local file reader. Request URLs never contain
credentials or access-link secrets.

**REST v1 is a control surface, not an editor path.** The daemon is the
placed folder's synchronization client plus the loopback services a
working-tree client needs: `GET /v1/status`, `GET /v1/trees`,
`GET /v1/accounts`, `GET /v1/resolve`, `POST /v1/held/discard`, `GET /v1/declined`, `POST /v1/declined/restore`, `POST /v1/declined/resend`,
`POST /v1/sync`, `POST /v1/placements/move`, `POST /v1/placements/pause`,
`POST /v1/placements/resume`, `GET /v1/pending`,
`GET /v1/bootstrap` and `GET /v1/credential` (§3b),
`GET /v1/objects/{hash}` (§3a), the data-home identity and account
bootstrap routes (§4), and `GET /v1/events` (§5). The Mac app's client in
`swift/CanopyApp/ArborSync/` launches or attaches to the control-mode daemon
(`arborsync --control`) and uses exactly these routes. Pairing offers are not
a daemon route: a client with the account credential creates one on the host
(`POST /.arbor/pairings`), as the Mac app and the CLI's cloud sessions do. The former node, children, search, backlinks, recovery, file,
mutation, document, asset, and import routes were deleted with the
daemon's editor path (Native 022 Phase 7): editors run the update machine
against their own working tree, as the daemon does for each placed folder. Those paths now answer
`405 unsupported-operation` like any unknown `/v1/` route. **The web editor is
unavailable until Plan B** rebuilds it as a working-tree client; app routes
serve a short notice instead of the bundle, while static hosting of tree files
at OS-shaped routes (§6) continues.

The reference listener dispatches to separate sync, account and browser handlers.
This internal decomposition does not change route names, responses, credentials,
ports or client discovery; see [local service ownership](../architecture/arborsync/README.md).

## 1. Shared values

REST v1 reuses the portable model, read, locator, access, update, and
observation values defined across the specification. In particular,
`TreeID`, `LogicalPath`, `JSONValue`, and `NodeRef` come from the
[Overstory data model](../overstory-spec/01-tree-operations.md#the-arbor-data-model), while
`EventCursor`, `Hash`, `AccessLevel`, `TreeKind`, `TreeDescriptor`, and
`RemoteTreeDescriptor` come from the
[current-tree read](../overstory-spec/01-tree-operations.md#111-reading-the-current-tree).
REST v1 adds the following local values:

```ts
// Only actual Overstory TreeIDs name a scope; the former `local` and `system`
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
  // The accepted canopyd base this placement derives from: the same `root`
  // and `update` an Overstory RemoteTreeDescriptor carries, absent until one exists.
  root?: Hash;
  update?: string;
  name: string;
  placement: "placed" | "replica" | "remote";
  osPath?: string;
  sync?: "idle" | "syncing" | "offline" | "conflict" | "error" | "paused";
  missing?: boolean;
};

type LocatorResolution = {
  ref: NodeRef;
  enclosingTree?: TreeDescriptor;
  historical: boolean;
  observedThrough: EventCursor;
};
```

- Arbor Sync speaks the protocol vocabulary wherever the two overlap. `TreeDescriptor`,
  `LocatorResolution`, `PairingOffer`, `LocalAccountSummary`, and
  `ProfileIdentity` are single definitions in `@overstory/protocol` (Swift:
  `Overstory` and the Mac app's daemon client share `ProtocolCanonicalDescriptor`); a
  local descriptor adds only what a local daemon knows.
- `GET /v1/trees` returns `LocalTreeDescriptor`s. Hosted ordinary trees have
  non-null canonical data and the account's private profile configuration
  (`kind: "tree-configuration"`) has `canonical: null`.
- `LocatorResolution.enclosingTree` is present whenever the daemon knows the
  tree locally; on the protocol it is always present.

Every `NodeRef`, event, effect, and relevant error names its tree explicitly.
Omitted-tree defaults are invalid. Clients derive writability from effective
access and historical state; resolution does not duplicate a `writable` flag.

## 2. Access and errors

Access subjects, levels, and the `none` removal rule are defined once in
[configuration](../overstory-spec/04-accounts-and-devices.md#3-configuration-yaml). Configuration
and mutation requests use the protocol's `AccessRule`; safe administrative
responses use `AccessEntry`, whose link subject exposes neither raw secret nor
digest ([access control §1](../overstory-spec/05-access-control.md#1-subjects-and-rules)).

Every non-2xx JSON error uses the protocol's `OverstoryError` envelope with
`tree?: TreeRef`. Shared codes are `invalid-request`, `unauthenticated`,
`permission-denied`, `not-found`, `conflict`, `read-only`,
`unsupported-operation`, `resync-required`, `rate-limited`, `quota-exceeded`,
and `internal-error`. Conflict details are discriminated as `server-update`,
`workspace-revision`, or `tree-configuration`; domain-specific fields live
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
`instanceID`, and the `runtimeKind` (`persistent`, `foreground`, or `cloud`).
Device identity is account-scoped and appears in `GET /v1/accounts`, not status. The instance ID lets an owner verify
that a PID or loopback port still belongs to the runtime it created; clients
must not assign meaning to its contents.

`POST /v1/sync` accepts an optional
`{ configurationTree: TreeID }` body, waits for the matching account's current
synchronization pass, and lets attached CLI clients use the same process rather
than creating a second writer. With no body it waits for every account. An
account-qualified operation scopes this boundary so an unrelated offline
canopyd remains visibly errored without blocking healthy accounts.
Completion means that the pass ran, not that every tree is ready: clients that
need a readiness boundary must inspect the exact `GET /v1/trees` descriptors
and reject missing, offline, conflicting, errored, or still-syncing targets.
`POST /v1/placements/move` (`{ source, destination, check? }`)
relocates one placed root on disk and in `placements.yaml` after an explicit
synchronization boundary; `check: true` validates without moving. It stays
a daemon operation rather than a client-side checkout edit plus
`POST /v1/sync`: the daemon holds synchronization, relocates the watched root
together with its workspace state, and rolls the placement back if the move
fails, which a client editing `placements.yaml` under a running watcher cannot
do.
New TreeIDs are minted by the client (`generateArborID` in `@overstory/protocol`,
`generateArborID(prefix:)` in `OverstoryClient`): `tr_` plus 26 lowercase base32
characters encoding 128 random bits. Minting edits no file and reserves no
server state, so it is not a daemon operation.

`GET /v1/trees` returns `{ snapshot: LocalTreeDescriptor[], observedThrough }`.
`sync` is the folder's update machine (spec 09): `idle` is current,
`syncing` has local changes publishing or an accepted state installing,
`offline` retries automatically, `error` needs credentials or has stopped, and
`conflict` means a request is held whole: the host does not support an
operation in it, or a read-only placement has local edits. `declined` lists
the folder paths whose changes the host declined; they stay on disk
unpublished while the rest of the folder keeps syncing (§4).
It includes placed trees, pathless replicas, known remote placements, and the
implicit authenticated profile configuration.

`GET /v1/accounts` returns `{ accounts: LocalAccountSummary[], identity }`, a
safe list keyed by configuration TreeID. Each
entry reports its canopyd origin, profile TreeID, current DeviceID, credential
availability, diagnostics, and an optional canopyd-specific presentation
handle. The handle and origin are never account identity or credential keys.
The same response carries `identity`: the local self-certifying person
identity (`profileTree`, `profilePath`, `keyAvailable`) or `null` before
`arbor me create`. `POST /v1/me` creates that identity at a profile path.

Fresh v2 account bootstrap uses `POST /v1/bootstrap/accounts` (§4). It
accepts `{ account, path, displayName? }`, where `account` is the complete
canopyd-allocated account URL and `path` is the local person-profile root
already bound by `arbor me create` to the current self-certifying identity. It
creates no profile identity or tree placement. There is no handle-shaped
account-claim route and no pairing-offer route: an authorized device creates
the offer on the host with its account credential.

Resolution returns `LocatorResolution`. A local path resolves only when it
lies inside a placed or session root (else `404 not-found`); an `arbor://tree/`
locator names a known tree directly; an `http(s)` or community `arbor://`
locator is resolved by that canopyd through the matching account client, and
`enclosingTree` is the local descriptor when the tree is placed here. A
locator ending in `;arbor-config` names the configuration of the tree whose
root it names: `arbor://<TreeID>;arbor-config` resolves only to a configuration
checked out on this device, and a canonical `http(s)` or `arbor://` locator
through the host, which answers only the tree's administrators. Nothing is
placed, visited, or cached by resolution.

### 3a. Objects

```text
GET /v1/objects/{hash}?tree={TreeID}[&origin={url}]
```

Serves one Overstory object (`application/octet-stream`) by its `sha256:<64 hex>`
hash. The response carries `ETag: "<hash>"` and
`Cache-Control: private, immutable, max-age=31536000`; clients may cache it
forever because the body is content-addressed. A malformed hash or missing
`tree` is `400 invalid-request`; an object the daemon cannot produce is
`404 not-found`.

The daemon looks the object up in this order:

1. The placed workspace's object index (`objects` table, see
   `data-home.md`): a file row re-reads the file and re-encodes it as an Overstory
   raw file bytes; a directory row re-encodes the directory from its children
   rows, walking the subtree only where a child row is missing or invalid.
2. The tree's stored pending update body, including transmitted successors.
3. canopyd, through the tree's account client, or through an anonymous client
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
  tree: Pick<LocalTreeDescriptor,
    "id" | "configurationTree" | "kind" | "access" | "canonical" |
    "name" | "osPath" | "placement">,
  accepted: { root: Hash, update: string, cursor: string | null },   // independent observation boundary; null requires refresh
  spine: string,          // base64 sparse CBOR snapshot bundle
  observedThrough: string,
}
```

`accepted` is the daemon's recorded base: the last accepted root and update
for the placement. `cursor` is the protocol watch cursor a client seeds its own
watch from, which is the update id. The spine is rooted at this accepted root.
The `tree` value contains placement and canopyd-routing metadata, not the
daemon's `sync`, `root`, `update`, `conflicted`, or `missing` fields. Arbor
Sync's folder changes, held request, availability, and tree-list sync state
are intentionally absent: they belong
to the folder client and cannot seed or block another working-tree client.

**The sparse spine.** `spine` is a snapshot bundle in the exact CBOR shape of
the immutable canopyd snapshot bundle (`{ version: 1, objects: [...] }`,
objects sorted by hash, no duplicates), but it deliberately does not satisfy
the complete-graph check: it holds every directory object and every file
object whose entry name ends in `.md`, walked from the accepted canopyd root.
Other file payloads may be left out and
resolved on demand through `/v1/objects`. Entries explicitly identify `file`,
`directory`, or `tree`, so a missing directory is always an error. No file map,
size lookup, or payload sniffing is needed.

**Modification dates.** The bootstrap carries none. Page dates are Canopy's
entry metadata, which every client reads from canopyd itself
(`GET /.arbor/trees/{id}/entry-metadata`, [tree reads §1.1.2a](../overstory-spec/01-tree-operations.md#112a-reading-entry-metadata)):
accepted change times keyed by body entry, the same on every device, and
outside Overstory objects, roots and update digests.

Every successful response is a
clean installation boundary. Concurrent folder work is reconciled later by
canopyd and the ordinary watch/update protocol, like work from any other client.

**Credential.** `GET /v1/credential` returns `{ token }`, the canopyd account
credential stored for `configurationTree`, so that several local clients on one
installation share the daemon's device identity and request-digest scope.
Without the parameter it answers for the only connected account (or the
legacy community configuration); with several accounts connected the parameter
is required (`400 invalid-request`). A missing credential is `404 not-found`.
Serving the token over loopback is deliberate and adds no authority: any
local process running as the user can already read the credential store and
write the placed folders the daemon synchronizes. `data-home.md` records
the exposure.

For a key device the token is a session its key opened, not a long-lived
credential: it is valid for at most an hour, so a client refetches it after a
401 rather than caching it indefinitely.

`POST /v1/device-key` accepts `{ configurationTree }` and moves this
installation's device for that account to a key (`arbor device move-to-key`),
answering `{ deviceKey }`; for a device that already has one it only answers.

## 4. Identity, account bootstrap, and declined changes

Narrow operations remain for data-home state that cannot yet be represented by
editing an authenticated configuration tree: the local person identity and a
new device's first credential. They are the Mac app's onboarding, and they
write the same stores the CLI and the daemon read (the profile identity, the
account connection record and its credential in the operating-system store,
and the account checkout):

```text
POST /v1/me
POST /v1/me/restore
POST /v1/me/backup
POST /v1/bootstrap/accounts
POST /v1/bootstrap/accounts/cancel
POST /v1/bootstrap/pairings/claim
```

The former `POST /v1/bootstrap/pairings` (create a pairing offer) and
`POST /v1/local/forget` routes are gone (Native 011): an offer is created on
the host with the account credential, and nothing called forget. Both answer
`405 unsupported-operation` like any unknown `/v1/` route.

Mac onboarding reads `GET /v1/accounts`, whose envelope contains `accounts`,
`identity`, `pendingClaim`, and `pendingPairing` (each nullable). A pending claim exposes
its `account` URL, local `path`, and `canCancel` flag, never its credential or
signature. A pending pairing exposes only its community `origin`. Corrupt
identity metadata and credential-store failures are errors, not absent identities.

`POST /v1/me` accepts `{ path }` to create an identity idempotently.
`POST /v1/me/restore` accepts `{ path, backup, passphrase? }`: a version-2
backup needs its passphrase, and a version-1 backup (the key in the clear, as
written before Security 006) needs none. It validates the complete key/TreeID
relationship and refuses to replace a different identity. `POST /v1/me/backup`
accepts `{ destination, passphrase }` and writes a new owner-readable version-2
file, refusing to overwrite an existing file or a passphrase shorter than eight
characters. These are same-user loopback operations with the same credential
boundary described above. Backup bodies and passphrases must never be logged.

Account bootstrap accepts either a community origin or an exact account URL in
`account`, plus an optional `inviteCode` for a pending community invitation.
It stores the resolved URL and code from the signed challenge in its private durable
pending claim and resumes the same claim after interruption.
Preparations do not install account checkout files until the host accepts the
claim. `POST /v1/bootstrap/accounts/cancel` abandons only a preparation that has
never been submitted. Once submission could have reached the host, the exact
request and credential are retained for retry; cancellation is rejected.

`POST /v1/bootstrap/pairings/claim` accepts `{ payload }`, where `payload` is the
version-1 QR pairing object `{ version, origin, pairing: { id, secret } }`. An
empty object resumes the persisted pairing. Mac pairing requires an existing
matching profile identity, stores its exact device request and credential before
contacting the host, and installs the account into ArborSync's account store.
It verifies the returned device, profile and community and refuses to overwrite
an existing checkout with different contents. It does not generate a profile key.
Pairing codes and device credentials must never be logged.


Account bootstrap requires an existing self-certifying profile identity. It
generates the private configuration TreeID, DeviceID, and device credential
locally, stores the raw credential in the operating-system credential store,
constructs the initial configuration snapshots, signs the canopyd challenge
with the profile key, and submits the account claim. It is restart-idempotent
and never rewrites user-authored YAML to insert IDs or normalize it. Pairing
claims the server pairing while similarly keeping the raw new-device
credential local.

Steady-state placement, ACL, canonical-boundary, profile/community,
administrator, and device-revocation changes are not arborsync operations.
Human clients and the CLI perform source-preserving transformations of
the profile configuration's `mounts.yaml`, `apps.yaml` or `devices.yaml`, or
write another tree's configuration through the host, and
`POST /v1/sync` lets them wait for the daemon's resulting pass. REST v1
therefore has no `connectCommunity`, `disconnectCommunity`,
`createGroupProfile`, `promoteTree`, `placeTree`, `removeTreePlacement`,
`setTreeAccess`, local device list/revoke proxy, or `/v1/remote` route.

Each placed folder runs the update machine (spec 09): a folder edit is
scanned into a local change in the folder's change log and published. When
the host definitively rejects a request, the entries it changed (its
footprint, from its base to its candidate) become the folder's **declined
paths**, recorded in `declined.json` beside the change log, and the request
leaves the change log. The folder keeps every byte. From then on:

- each scan publishes the folder with the accepted state at every declined
  point, as a fresh change against the accepted base, so independent edits
  keep publishing;
- accepted updates are written everywhere except declined points, so remote
  work keeps arriving;
- a declined path is kept whole up to where the folder and the accepted
  state stop both having directories above it, so a declined deletion of a
  directory is never published in part;
- content a declined path no longer holds on disk, found in a new or
  changed entry elsewhere, is declined there too, so a declined move is never
  half published;
- a declined path is released as soon as the folder matches the accepted
  state there.

Declined work is never merged, rebased, or resent automatically. The explicit
actions are:

```text
GET  /v1/declined?tree=<TreeID>          → { declined: { tree, detail?, paths, points, since, request } | null }
POST /v1/declined/restore   { "tree": "<TreeID>" }
POST /v1/declined/resend    { "tree": "<TreeID>" }
```

`points` are where declined work is on disk now. Restore writes the accepted
state at every declined point and keeps the folder's other changes. Resend
clears the record so the next scan publishes the declined paths as the folder
holds them, with fresh identity; a second rejection declines them again.

A request the host rejected as unsupported is **held** whole
(`sync: "conflict"`) with every change authored on it, and nothing publishes
until it is discarded:

```text
POST /v1/held/discard   { "tree": "<TreeID>" }
```

That removes the held request and every change authored on it from the change
log, catches up to the host's current state, and writes it to the folder.
Accepted alternatives (`conflicted: true`) are neither: they are accepted
state, reviewed through the host's conflict inspection like any other
working-tree client's.

A person can also pause a placed folder to see what the daemon would publish
before it sends it:

```text
POST /v1/placements/pause    { "tree": "<TreeID>" }   → { tree, paused: true }
POST /v1/placements/resume   { "tree": "<TreeID>" }   → { tree, paused: false }
GET  /v1/pending?tree=<TreeID>                       → { tree, paused, base, request }
```

While paused, scans append nothing to the change log and the tree reports
`sync: "paused"` (or `conflict` while a request is held whole); accepted updates
still arrive and are written to the folder when it holds no local edit. The
pause is durable across daemon restarts. Resume clears it and scans at once.
`GET /v1/pending` returns the exact `UpdateRequestJSON` the next publication
would POST: the log's unsettled chain plus, when the folder differs from what
it last held, the change a scan would append, and `base`, the accepted
`{ root, update }` the request names. It sends and retains nothing, and the
next scan of an unchanged folder publishes the change it prepared, so the
request resume sends is the one the last `pending` showed. `request` and
`base` are null when nothing is pending. Changes already in the change log
before a pause still publish.

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
canopyd state, carrying the accepted request digests when a watch batch
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

The TypeScript and Swift daemon clients consume the REST JSON and SSE
fixtures under [`tests/fixtures/arborsync`](../../tests/fixtures/arborsync):
`status.json`, `error.json` and `errors.json`,
`cursors.json`, and the `events.sse` / `malformed-event.sse` frames. Their
shared tests cover explicit tree scope, snapshot/SSE gap freedom, multiline
data, keepalives, conflicting-cursor rejection, and terminal
resynchronization. Another local implementation may expose the same underlying
Overstory behavior through a different client/daemon boundary.
The bootstrap and credential routes are fixed by `bootstrap.json` (a clean
bootstrap with a sparse spine and one omitted binary), `bootstrap-pending.json`
(the same tree with a verbatim pending string and its request digests), and
`credential.json`.

The bootstrap spine uses typed `file` and `directory` entries. Every directory
and Markdown file is present; other file payloads may be omitted. File sizes
remain unknown until read; there is no bootstrap `files` classification map.

The local tree descriptor may carry `conflicted` for its accepted base. This is
independent of the daemon's rejected-edit `sync: "conflict"` status and does not hold
ordinary synchronization. A null bootstrap accepted cursor requires a fresh canopyd
observation boundary; it must not be replaced with the accepted update ID.
