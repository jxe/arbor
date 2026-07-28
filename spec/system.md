# The `system:` tree, placements, and durability
*Part of the [Arbor spec](../spec.md): safe control records, workspace composition, credentials, and local durability.*

## 1. Safe control state

Arbor's canonical local state home is `~/.arbor`; `ARBOR_DATA_HOME` selects an isolated alternate root. Arbord exposes safe control state as an unshadowable process-local `system:` tree through the ordinary REST node/children/event surface. It is not a physical mirror, publishable content, or a generic provider-action API.

The complete control tree includes:

```text
system:device
system:server
system:trees/<TreeID>
system:trees/<TreeID>/shares/<GrantID>
system:credentials
system:visited
system:diagnostics
```

`system:device` supplies safe machine-local facts. `system:server` records the configured personal authority origin and credential status, never its token. Tree records combine canonical names, current ref/sync/publication state, effective access, placements, nested boundaries, and owner-visible remote trees. Share records expose recipient, subtree, rights, status, and revocation metadata without bearer secrets. Credentials expose only safe names/status; visited records describe transient cached trees.

Safe changes emit ordinary ordered `tree: "system"` events. Concrete `SystemOperation` mutations use the same durable IDs, receipts, retries, and conflicts as content mutations, but cannot be batched with filesystem/content operations because their authority and rollback domains differ ([arbord-rest.md](arbord-rest.md)).

`configureServer` sends the owner token directly to the OS credential store. Its durable record and journal contain only normalized origin, credential reference, and token digest. Logs, receipts, events, diagnostics, and errors never expose raw credentials. The same rule applies to database DSNs and invitation grants.

## 2. From local paths to shared-tree placements

Unpromoted filesystem content has no durable tree record. It remains browsable and safely editable through:

```ts
{ tree: "local", path: "/absolute/os/path" }
```

There is no normative durable `source: local` tree. Older `source: local` entries are migration input only: TreeHopper shows them as **Needs a URL**, keeps their private index/journal/recovery state, and never deletes them automatically. Promotion reattaches that state to the new `TreeID` before replacing the legacy entry.

The authored placement registry is `~/.arbor/trees.yaml`, keyed by canonical local paths. A shared placement is explicit:

```yaml
"/Users/joe/notes":
  source: "arbor://tree/tr_7f3q2ab7c/"
  tree: tr_7f3q2ab7c
  canonical: "arbor://notes.example/notes"
  endpoint: "https://notes.example"
  ref: "sha256:…"
  access: write
  publication: private
```

The source names identity, not local position. The key is the reader's placement. Access is a local ceiling, ref is the last materialized common tip, and endpoint is a replaceable hint. A recipient accepting an invitation chooses a placement; the inviter's filesystem path never becomes the recipient's.

One tree may appear in multiple positions, and distinct nested trees may occupy overlapping path prefixes because nested boundaries are real identities. Longest-boundary resolution selects the innermost tree. A parent placement stores only the nested child `TreeID`; parent rights do not cross into it.

Arbord materializes shared trees as ordinary files for editors and agents. Userfs/FUSE is not required. The registry is atomically replaced and fully validated before activation; invalid YAML, incomplete shared records, unsafe moves, and ambiguous identity produce `system:diagnostics` while the last valid configuration remains active.

Overlays shadow a read-only placement with reader-local files. Visited trees use a private TTL cache until **Add to workspace** creates a durable placement. History records `(TreeID, path, revision)`. Agent confinement assembles a process-specific namespace from only the placements and controls that agent may use.

Effective access is:

```text
remote grant or public mode ∩ local placement ceiling ∩ process/component grant
```

## 3. Local durability, Trash, and recovery

Each shared tree has private per-device workspace state for its journal, search index, page-ID map, and recovery history. This state never resides inside publishable content. An authored change is journaled before filesystem materialization and receives a durable mutation receipt before success is acknowledged. Retrying the same mutation ID with identical intent returns the same receipt; reusing it with different intent is a conflict.

External editor or agent writes are observed as external snapshots, not falsely claimed as Arbor-authored intent. A block removed through Arbor is intentionally purged; a block absent after an external rewrite is lost. Both remain recoverable, and neither leaks into the tree, search, sync, or publication.

Deleting a node is a soft move to the tree's `Trash/`, preserving identity and original location. Recovery queries are per tree/subtree and combine Trash with lost/purged Markdown history. Cross-device changes arrive as wire revisions and are journaled on local application so stale local state cannot resurrect a peer deletion.

Unpromoted local scope intentionally has a smaller contract: byte-CAS Markdown edits and plain filesystem structural actions remain safe, but durable page identity, indexing, recovery, Trash, synchronization, and permissions begin only after promotion.
