# Overstory reference implementation

This document records the architecture and operating choices of the current
reference implementation. It is informative; the normative contracts live in
[spec/README.md](../spec/README.md), and [status.md](../status.md) says which of the
behavior below is installed or deployed.

## Components

Five components, two languages. Every TypeScript package lives under
`packages/<name>` and is published as `@overstory/<name>`; every Swift
package lives under `swift/Packages/<Name>`.

| Component | TypeScript | Swift | Owns |
|---|---|---|---|
| Overstory protocol | `protocol`, `object-store` | `Overstory`, `OverstoryObjectStore` | The specification in code: identifiers, node model, canonical CBOR, hashing, objects and snapshots, update contracts, resource policy, the document format, configuration formats, HTTP and SSE transport; the content-addressed object store |
| Host | `canopyd`, `canopyd-merge`, `apps-runtime` | | Communities, accounts, hosted trees, acceptance, public pages; the merge sidecar; the executable-document runtime and collection sandbox |
| Client stack | `client`, `fs` | `OverstoryClient`, `CanopyWorkingTree` | Synchronizing a working tree against a host: update machine, admission queue, account bootstrap, filesystem materialization |
| Arbor local tools | `arborsync`, `arborsync-client`, `cli` | `ArborSyncClient` | The per-user daemon, its loopback REST API and clients, the `arbor` command |
| Canopy browsers | `canopy-web` | `CanopyAppKit`, `CanopyEditor`, the `Canopy` app target | The human interface |

Layering: `protocol` depends on nothing in the workspace; `apps-runtime`
depends only on `protocol`; the host and client packages never depend on
`arborsync*`; `cli` and `canopy-web` may depend on anything. Swift mirrors
this: `Overstory` is a leaf, `OverstoryObjectStore` depends on it,
`CanopyWorkingTree` on both plus `CanopyAppKit`, and `OverstoryClient`,
`ArborSyncClient`, and `CanopyEditor` sit above.

### TypeScript packages

| Package | Purpose | Depends on |
|---|---|---|
| `protocol` | `model/` (types, identifiers, CBOR, hashing, logical paths and URLs, resource policy, errors, SSE), `objects.ts` and `snapshots.ts`, `updates/` (request and accepted contracts, JSON, intent digests, deltas), `transport.ts` (the HTTP client), `documents/` (Markdown and directory documents, child links, titles, document merge), `config/` (account, device, placement, resource configuration and the private data home) | `@noble/hashes`, `yaml` |
| `object-store` | Immutable hash-sharded storage with verified reads, durable writes, and reachability walks | protocol |
| `fs` | `WorkspaceFS`: discovery, the write journal, atomic file operations, materialization, watching ([README](../packages/fs/README.md)) | protocol, `@parcel/watcher` |
| `client` | Tree sync, sync state, account bootstrap and wire, the update machine, the document admission machine, the source admission queue, publisher, and document session, entry transfer | protocol, fs |
| `canopyd` | Access and claims, accounts and profiles, boundaries, the public page, resource effects and execution authority, schema and the SQLite authority, `updates/` (decision, reconcile, graph validation, stores, observations, watch frames, source edits), the merge worker adapter, projection, the `canopyd` CLI ([README](../packages/canopyd/README.md)) | protocol, object-store, apps-runtime, canopyd-merge |
| `canopyd-merge` | The merge sidecar: contract, intent engine and model, format rules, Markdown and web formats, state maps and storage, retention, checkpoints, the `arbor-merge` CLI ([merge tool](canopyd/merge-tool.md)) | protocol, object-store, apps-runtime, tree-sitter, saxes |
| `apps-runtime` | Query core and node queries, the SQLite engine, live streams and observers, mutations, authoring API, host integration, and `collections/` (the QuickJS schema sandbox and the collection-file codec) ([README](../packages/apps-runtime/README.md)) | protocol, `quickjs-emscripten`, `csv-parse` |
| `arborsync` | The daemon: workspace and editor, tree manager, sync and account HTTP, browser routes, filesystem object source and node surfaces, events, and `state/` (tree registry, placements, connections, local accounts, profile identity, providers, object index) | protocol, client, fs, apps-runtime |
| `arborsync-client` | `ArborSyncRESTClient` for the daemon's control surface | protocol |
| `cli` | `arbor`: daemon supervision, identity, placement, moves, cloud sessions | arborsync, arborsync-client, protocol, fs |
| `canopy-web` | The browser editor (React, BlockNote, Vite); out of the build and typecheck until [Web 025](../plans/canopy-web/025-arbor-web.md) rebuilds it as a working-tree client | arborsync-client, protocol |

### Swift packages

| Package | Purpose | Depends on |
|---|---|---|
| `Overstory` | Protocol models, canonical CBOR, the SSE parser, the HTTP client, authored and accepted contracts, operations, transitions, resource policy, the network log | |
| `OverstoryObjectStore` | The `ObjectStore` protocol with overlay, layered, directory, and host-backed stores; every store verifies bytes against their hash | Overstory |
| `CanopyAppKit` | Workspace models and provider protocol, the workspace coordinator, logical URLs and display titles, the document admission machine, the browser tab controller | |
| `CanopyWorkingTree` | `WorkingTree` and its state store, `UpdateMachine` and `UpdateCoordinator`, durability, the snapshot bridge, `SourceAdmissionQueue`, entry actions and transfer, conflict review | CanopyAppKit, OverstoryObjectStore, Overstory |
| `OverstoryClient` | Credentials, the placement service, `CanopyWatchRunner`, account configuration YAML, resource consent | CanopyAppKit, CanopyWorkingTree, OverstoryObjectStore, Overstory, Yams |
| `ArborSyncClient` | The loopback REST client for the daemon and its process supervisor | CanopyAppKit, OverstoryObjectStore, Overstory |
| `CanopyEditor` | The Quagmire editor host and surface, document binding, the Markdown codec, editor recovery, conflict analysis | ArborSyncClient, CanopyAppKit, Quagmire |

`swift/Canopy.xcodeproj` is generated from `swift/project.yml`
by xcodegen and committed; see [swift/README.md](../swift/README.md).

## Runtime ownership

**The daemon** (Arbor Sync) is one process with one loopback API. `server.ts`
supplies request protection and error handling and composes the handlers:

| Owner | Modules in `packages/arborsync/src/` | Responsibilities |
|---|---|---|
| Sync | `sync-http.ts`, `service.ts` | Placement inventory and moves, bootstrap, events, pending updates, reconciliation, materialization, conflict recovery |
| Account administration | `account-http.ts`, `account-service.ts` | Identity, credentials, accounts, claim, pair, and forget through the account bootstrap ports |
| Browser | `browser-http.ts`, `local-files.ts` | Scoped file, raw, HEAD, range, and ETag handling and the current web placeholder |
| Filesystem objects | `filesystem-object-source.ts` | SQLite index lifecycle, verified file and directory reads, invalidation and uncached revalidation |
| Sync connections | `sync-connections.ts` | Explicit account selection and credentials through the injectable `SyncConnections` interface |
| State | `state/` | The tree registry, placements, connections, local accounts, profile identity, providers, and the object index |

`Workspace` owns one placed folder: filesystem and object-source lifecycle,
descriptor and scope, watcher subscription, and change observations. Its
`editor` component owns node and provider projection, editor mutations,
stable-key resolution, link healing, and generated types. `Workspace.open()`
finishes interrupted mutation recovery before returning. `TreeObjectCache`
composes the filesystem source, durable pending objects, and the host, in that
order; file bytes stay in their files, with no mirror.

The daemon's placed folder is a working tree whose object store is the folder
itself: a file's object is re-encoded from disk, a directory's from its
children, and the index only remembers which hash a path last produced. That
is why the daemon can serve `/v1/objects` to every other client on the
machine without a second copy of the tree, and why the Mac app's in-memory
working tree needs no content store of its own. The daemon has no editor
path.

**The Canopy app** runs `CanopyWorkingTree` directly: the document admission
machine makes each edit durable in the working tree and the update
coordinator publishes durable heads to the host. On iOS the working tree is on
disk; on the Mac it is in memory, seeded from the daemon's `GET /v1/bootstrap`
and backed by its `/v1/objects` route. The layouts are in
[the local system](canopy-browser/local-state.md#native-working-trees).

**The host** (canopyd) implements access and claims, public HTTP projection,
graph validation, authoritative reconciliation, and private storage. Update
handling separates decision, causal reconciliation, and transactional storage
from rule computation; the [merge sidecar](canopyd/merge-tool.md) computes every
merge and returns retained state, and canopyd validates the result and owns
acceptance. Table definitions, the schema stamp, and the startup schema
assertion live in `schema.ts`; the [schema history](../packages/canopyd/migrations/README.md#schema-history)
lists every stamp.

**Executable data.** `apps-runtime` lowers portable child queries over
ordinary and SQLite providers, validates mounted source bindings, executes
each SQLite query in one read snapshot, tracks relation, field, and profile
dependencies, and publishes a complete replacement only when a relevant
committed change alters the canonical output. Its mutation runner validates
input and authorization inside one transaction and commits retry-stable
receipts with the data change. Document compilation and presentation are
not current architecture; they are [Apps 001 and 003](../plans/README.md).
The QuickJS sandbox that evaluates collection schemas lives here too and is
shared by canopyd, the merge sidecar, and the daemon's providers.

## Protocol encoding and identity

Canonical CBOR and `canonicalCBORHash` live in `protocol`. Snapshot bundles
contain only a version and hash-ordered object byte strings (raw files and
canonical CBOR directories); the root stays in the request URL. Directory
objects carry ordinary CSV, JSON, and JSONL source and schema entries plus a
directory-level `childrenSource` descriptor that interprets them as one child
set; canopyd validates those graphs, merges disjoint rows by stable identity,
and projects logical rows at ordinary locators while keeping `_store.*` and
`schema.ts` out of child navigation.

For an update string, canopyd derives one credential-scoped digest per
element over `{ domain: "arbor-update/2", tree, base, change, trace,
candidate, resolves, ifCurrent }`, with each later element using its
predecessor's `{ requestDigest, candidate }` as `base`. Accepted rows store
the element digest for replay, so a longer request resumes after an
already-applied prefix. Object hashing is not authorization: the caller binds
the basis to an authorized accepted state in the same tree, and reusing a
retained change ID in a different request, including a snapshot, is
rejected. A request the host does not support fails closed with
`422 unsupported-operation` before any prefix is accepted; the daemon then
retains the pending request, marks the tree as an error, and suppresses
resubmission of that request for the synchronizer's lifetime, while the
native coordinator enters a terminal validation state keeping the durable
request. Neither client strips operations.

Source edits against an accepted basis may ship the edited file as an object
delta when that is smaller; chained authored records always send the whole
file, because `reconstructDeltas` resolves delta bases against the accepted
base root before the request's own objects are stored.

**Net watch catch-up** is unconditional. A client requests
`GET /.arbor/trees/{tree}/watch` with its confirmed cursor; canopyd captures
the accepted state at that cursor and the current destination and builds one
sparse payload between their roots. `from: { id, root }` is the transport
basis while `update.previous` stays the destination's real predecessor.
Missing retained basis data answers `resync-required`. Absence of a matching
digest in a coalesced event is not proof of non-acceptance, so pending
requests keep their exact retry procedure. Net frames may exceed the ordinary
1 MiB frame target; the native SSE parser scans new bytes only.

<a id="conflict-inspection"></a>
**Conflict inspection.** `GET /.arbor/trees/{tree}/conflicts?state={acceptedUpdate}`
returns the decisions retained at that accepted state. `after` and `conflict`
are mutually exclusive; the reference page size is 32, with no cap of 32 on
accepted decisions; historical pages keep their identities as current
advances. Unknown, unavailable, or unauthorized state is 404; malformed query
or token bindings are 400. A root decision is encoded as `kind: "directory"`
with the root basis reference and `root: true`, no `placement`, and no
synthetic filename.

<a id="resource-policy"></a>
**Resource policy.** `ExecutionAuthority.issue` is trusted host
infrastructure, not a public mint endpoint; tokens are process-local and
invalidated on restart while durable update identity survives independently,
and possessing a token makes no SQLite connection safe. The internal
`GET /.arbor/execution/authority-watch` authenticates an execution token and
sends `refresh` or `revoked` SSE events with empty payloads; it conservatively
invalidates on accepted updates, revocation notifies immediately, and expiry
and session changes are polled, so providers refresh authority after a
disconnect. `GET /access` keeps the legacy `snapshot` projection and adds a
safe `policy` field. The supported scoped update subset: new files and
directories need `create-child` at the logical parent, raw content changes
`update-content`, file deletion `delete`; Markdown replacement conservatively
needs `write` because it can change frontmatter, as do directory deletion or
retyping, reserved representations, and opaque child stores. Scopes stop at
TreeIDs and newly created scoped directories cannot conceal nested trees.
Operation-bearing updates, explicit resolutions, updates to conflicted
trees, scoped object, snapshot, and watch projections, and granular property
or store effects fail closed and never widen to write. Concurrent policy
edits install their restrictive intersection with the alternatives retained
as a root conflict; removal wins concurrent expansion for non-hosting
entries; a pending policy conflict locks configuration edits until an
administrator resolves every alternative.

## Durability and observation

canopyd runs SQLite in WAL mode with `synchronous = NORMAL`; objects are
fsynced before the commit that names them, so a lost commit leaves only
unreferenced objects ([deployment](../packages/canopyd/deploy/README.md#durability)). Each
update request logs one structured line (tree, status, batch size, total and
per-phase milliseconds, objects considered, files written, fsyncs, body
bytes, trace frames and operations, accepted update ids) and returns the
same phases in a `Server-Timing` header. The log is silent under the test
runner and never contains request content, subjects, or object identities.
The Canopy app's network log is its client-side counterpart
([local system](canopy-browser/local-state.md#diagnostic-streams)).

The daemon uses a private intent journal, recovery bookkeeping, filesystem
observation, and a 1,024-event in-memory SSE replay buffer; a restart changes
the event epoch and clients resynchronize. Private paths are documented for
maintainers and migration tooling only, in [the local system](arborsync/data-home.md);
other implementations may choose a different layout. The synchronized
[`trees.yaml`](../spec/04-accounts-and-devices.md#3-configuration-yaml)
contract is normative.

## Client mechanics

The TypeScript and Swift clients are hand-maintained against common
fixtures. Their local Arbor Sync REST clients speak only the daemon's control
surface (status, trees, accounts, bootstrap, credential, objects, conflicts,
events); there is no local mutation path. Every editor is a direct
working-tree client. Server updates are one retry domain: a confirmed
accepted base plus an append-only string of candidate roots and object
envelopes, with a client-generated change ID per candidate and no separate
idempotency key. Arbor Sync and the native coordinator each durably retain
their own semantic prefix across retry and restart, with the objects each
request carries, so resubmission never consults a live object store.

When canopyd returns a conflict for an update string, the client keeps the
exact prepared request as durable conflict state: the `completed` prefix is
already processed, `failedIndex` identifies the element under review, and
the suffix remains unattempted. Resolution submits the reviewed element
against the verified current descriptor, then guardedly replays the retained
suffix in order. The machines, their invariants, and trace compaction are in
[client state machines](canopy-browser/document-admission.md).

## Verification machinery

Bun tests, TypeScript checking, shared JSON and SSE fixtures, and Swift
Package Manager tests. The usual gates are in [DEVELOPMENT.md](../DEVELOPMENT.md).
Diagnostics that are not gates: `bun tests/performance/merge-history.bench.ts`
(synthetic, in memory), `bun tests/performance/replay-update-cost.ts <copy>` (per-phase
timings replaying edits on a copy of host data), and
`bun tests/performance/benchmark-merge-tool.ts`. Language-neutral vectors under
[`spec/conformance/`](../spec/conformance/README.md) are the portable part; reference
API and algorithm fixtures live under [`tests/fixtures/`](../tests/fixtures/README.md).
