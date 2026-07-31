# The `system:` tree, placements, and durability
*Part of the [Arbor spec](../spec.md): safe control records, workspace composition, credentials, and local durability.*

## 1. Safe control state

Arbor's canonical local state home is `~/.arbor`; `ARBOR_DATA_HOME` selects an isolated alternate root. Arbord exposes safe control state as an unshadowable process-local `system:` tree through the ordinary REST node/children/event surface. It is not a physical mirror, publishable content, or a generic provider-action API.

The complete control tree includes:

```text
system:device
system:community
system:profiles/<ProfileTreeID>
system:trees/<TreeID>
system:trees/<TreeID>/access/<AccessID>
system:credentials
system:visited
system:diagnostics
```

`system:device` supplies safe machine-local facts. `system:community` records the active community origin, account/handle, person profile `TreeID`/URL, community `TreeID`/URL, and credential reference—never the account token. Profile records are keyed by stable person/group profile `TreeID`. Tree records combine canonical boundary path, current ref/sync state, public/effective access, local placement, kind, parent boundary, and account-visible remote trees. Access records expose `profile`, `link`, or `everyone`, safe resolved identity, and `read`/`write`/`none` without credentials or link secrets.

Safe changes emit ordinary ordered `tree: "system"` events. Concrete `SystemOperation` mutations use the same durable IDs, receipts, retries, and conflicts as content mutations, but cannot be batched with filesystem/content operations because their authority and rollback domains differ ([arbord-rest.md](arbord-rest.md)).

`connectCommunity` sends an account/device token directly to the OS credential store. Durable state contains only normalized origin, safe account/community metadata, credential reference, and digest. `setTreeAccess` hashes a link secret before durable intent. Logs, receipts, events, diagnostics, and errors never expose raw credentials. The same rule applies to database DSNs.

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
  canonical: "arbor://garden.example/~joe/notes"
  endpoint: "https://garden.example"
  ref: "sha256:…"
  access: write
  publicAccess: none
```

The source names identity, not local position. The key is the reader's placement. `access` is a local ceiling, `publicAccess` projects the `everyone` entry, ref is the last common tip, and endpoint is replaceable. Canonical boundary records live at the community authority independently of these local placements.

One tree may appear in multiple positions, and distinct nested trees may occupy overlapping prefixes because nested boundaries are real identities. Longest-boundary resolution selects the innermost accessible tree. An external local placement may project as a virtual child beneath a profile whose physical folder is elsewhere; no duplicate directory or synthetic Markdown is created. A parent graph stores only the nested child `TreeID`; parent rights do not cross into it, and ordinary writes that replace its reserved path fail with `reserved-boundary`.

Arbord materializes shared trees as ordinary files for editors and agents. Userfs/FUSE is not required. The registry is atomically replaced and fully validated before activation; invalid YAML, incomplete shared records, unsafe moves, and ambiguous identity produce `system:diagnostics` while the last valid configuration remains active.

Overlays shadow a read-only placement with reader-local files. Visited trees use a private TTL cache until **Add to workspace** creates a durable placement. History records `(TreeID, path, revision)`. Agent confinement assembles a process-specific namespace from only the placements and controls that agent may use.

Effective access is:

```text
remote tree access ∩ local placement ceiling ∩ process/component ceiling
```

## 3. Local durability, Trash, and recovery

Each shared tree has private per-device workspace state for its journal, search index, page-ID map, and recovery history. This state never resides inside publishable content. An authored change is journaled before filesystem materialization and receives a durable mutation receipt before success is acknowledged. Retrying the same mutation ID with identical intent returns the same receipt; reusing it with different intent is a conflict.

External editor or agent writes are observed as external snapshots, not falsely claimed as Arbor-authored intent. A block removed through Arbor is intentionally purged; a block absent after an external rewrite is lost. Both remain recoverable, and neither leaks into the tree, search, sync, or publication.

Deleting a node is a soft move to the tree's `Trash/`, preserving identity and original location. Recovery queries are per tree/subtree and combine Trash with lost/purged Markdown history. Cross-device changes arrive as wire revisions and are journaled on local application so stale local state cannot resurrect a peer deletion.

Unpromoted local scope intentionally has a smaller contract: byte-CAS Markdown edits and plain filesystem structural actions remain safe, but durable page identity, indexing, recovery, Trash, synchronization, and permissions begin only after promotion.
