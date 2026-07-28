# Shared trees and the wire
*Part of the [Arbor spec](../spec.md): shared-tree identity, canonical names, access, synchronization, and publication.*

## 1. Promotion creates the boundary

An ordinary filesystem directory has no durable Arbor tree identity. Choosing **Give this subtree a URL** promotes it in one operation: reserve a stable opaque `TreeID` and canonical name, snapshot and upload the directory, verify the initial remote tip, attach its existing private journal/index/recovery state to the `TreeID`, and replace the local placement. Failure must leave the directory and any legacy private state usable.

Promotion starts private synchronization for the owner's devices. Publication and recipient sharing operate on that already existing shared tree; neither creates or changes its identity. The promoted directory remains at the same filesystem path unless its owner later moves the placement.

Different people place one identity wherever it belongs:

```text
Joe                              Alice
projects/atlas/                  work/atlas/
             └──── same shared TreeID ────┘
```

A tree may contain a nested independent tree. The parent object records a boundary entry containing the child `TreeID`, not a duplicate of the child's graph. Access never inherits across that boundary. Owner devices may follow and place the child automatically; other readers resolve it under the child's own grant or publication mode and otherwise see an unavailable/private child.

## 2. Identity and canonical names

Every shared tree has a stable opaque `TreeID`. Its authority-independent fallback is:

```text
arbor://tree/<TreeID>/path
```

These canonical forms, local paths, and optional immutable root selections are unified as user-facing [Arbor locators](locators.md). The wire still exchanges resolved `TreeID`s, paths, refs, and object hashes; it does not interpret shell-relative paths.

A named authority is a namespace that can contain multiple shared-tree boundaries. It resolves the first path segment to a `TreeID`, then resolves the remaining path within that tree:

```text
https://notes.example/atlas/essay
arbor://notes.example/atlas/essay
```

The personal reference server exposes `/.well-known/arbor/<slug>` and permits one immutable slug segment per tree. The complete namespace model permits richer named namespaces. A dedicated whole-domain alias is represented as a tree mounted at `/`; no alternate identity mechanism is needed.

Canonical name is descriptive and citable, not authority. Renaming a namespace alias, moving a placement, or moving the authority does not change `TreeID`. Credentials and invitations never appear in canonical URLs. Naming is universal; access is not.

## 3. Publication, invitations, and grants

A tree has one whole-tree publication mode:

- `private`: anonymous resolution and publication return 404;
- `public-read`: anyone may resolve and read the current tip;
- `public-write`: anyone may read and submit compare-and-swap mutations, subject to rate and storage limits.

Recipient grants coexist with these modes. An invitation is a signed descriptor that identifies the `TreeID`, authority hints, subtree, rights, optional expiry, and a revocable grant. Rights are concrete (`read`, `append`, `update`, and the structural actions implied by the grant). Grants may be adjusted or revoked without changing tree identity or deleting cached recipient work.

The authority computes effective remote rights from publication plus grants and validates every operation. A recipient may further attenuate access locally—for example, place a writable grant read-only. Effective access is:

```text
authority grant or public mode
∩ local placement ceiling
∩ current process/component grant
```

Invitation acceptance stores secrets in `system:credentials`, never in Markdown links or `trees.yaml`, then asks the recipient for a local placement. Read-only annotations live in an overlay. After revocation, already cached content remains explicitly stale/read-only and overlay work remains local; new remote reads or pushes fail.

## 4. One tip and immutable objects

Each `TreeID` has exactly one authoritative mutable **root hash**:

| Plane | Mapping | Mutability |
|---|---|---|
| Ref | `TreeID → root hash` | atomic CAS |
| Objects | `hash → DAG-CBOR node/blob` | immutable |

Paths are immutable nodes reached by walking that Merkle graph. They are not independent mutable refs. Objects use deterministic DAG-CBOR, hash-verifiable bytes, sorted unique directory entries, and explicit nested-tree boundary entries. Large bodies may be chunked without changing the ref model.

The live authority surface is:

```text
GET  /.arbor/trees/{TreeID}/ref
POST /.arbor/trees/{TreeID}/push
GET  /.arbor/trees/{TreeID}/watch
GET  /.arbor/objects/{hash}
```

A push carries the expected root hash, proposed root hash, and referenced new objects. The authority verifies hashes, complete graph validity, quotas, authentication, and access before atomically moving the tip. A stale expected hash returns a ref conflict with the current tip. Subtree grants do not create path refs: the authority diffs the expected and proposed graphs and rejects changes outside allowed paths or rights.

Object access is authorized by reachability: an owner or recipient may fetch objects reachable from a tree they can read; anonymous readers may fetch only objects reachable from public trees. Knowing a private hash is not authorization.

## 5. Sync, partial reads, and conflicts

A client fetches the root then walks only hashes required by the requested subtree, so one whole-tree tip does not require whole-tree transfer. `watch` announces tip movement; reconnect begins from a fresh ref read and Merkle comparison.

When exactly one side advanced from the common root, arbord pushes or materializes the new tip. When both sides changed, arbord performs a three-way merge where defined. Text conflicts and unsupported structured conflicts preserve both versions for reconciliation; Arbor never discards either branch merely to make the tip advance. Whole-database SQLite snapshots conflict as databases until logical changesets are specified.

**One replicator per subtree.** Arbor and iCloud/Dropbox may partition different subtrees or layer with one arbord as the sole wire peer. Two independent systems may not symmetrically replicate the same subtree between the same devices. Cloud eviction placeholders are unavailable content, never bytes to hash or index.

## 6. Authority and HTTP publication projection

The authority contract requires immutable objects and atomic tree tips; it does not require materialized files or TreeHopper's local storage strategy. A reference host may materialize current tips to reuse local services, but that is an implementation choice.

A companion publication gateway projects the current tip at its canonical HTTP URL. It may be co-deployed with the authority:

- private trees return 404 anonymously;
- public-read surfaces omit mutation controls;
- public-write surfaces expose anonymous CAS mutation with rate/storage limits and an explicit warning about effective access;
- authenticated recipient surfaces expose exactly their effective rights;
- credentials, private recovery, reflog/old tips, and inaccessible nested children are never published.

Static baking is a separate profile: `arbor bake` emits a read-only ref/object snapshot for a dumb HTTP host. Custom deployed applications may advertise the live tree through `<link rel="arbor">` or an `Arbor-Tree` response header, but are not the canonical live publication requirement.

## 7. Store profiles

Plain files and Markdown map directly into immutable nodes and blobs. SQLite is captured through checkpoint/backup as a consistent snapshot, materialized as the same database on another device, and treated as a whole-database CAS unit. A Postgres collection keeps its named server as authority: Arbor synchronizes only a safe connection reference while each device supplies its own secret credential.
