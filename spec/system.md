# The `system:` tree, mounts, and durability
*Part of the [Arbor spec](../spec.md): arbord's control tree, workspace resolution, mounts, and the local durability model.*

## 1. The `system:` tree and workspace resolution

The mount table is native Arbor state, not a magic content file. Arbord provides an unshadowable, process-local control tree addressed as `system:`:

```text
system:
  mounts/
  trees/
  connections/
  shares/
  credentials/
  history/
  visited/
  trust/
  diagnostics/
```

It is accessed through the same tree/query surface and rendered by built-in views, but it is not part of the workspace or any publishable shared tree. Durable records are canonical human-readable files under the local Arbor system directory; SQLite may index them but is never their only editable representation. Secrets remain in Keychain or the platform credential store and appear only as opaque references.

Each record in `system:mounts` has a durable identity and a friendly source alias. Its raw form is intentionally understandable:

```md
---
source: railton-papers
from: /papers/facts-and-norms
at: /reading/railton
access: read
version: latest
overlay: local:annotations/railton
---

# Railton, annotated
```

`system:trees/railton-papers` resolves the alias to its `TreeID`, endpoint hints, and credential reference. Normal editing should not require copying opaque IDs. TreeHopper renders a mount as an editable sentence or table row—“Mount **Railton papers** at **reading/railton**, read-only, following **latest**, with **my annotations**”—while source view, CLI, and direct file editing remain equivalent. Invalid edits produce `system:diagnostics` and leave the last valid configuration active.

`system:connections` follows the same rule. A record may show driver, host, database, user, and connection status while saying only that its secret is stored in Keychain. Pasting a connection string into TreeHopper or the CLI creates the safe record and credential entry together.

`arbor connection set|test|remove` maintains the same private human-readable connection records and operating-system credentials exposed through `system:connections`; it is a CLI over that state, not a temporary format. The Bun reference daemon uses `Bun.secrets` as its platform credential adapter. DSNs never enter tree files, generated declarations, logs, diagnostics, or HTTP payloads. A `_store.postgres` file can therefore name `system:connections/production` without an environment-variable or plaintext-DSN convention.

Arbord materializes the workspace, including mounted trees, as real files because agents and editors assume them. Userfs/FUSE access is not specified.

- **Overlays** are the annotation and fork primitive. Local files shadow a read-only source; upstream remains untouched, and “propose upstream” is a diff of the overlay.
- **Visited trees** are transient mounts recorded under `system:visited`, backed by an arbord-private cache, TTL'd and garbage-collected. “Mount this” promotes one into `system:mounts`.
- **History** records `(tree, path, revision)` so back/forward can return to the version actually seen.
- **Agent confinement** is a restricted workspace view containing only the paths, mounts, and system capabilities granted to that agent. Launching an agent may assemble a fresh namespace for it in the Plan 9 manner: a per-process mount set placing exactly the subtrees its job concerns at paths chosen for that agent, independent of the human's workspace layout. The agent's namespace is ordinary mount records scoped to the process, so grants, overlays, and provenance work unchanged inside it.

Mount `mode` is a local ceiling, never a grant. Effective access is:

```text
remote grant ∩ local mount policy ∩ current process/component grant
```

## 2. A mount places a shared tree in a workspace

The mount record is deliberately small:

```ts
type Mount = {
  at: Path;
  source: {
    tree: TreeID;
    path: Path;
    revision: "tip" | ObjectHash;
  };
  overlay?: LocalTreeRef;
};
```

A local mount is reader-controlled. A share invitation proposes a mount that becomes active only when its recipient accepts it; accepting creates an ordinary local mount without turning the inviter's path into the recipient's path.

One identity may occupy many positions at once. A workspace may mount the same shared tree — or different subtrees of it — at several paths simultaneously; each mount is an independent record, and all are live views of the same tree. Canonical position ([wire.md](wire.md) §2), personal mounts, and per-agent namespaces (§1) are three kinds of position over one identity, so rearranging a workspace never breaks names.

Relative links are resolved in the workspace. Script imports use ES-module semantics: they are resolved once and locked to object hashes for the lifetime of an execution, so a later mount change cannot silently replace code already running. Reader code overrides are explicit.

## 3. Local durability: journal, trash, and recovery

Arbord keeps a per-workspace, per-device **write journal** in its private store — never inside the tree, so deleted content can never leak into `grep`, git, sync, or deploys. Markdown history is keyed by durable page ID rather than current path. Writes arbord authors are journaled before the file write lands (a crash between the two heals on next open); writes it merely observes — an external editor, an agent writing files directly — are absorbed as snapshots without claimed authorship. The distinction is the point: a block deleted through an Arbor edit is *deleted on purpose* and tombstoned; a block missing after a foreign write is *lost*, and arbord never infers intent from writes it didn't make. Both remain restorable through a recovery surface.

An authored REST mutation adds its mutation ID and stable request hash to that same durable intent, then records the completed receipt before acknowledging success. Retrying the same request returns that receipt rather than applying intent twice, including after arbord restarts. The reference implementation retains these records instead of adding receipt expiry or a separate idempotency database. Exact acknowledgement, conflict, and event-handoff semantics are in [arbord-rest.md](arbord-rest.md).

The journal is local-only: cross-device intent travels as shared-tree revisions on the wire ([wire.md](wire.md)), which arbord also journals on apply so local state cannot resurrect a peer's deletion.

Deleting a page is a soft delete to an in-tree `Trash/` folder mirroring the source structure; restore returns it to its original path. The page's journal is unaffected — history is keyed by identity, not location.
