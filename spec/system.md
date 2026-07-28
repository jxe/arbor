# The `system:` tree, tree placements, and durability
*Part of the [Arbor spec](../spec.md): arbord's control views, workspace resolution, tree placements, and the local durability model.*

## 1. The `system:` tree and workspace resolution

Arbor's canonical local state home is `~/.arbor` on every platform. `ARBOR_DATA_HOME` selects an isolated alternate root for tests and special-purpose processes. On first default launch, arbord moves an existing platform-specific state directory to `~/.arbor` and leaves a compatibility symlink where supported; if both locations contain real data it uses `~/.arbor`, refuses to merge them, and reports a diagnostic.

The one authored placement registry is `~/.arbor/trees.yaml`. Its keys are canonical absolute paths in the reader's filesystem:

```yaml
"/Users/joe/src/arbor":
  source: local

"/Users/joe/reading/railton":
  source: "arbor://tree/tr_7f3q2ab7c/papers/facts-and-norms"
  revision: tip
  access: read
  overlay: "local:annotations/railton"
```

`source: local` is implemented now: the folder already at the key path is the authority, and Arbor persistently indexes, watches, journals, and recovers it. An `arbor://` source names a shared tree or subtree; it becomes operational with the wire milestone. The URL names content only. Revision selection, the local access ceiling, overlays, and optional endpoint hints remain separate placement policy and never hide in the URL.

Private local `RootID`s are compatibility scope tags for REST, events, indexes, and journals. They never appear in `trees.yaml`. `~/.arbor/workspaces.json` associates them and private workspace-state directories with canonical paths and filesystem identity, preserving state across an unambiguous same-filesystem move. A shared source instead retains content identity through its `TreeID` when its placement key changes.

The display name of a placement is the first nonempty H1 in its `_index.md`, falling back to the directory basename. Merely tracking a folder never creates or edits `_index.md`.

Arbord provides an unshadowable, process-local `system:` control tree through the same node/query surface, but that logical tree is not a physical mirror, part of the workspace, or publishable content. Today `system:roots/<RootID>` is a read-only compatibility projection of the `source: local` entries. Later control views may combine authored files, Keychain references, verified caches, and derived runtime state. A logical node does not require a corresponding imaginary file on disk.

Arbord watches `trees.yaml`. It applies a candidate only after the complete document validates; invalid YAML, noncanonical paths, overlaps, unsupported sources, or unsafe active moves produce system diagnostics while the last valid in-memory configuration remains active. Arbor-authored changes preserve comments and entry order and replace the file atomically.

`system:connections` follows the same rule. A record may show driver, host, database, user, and connection status while saying only that its secret is stored in Keychain. Pasting a connection string into TreeHopper or the CLI creates the safe record and credential entry together.

`arbor connection set|test|remove` maintains the same private human-readable connection records and operating-system credentials exposed through `system:connections`; it is a CLI over that state, not a temporary format. The Bun reference daemon uses `Bun.secrets` as its platform credential adapter. DSNs never enter tree files, generated declarations, logs, diagnostics, or HTTP payloads. A `_store.postgres` file can therefore name `system:connections/production` without an environment-variable or plaintext-DSN convention.

Arbord materializes the workspace, including mounted trees, as real files because agents and editors assume them. Userfs/FUSE access is not specified.

- **Overlays** are the annotation and fork primitive. Local files shadow a read-only source; upstream remains untouched, and “propose upstream” is a diff of the overlay.
- **Visited trees** are transient placements backed by an arbord-private cache, TTL'd and garbage-collected. “Add to workspace” creates a durable `trees.yaml` entry.
- **History** records `(tree, path, revision)` so back/forward can return to the version actually seen.
- **Agent confinement** is a restricted workspace view containing only the paths, mounts, and system capabilities granted to that agent. Launching an agent may assemble a fresh namespace for it in the Plan 9 manner: a per-process mount set placing exactly the subtrees its job concerns at paths chosen for that agent, independent of the human's workspace layout. The agent's namespace is ordinary mount records scoped to the process, so grants, overlays, and provenance work unchanged inside it.

Mount `mode` is a local ceiling, never a grant. Effective access is:

```text
remote grant ∩ local mount policy ∩ current process/component grant
```

## 2. A tree entry places content in a workspace

The path-keyed placement value is deliberately small:

```ts
type TreePlacement = {
  source: "local" | ArborURL;
  revision?: "tip" | ObjectHash;
  access?: "read" | "write";
  overlay?: LocalTreeRef;
  via?: URL[];
};
```

A placement is reader-controlled. A share invitation proposes a source; accepting it creates an ordinary entry at the recipient's chosen local path without turning the inviter's path into the recipient's path.

One identity may occupy many positions at once. A workspace may place the same shared tree — or different subtrees of it — at several path keys simultaneously; all are live views of the same tree. Canonical position ([wire.md](wire.md) §2), personal placements, and per-agent namespaces (§1) are three kinds of position over one identity, so rearranging a workspace never breaks names.

Relative links are resolved in the workspace. Script imports use ES-module semantics: they are resolved once and locked to object hashes for the lifetime of an execution, so a later mount change cannot silently replace code already running. Reader code overrides are explicit.

## 3. Local durability: journal, trash, and recovery

Arbord keeps a per-workspace, per-device **write journal** in its private store — never inside the tree, so deleted content can never leak into `grep`, git, sync, or deploys. Markdown history is keyed by durable document `PageID` rather than current path. Writes arbord authors are journaled before the file write lands (a crash between the two heals on next open); writes it merely observes — an external editor, an agent writing files directly — are absorbed as snapshots without claimed authorship. The distinction is the point: a block deleted through an Arbor edit is *deleted on purpose* and tombstoned; a block missing after a foreign write is *lost*, and arbord never infers intent from writes it didn't make. Both remain restorable through a recovery surface.

An authored REST mutation adds its mutation ID and stable request hash to that same durable intent, then records the completed receipt before acknowledging success. Retrying the same request returns that receipt rather than applying intent twice, including after arbord restarts. The reference implementation retains these records instead of adding receipt expiry or a separate idempotency database. Exact acknowledgement, conflict, and event-handoff semantics are in [arbord-rest.md](arbord-rest.md).

The journal is local-only: cross-device intent travels as shared-tree revisions on the wire ([wire.md](wire.md)), which arbord also journals on apply so local state cannot resurrect a peer's deletion.

Deleting a page is a soft delete to an in-tree `Trash/` folder mirroring the source structure; restore returns it to its original path. The page's journal is unaffected — history is keyed by identity, not location.
