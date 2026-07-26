# Shared trees and the wire
*Part of the [Arbor spec](../spec.md): shared-tree identity, names, and access, and the protocol that synchronizes them — refs, objects, sync, and static publication.*

## 1. From an ordinary folder to a shared tree

The common collaboration case begins with an ordinary folder in someone's workspace. Choosing **Share this folder** gives it an independent identity, history, permission boundary, and sync stream. Arbor moves the folder's backing data behind that boundary and leaves a mount at the same workspace path, so the workspace does not visibly change.

Recipients choose where the shared tree belongs in their own workspaces:

```text
Joe                              Alice
projects/atlas/                  work/atlas/
             └──── same shared TreeID ────┘
```

This is the essential distinction: the shared tree has one identity, while Joe and Alice control its placement ([system.md](system.md) §2). Moving the folder within a workspace changes only that person's mount. Ordinary local folders need no special identity at all.

## 2. Identity and public names

A **shared tree** is the unit the wire can watch, fetch, update, and grant access to. Every shared tree has a stable opaque `TreeID`; moving it between servers, mounting it elsewhere, or changing its public name does not change that identity.

A domain is an optional human-readable alias for a shared tree, not its identity. A DNS `_arbor` TXT/SVCB record resolves a domain to an endpoint plus `TreeID`:

```text
notes.example.org
  → endpoint=https://arbor.example.org
  → tree=tr_7k3m…
```

Private and team trees need no domain: a share descriptor (§3) supplies `(TreeID, endpoint hints, grant)` directly. Endpoint hints are replaceable and may be refreshed through a signed tree descriptor, so an endpoint move does not change identity. One reference endpoint may host many unrelated shared trees.

Every node therefore has a global resolvable name — `(TreeID, path)` — including every node of a private tree. Its absolute URL is `arbor://notes.example.org/path` when a DNS alias exists or `arbor://tree/<TreeID>/path` otherwise. The tree identity is stable; the path is a human name that may change. Markdown document URLs may include the target `PageID` fragment when they need rename continuity, while ordinary files remain path-addressed ([urls.md](urls.md)). Naming is universal; access is not. Resolving a private name requires a grant, so links to private material are safe to embed anywhere and simply fail to resolve without one. Credentials and invitation tokens never appear in links, and Arbor never treats an obscure name as a secret.

A shared tree may additionally record a **canonical position**: an absolute `arbor://` URL declaring its home within another namespace (for example, `arbor://team.example.org/handbook`). Canonical position is descriptive metadata for citation, documentation, and discovery. It is not a mount in anyone's workspace and never routes or grants access; readers, teams, and agents place the same tree wherever suits them.

## 3. Invitations and permissions

“Share this folder” creates grants and sends invitations after creating the shared tree. “Stop sharing” changes grants; it does not silently delete recipients' cached or overlaid work.

An invitation is a signed descriptor:

```ts
type ShareDescriptor = {
  tree: TreeID;
  root: Path;
  endpoints: URL[];
  grant: Capability;
};
```

V1 capabilities are revocable bearer tokens scoped to a shared tree, subtree, rights (`read`, `append`, `update`), and optional expiry. The endpoint enforces them on every ref read, watch, and push. A recipient may attenuate an rw grant locally by mounting read-only; secrets are stored in `system:credentials`, never embedded in links. Group identities and cryptographically attenuable capabilities are not specified.

Permissions belong to shared trees and operations, not workspace paths or public names. A domain alias routes to a tree; it never grants access.

## 4. The protocol

The reference endpoint stores refs, grants, and immutable objects. Its private database/layout is not part of the wire contract; Arbor does not define a server-storage plugin interface. Content addressing is a wire artifact, not a mandate for how arbord stores ordinary local workspace files. The endpoint is the always-on **wire host** role of the "Daemon roles" section in [spec.md](../spec.md) — operationally separable from the on-demand local workspace daemon, which participates here as a wire client.

Two planes:

| Plane | What | Mutability | Served by |
|---|---|---|---|
| Refs | `(TreeID, path) → tip hash` | live | authority |
| Objects | `hash → node/blob` | immutable | anyone |

Objects use deterministic CBOR (JSON by content negotiation). A node contains kind, props, body/bodyRef, children `(name, hash)`, and optional schema metadata. Large bodies split into blobs. Child hashes make each directory a Merkle root.

The live reference profile is:

```text
GET  /tree/{treeID}/ref/{path}
GET  /obj/{hash}
POST /tree/{treeID}/push
GET  /tree/{treeID}/watch/{path}
```

`push` is a capability-authenticated CAS update and returns 409 on a stale ref. Objects are self-verifying and globally cacheable; refs are small authority statements.

## 5. Sync and liveness

When a ref moves, arbord fetches the new root and recursively fetches only changed child hashes. Pinned mounts never consult refs. CAS conflicts merge at arbord, git-style. CRDT collaboration is not specified.

Ref-watch provides coarse invalidation; Merkle diff identifies changed nodes; recorded read sets select the queries to re-run. Evaluation remains local unless an upstream-hosted query ([scripts.md](scripts.md) §2) places it at the endpoint.

**One replicator per subtree.** Arbor coexists with foreign sync (iCloud Drive, Dropbox) under one rule: for any subtree, between any pair of replicas, exactly one system is responsible for replication. Two shapes satisfy it — *partition* (different subtrees on different transports) and *layering* (foreign sync beneath exactly one arbord, which treats delivered changes as external writes and is the sole wire endpoint — the relay pattern). Symmetric overlap — two arbords wire-syncing a subtree that foreign sync also replicates between them — is refused or warned: concurrent conflicts would be resolved twice by two different merge systems, and the divergent resolutions propagate. `system:trees` records foreign replication (declared or detected via placeholder files), `arbor share` checks it, and stores must treat cloud-eviction placeholders as "not materialized," never as content.

## 6. Collection backing and synchronization

Store drivers decide how a logical node becomes wire objects. The first SQLite profile is deliberately conservative:

- Arbord checkpoints or uses SQLite's backup API to capture a consistent `.sqlite3` snapshot.
- The snapshot is stored as a blob (chunked when useful), verified, and materialized as the same database file on another machine.
- Queries and mutations run locally against that materialized database.
- Concurrent database revisions are whole-database CAS conflicts. Arbor preserves both versions and asks for reconciliation; it never attempts a byte-level merge that could corrupt the database.

This supports personal/offline/multi-device databases with no configuration beyond placing the file. Logical SQLite changesets and row-level database merging are not specified.

A Postgres-backed collection has different synchronization semantics: the named Postgres server is already the shared authority. Arbor synchronizes the safe connection reference while each device supplies its own credential record. Table snapshots, offline replicas, and conversion into Arbor objects are not specified.

## 7. Static publication and content-centric caching

The immutable half naturally permits static read-only publication, but it is a later conformance profile rather than the founding server. `arbor bake` emits a shared tree's refs and objects for nginx, S3, GitHub Pages, or any dumb HTTP host. Such an origin provides snapshots or deployment-updated tips but no push/watch.

Clients fetch from their local object store and then the configured tree endpoint. LAN discovery and mirror cascades are not specified.

Arbor scripts are also, deliberately, a web framework, which yields a dual-publication bridge: the same tree can be rendered and deployed as an ordinary website on Vercel, Cloudflare, or any static or server host. A deploy tool may publish both surfaces at once and crosslink them — the website emits `<link rel="arbor" …>` and/or an `Arbor-Tree:` response header carrying `(endpoint, TreeID)`, and an Arbor-aware browser landing on the website upgrades to the live tree, while legacy browsers see plain HTML. The legacy hatch ([browser.md](browser.md) §3) is the same mechanism in reverse.
