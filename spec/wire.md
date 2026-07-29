# Shared trees and the wire
*Part of the [Arbor spec](../spec.md): shared-tree identity, canonical names, access, synchronization, and publication.*

## 1. Promotion creates the boundary

An ordinary filesystem directory has no durable Arbor tree identity. Choosing **Give this subtree a URL** promotes it in one operation: reserve a stable opaque `TreeID` and canonical name, snapshot and upload the directory, verify the initial remote tip, attach its existing private journal/index/recovery state to the `TreeID`, and replace the local placement. Failure must leave the directory and any legacy private state usable.

Promotion starts private synchronization for the owner's devices. Public and person-specific access operate on that already existing shared tree; neither creates or changes its identity. The promoted directory remains at the same filesystem path unless its owner later moves the placement.

Different people place one identity wherever it belongs:

```text
Joe                              Alice
projects/atlas/                  work/atlas/
             └──── same shared TreeID ────┘
```

A tree may contain a nested independent tree. The parent object records a boundary entry containing the child `TreeID`, not a duplicate of the child's graph. Access never inherits across that boundary. Owner devices may follow and place the child automatically; other readers resolve it under the child's own access list and otherwise see an unavailable/private child.

The shared tree is both the synchronization and permission boundary. Access entries never name a path inside a tree. To share a subtree under different terms, its owner first gives that subtree its own URL; promotion replaces the parent graph's child entry with an independent nested-tree boundary. Sharing the parent never exposes the child, and sharing the child never exposes its parent.

## 2. Identity and canonical names

Every shared tree has a stable opaque `TreeID`. Its authority-independent fallback is:

```text
arbor://tree/<TreeID>/path
```

These canonical forms, local paths, and optional immutable root selections are unified as user-facing [Arbor locators](locators.md). The wire still exchanges resolved `TreeID`s, paths, refs, and object hashes; it does not interpret shell-relative paths.

A named authority is a namespace that can contain multiple shared-tree boundaries. It normally resolves the first path segment to a `TreeID`, then resolves the remaining path within that tree:

```text
https://notes.example/atlas/essay
arbor://notes.example/atlas/essay
```

The personal reference server exposes `/.well-known/arbor` for the optional personal root and `/.well-known/arbor/<slug>` for one immutable slug segment per child tree. Mounting the owner's public personal tree at `/` makes `arbor://alice.example/` name Alice while `/atlas` remains an independently permissioned tree boundary. The complete namespace model permits richer named namespaces. Longest registered boundary wins; mounting a tree at `/` does not cause its access to inherit into named child trees.

Canonical name is descriptive and citable, not authority. Renaming a namespace alias, moving a placement, or moving the authority does not change `TreeID`. Credentials and claim secrets never appear in canonical URLs. Naming is universal; access is not.

## 3. Whole-tree access

Each tree has one access list. Its subjects are:

- its owner's personal tree, with implicit management and write access;
- a known personal tree, with `read` or `write`;
- an unclaimed access link, with `read` or `write`;
- a same-authority group file, with `read` or `write`;
- the special subject `everyone`, with `none`, `read`, or `write`.

The familiar publication modes are projections of the `everyone` entry, not a second permission system:

- `private` means `everyone: none`;
- `public-read` means `everyone: read`;
- `public-write` means `everyone: write`, subject to rate and storage limits.

A person is represented by the dedicated public-read personal tree registered at their authority root. Its root is an ordinary identity-bearing Markdown document with `type: person`; its first heading is the display name and the rest of its body is the authored public profile. The personal tree's `TreeID` is the stable access subject; its canonical root locator is the human-facing identity. Display names are mutable, non-unique content and never authority. Device credentials prove control of the personal tree, and the tree's owner may pair or replace devices without changing the identity used by access entries. A `type: person` document elsewhere is ordinary content and does not become an access subject merely by declaring the type.

The personal tree always has `everyone: read`, never public write. That requirement applies only to the identity tree: independently registered or nested project trees at the same authority retain their own private/read/write access.

A group subject is one identity-bearing Markdown file in a shared tree. Its locator resolves to `(TreeID, PageID)`; its frontmatter lists direct personal-tree locators, while its first heading and body remain ordinary authored name and description. Member locators resolve to stable personal `TreeID`s, so renaming a person or changing their profile does not alter membership. The containing tree's writers author membership, and membership changes use its normal revisions, conflicts, history, and recovery. The group document may be the root of a dedicated public group tree, creating a profile-shaped canonical locator symmetrical with a personal tree, but it may also live inside any appropriate administrative tree. Resource access remains whole-tree: each referencing tree independently assigns the group `read` or `write`. This specification requires direct person members and same-authority group/resource resolution; nested groups and cross-authority group proofs are deliberately deferred.

When the owner does not yet know a person's personal-tree locator, Arbor creates a revocable single-claim **access link**. It is a delivery mechanism, not another persistent content identity:

```text
https://notes.example/.arbor/access/<AccessID>#<claim-secret>
```

The URL fragment keeps the secret out of ordinary HTTP requests and server logs. Arbord reads the complete link, sends the secret only to the claim endpoint, and atomically binds that access entry to the claimant's personal `TreeID`. The claim returns the resource tree's credential-free canonical locator. `browse` may continue to that locator; `sync <access-link> <local-path>` claims and places it idempotently. Claiming is part of resolving the link, not a separate product action. A claimant without a personal tree first gets the same small profile-initialization flow used by ordinary onboarding.

Raw claim secrets are never journaled. The creating client generates the secret, the authority stores only its digest, and safe records expose only link identity, access, and claimed/revoked status. After a claim or direct person addition, credentials live in the operating-system credential store. Removing an entry stops new reads and pushes while leaving already materialized files explicitly stale and read-only.

Remote access is only `read` or `write`. Append-only, operation-specific, path-scoped, and delegated rights are not part of this model. A local placement or process may still choose a stricter ceiling; that is local workspace policy, not a remote share.

The authenticated access-control surface is correspondingly small:

```text
GET   /.arbor/trees/{TreeID}/access
POST  /.arbor/trees/{TreeID}/access
PATCH /.arbor/trees/{TreeID}/access/{AccessID}
POST  /.arbor/access/{AccessID}/claim
```

The owner lists safe entries, creates a personal-tree or claim-digest entry, and changes its access/status. Claim is the only operation that accepts the raw secret; it atomically verifies the digest, binds the entry to the claimant's personal `TreeID`, and issues the claimant's devices a tree credential. Repeating the completed claim as the same person returns the same canonical tree and credential status.

## 4. One tip and immutable objects

Each `TreeID` has exactly one authoritative mutable **root hash**:

| Plane | Mapping | Mutability |
|---|---|---|
| Ref | `TreeID → root hash` | atomic CAS |
| Objects | `hash → DAG-CBOR node/blob` | immutable |

Paths are immutable nodes reached by walking that Merkle graph. They are not independent mutable refs. Objects use deterministic DAG-CBOR, hash-verifiable bytes, sorted unique directory entries, and explicit nested-tree boundary entries. Large bodies may be chunked without changing the ref model.

The live tree-data surface is:

```text
GET  /.arbor/trees/{TreeID}/ref
POST /.arbor/trees/{TreeID}/push
GET  /.arbor/trees/{TreeID}/watch
GET  /.arbor/objects/{hash}
```

A push carries the expected root hash, proposed root hash, and referenced new objects. The authority verifies hashes, complete graph validity, quotas, authentication, and whole-tree write access before atomically moving the tip. A stale expected hash returns a ref conflict with the current tip.

Object access is authorized by reachability: an owner or person with access may fetch objects reachable from a tree they can read; anonymous readers may fetch only objects reachable from trees with `everyone: read` or `everyone: write`. Knowing a private hash is not authorization.

## 5. Sync, partial reads, and conflicts

A client fetches the root then walks only hashes required by the requested subtree, so one whole-tree tip does not require whole-tree transfer. `watch` announces tip movement; reconnect begins from a fresh ref read and Merkle comparison.

When exactly one side advanced from the common root, arbord pushes or materializes the new tip. When both sides changed, arbord performs a three-way merge where defined. Text conflicts and unsupported structured conflicts preserve both versions for reconciliation; Arbor never discards either branch merely to make the tip advance. Whole-database SQLite snapshots conflict as databases until logical changesets are specified.

**One replicator per subtree.** Arbor and iCloud/Dropbox may partition different subtrees or layer with one arbord as the sole wire peer. Two independent systems may not symmetrically replicate the same subtree between the same devices. Cloud eviction placeholders are unavailable content, never bytes to hash or index.

## 6. Authority and HTTP publication projection

The authority contract requires immutable objects and atomic tree tips; it does not require materialized files or TreeHopper's local storage strategy. A reference host may materialize current tips to reuse local services, but that is an implementation choice.

A companion publication gateway projects the current tip at its canonical HTTP URL. It may be co-deployed with the authority:

- trees with `everyone: none` return 404 anonymously;
- `everyone: read` surfaces omit mutation controls;
- `everyone: write` surfaces expose anonymous CAS mutation with rate/storage limits and an explicit warning;
- authenticated person surfaces expose their whole-tree `read` or `write` access;
- credentials, private recovery, reflog/old tips, and inaccessible nested children are never published.

Static baking is a separate profile: `arbor bake` emits a read-only ref/object snapshot for a dumb HTTP host. Custom deployed applications may advertise the live tree through `<link rel="arbor">` or an `Arbor-Tree` response header, but are not the canonical live publication requirement.

## 7. Store profiles

Plain files and Markdown map directly into immutable nodes and blobs. SQLite is captured through checkpoint/backup as a consistent snapshot, materialized as the same database on another device, and treated as a whole-database CAS unit. A Postgres collection keeps its named server as authority: Arbor synchronizes only a safe connection reference while each device supplies its own secret credential.
