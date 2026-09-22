# canopyd 013: Entry metadata and the document-version index

Status: IMPLEMENTED 2026-09-22. Server deployed (steps 1–3, migration 014 live); Arbor Sync and
client steps 4–5 built the same day, with two deliberate changes from the steps below:
- The daemon does not forward metadata. Every client (Mac included) reads `/entry-metadata`
  from canopyd itself, and the bootstrap simply drops `modifiedAtByPath`.
- No schema or format bump. Nodes carry `metadata: EntryMetadata` and still decode the old
  `modifiedAt` key; each open fetches Canopy's dates and applies them
  (`WorkingTree.applyEntryDates`: authoritative for the accepted update, otherwise only
  filling undated nodes), so an existing iPhone replica gains dates without being re-placed
  and without archiving unsynced work. Written the same day after ccaeb760 fixed pending-view
dates on the Mac.

As built, `document_versions` keeps a rowid for accepted order (the newest version is the
largest rowid, independent of clock ties) and is unique on `(tree_id, stable_key, update_id,
entry_path)`, so two files sharing an ID in one update both land. `entryChanges` reports a
moved file as set at its new path; the version index then skips it when its content hash is
unchanged. The Swift wire mirror of the route moves to step 5 with the client that reads it.
Also carries the storage half of [canopyd 007](007-canopy-document-history.md)
(the `document_versions` index), so both backfills share one history replay and
one migration. 007 keeps its routes, access rule and History UI.

## Context

The Canopy sidebar groups pages by recency (`ArborSidebarPages.recentGroups`,
`swift/CanopyApp/ArborRootView.swift:149`). The only dates a client has come
from:

- **Mac placed trees:** the daemon `stat`s each body file while bootstrapping
  (`sparseSpine`, `packages/arborsync/src/service.ts:68`) and sends
  `modifiedAtByPath`, keyed by logical page path.
- **Any client:** a node is stamped with the client's clock when it changes
  locally or an update arrives (`applyModificationDates`,
  `WorkingTree.swift`).

A tree placed directly from canopyd has no dates at all. That covers the
iPhone always, Mac trees without a daemon placement, and visits. Every page
shows under "Unknown date" until it happens to change. Files never carry a date
either: `WorkingTree.state(from:)` drops `modifiedAt` for `.file` nodes.

We also want room for more file-like metadata later: created time, Finder
tags and other xattrs, maybe the executable bit.

## Design

### Two kinds of metadata

- **Content-bearing** metadata changes what an entry *is*: the executable bit,
  a symlink target. It belongs in the directory entry and so in the hashes, as
  in git. It is not part of this plan. Directory entries are CBOR maps, so a
  later plan can add a key without disturbing this one.
- **Descriptive** metadata describes an entry's history or presentation:
  modified time, created time, tags. It stays **outside the hashes**. Otherwise
  identical content would hash differently per device and per edit time, and a
  no-op sync would stop being a no-op. `arborsync-api.md` already takes this
  position for dates. This plan covers descriptive metadata only.

### Keyed by directory-entry path

Metadata belongs to directory entries, such as `/Cleaning.md`,
`/Trips/_index.md` or `/Trips/map.png`. It does not belong to logical pages.
The server stays ignorant of page layout rules, and files get dates the same
way pages do. `SnapshotBridge` already knows which entry is each node's body:

- a markdown node's `<name>.md`,
- a directory node's `_index.md`, or else its sibling `<dir>.md`,
- a file node's own entry.

So it maps entry metadata onto nodes. Directory entries get no `modifiedAt`,
because a directory's page date is its body's. The key space still admits
directories for future tags.

A move is a change at the new path, which matches the client, where a move
already stamps the node (see the moved-page case in ccaeb760's test).

### Server: one side table, written with the accepted update

```sql
CREATE TABLE entry_metadata (
  tree_id TEXT NOT NULL REFERENCES trees(id),
  path TEXT NOT NULL,          -- "/a/b.md", a file entry of the current root
  modified_at INTEGER NOT NULL, -- accepted_at (ms) of the update that last changed it
  update_id TEXT NOT NULL,     -- that update
  data_json TEXT,              -- future descriptive fields; NULL today
  PRIMARY KEY (tree_id, path)
) WITHOUT ROWID;
```

- The table always describes the tree's **current** accepted root. It is not
  history. Rows exist exactly for the file entries of that root.
- **Computing the change.** Object reads are async and the accepted-update write
  is a synchronous SQLite transaction (`AcceptedUpdateStore.insertWithinTransaction`,
  `packages/canopyd/src/updates/store.ts:209`). So compute the change first,
  beside the existing `acceptedTransitionPayload(previousRoot, root)` calls
  (`canopy.ts:660, 1741, 1938, 2115, 2318`).
  - A new `entryChanges(before, after, load)` returns `{ set: string[], removed: string[] }`.
  - `set` holds every file entry whose value changed or is new, including all
    files under a newly added directory.
  - `removed` holds every file path that is gone. A removed directory expands to
    a path prefix.
  - It is modeled on `changedEntryPaths` (`updates/entry-ambiguity.ts:200`), but
    that helper stops at an added or removed directory and reports directory
    metadata changes, so it can't be reused as is.
  - For an initial update, `before` is the empty directory.
- **Writing the rows.** Add `entryChanges?` to `AcceptedUpdateInput`
  (`store.ts:21`). A new `EntryMetadataStore`, created from
  `AcceptedUpdateStore.createSchema` like the other stores, applies it inside
  `insertWithinTransaction`: upsert `set` with the update's `accepted_at` and
  id, and delete `removed`. Every insert path goes through there, so it cannot
  miss a kind the way `checkpointIntent` once missed `lazy`.
  - A caller that omits `entryChanges` for a non-initial update is a bug. Make
    it required in the type rather than optional once all eight call sites pass
    it.
- `data_json` fields never change the `modified_at` rule. Future writers
  (tags) update `data_json` without touching `modified_at`.

### Document versions (the storage half of canopyd 007)

The same `entryChanges` walk also feeds 007's private, rebuildable index:

```sql
CREATE TABLE document_versions (
  tree_id TEXT NOT NULL,
  stable_key TEXT NOT NULL,     -- "id:<PageID>" or "path:<entry path>"
  update_id TEXT NOT NULL REFERENCES accepted_updates(id),
  entry_path TEXT NOT NULL,     -- "/Trips/_index.md" at that update
  content_hash TEXT NOT NULL,   -- the Markdown file object; source is never copied
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (tree_id, stable_key, update_id)
) WITHOUT ROWID;
CREATE INDEX document_versions_newest ON document_versions (tree_id, stable_key, accepted_at DESC, update_id);
```

**Identity rules** (frozen here, because the backfill bakes them in):

- A Markdown entry is any file entry whose name ends in `.md`, including
  `_index.md` and a directory's sibling body.
- **`stable_key`** is `id:<value>` when the file's frontmatter has exactly one
  `id:`. This is the same rule as `WorkingTreeSemantics.pageID(in:)`, and the TS
  twin lives beside the walk. Otherwise the key is `path:<entry path>`.
  - A move of an unidentified document therefore starts a new key. That is
    007's "path fallback stops at the first move".
  - Uniqueness is not checked at index time. Two documents sharing an ID both
    land under one key, and 007's read routes fail explicitly on that, as its
    contract already says.
- **A row is written** when the file-object hash for a key differs from that
  key's previous row, including its first appearance. A move without a content
  change writes no row, which is 007 contract rule 1.
  - This needs the keys of moved files. `entryChanges` also reports
    moved-without-change paths, so the walk reads those files' IDs. Unchanged
    files are never read.
- **Deleted documents** keep their rows. The history outlives the entry, and a
  later read route decides what to disclose.
- **Earliest-history boundary.** The backfill starts at each tree's first
  accepted update. If a retained root is missing it stops with an error rather
  than inventing continuity. The 013-compact audit found every accepted root
  retained, so rehearsal is expected to confirm that, not hit it.

`entryChanges` returns, per changed Markdown path, the new content hash and the
page ID read from it. That's async, so it's done before the transaction. The
same `EntryMetadataStore.apply` inserts `document_versions` rows in the same
transaction, keeping one commit seam.

### Wire

The snapshot stays pure: it's immutable and content-addressed, and metadata is
not a function of the root. Changes are additive, with clean breaks where
anything is renamed (sole user).

- **`GET /.arbor/trees/{id}/entry-metadata`**, with read access at `/`.
  - Response: `{ update, entries: { "/a.md": { modifiedAt: 1789… }, … } }`,
    as of the current accepted update.
  - Unknown keys inside an entry are ignored by clients, so adding `createdAt`
    or `tags` later is not a wire break.
  - Per-path read scoping follows the snapshot route's disclosure rule. If the
    snapshot is whole-tree read today, so is this.
  - Declare it in `packages/protocol/src/transport.ts` beside `snapshot`, with
    a decoder there and a Swift mirror in `ArborWireClient.swift` and
    `WireModels.swift`.
- **Watch needs no change.** Each transition already carries
  `update.acceptedAt` (`AcceptedUpdate`, `protocol/src/updates/types.ts:31`).
  The client stamps nodes changed by an incoming transition with that time
  instead of its own clock.
- **Arbor Sync bootstrap** replaces `modifiedAtByPath` (logical paths, file
  mtimes) with `entryMetadata`, the same shape and entry-path keys, forwarded
  from canopyd. The daemon stops `stat`ing bodies. Every occurrence to update
  is listed under step 4.

### Client

- A new struct `EntryMetadata { modifiedAt: Date? }`, Codable and Equatable,
  in `CanopyWorkingTree`.
  - `WorkingTreeSystemNode.modifiedAt` and `WorkingTreeNode.modifiedAt` become
    `metadata: EntryMetadata`, including on `.file` nodes. That fixes
    `state(from:)`'s dropped file dates.
  - The search index entry keeps a `modifiedAt` projection, since that's all
    the sidebar reads.
- `SnapshotBridge.replacement(entryMetadata: [String: EntryMetadata])` replaces
  `modifiedAtByPath`, looked up by each node's body entry path as described
  above.
- `applyModificationDates` takes the stamp time from the caller:
  - the transition's `acceptedAt` for system replacements,
  - `clock()` for local edits and local projections.
  It carries the whole `metadata` value forward for unchanged nodes, so
  future fields survive projections (the fork from ccaeb760 already carries
  whole nodes).
- **Placement** (`WorkingTreePlacementService.place`, `ArborVisitSnapshot`,
  `openPlacedTree`) fetches `entry-metadata` after the snapshot and passes it
  in.
  - If the metadata's `update` is newer than the snapshot's, a few rows may
    describe edits the client doesn't have yet. The watch delivers those edits
    moments later with their own `acceptedAt`, so accept the skew rather than
    retry.
- `WorkingTreeState.currentSchema` 2 → 3 for the node shape.
  `ArborAppModel.workingTreeFormat` "5" → "6", so the iPhone and Mac app-owned
  replicas re-place from a fresh snapshot, and that is what brings dates to
  iOS.

## Steps

### 1. Server table, change walk and writes
- `packages/canopyd/src/updates/entry-metadata.ts`: `entryChanges` (with
  Markdown content hashes and page IDs) and `EntryMetadataStore`
  (`createSchema`, `apply(tree, update, acceptedAt, changes)`, `entries(tree)`,
  `documentVersions(tree, stableKey)` for tests and the later 007 routes).
  It owns both tables.
- `store.ts`: `AcceptedUpdateInput.entryChanges`, applied in
  `insertWithinTransaction`. Cascade `createSchema`.
- `canopy.ts`: compute `entryChanges` at all eight insert sites (1743, 1942,
  662, 2124, 2376 accepted; 796, 1078, 2351 initial) next to the transition
  payload they already build.
- `schema.ts`: `CANOPY_SCHEMA_VERSION` "15" → "16", add the table to
  `AUTHORITY_SCHEMA`, and extend `assertCurrentCanopySchema` to require a row
  set for every tree. A cheap count check is enough: rows exist iff the tree's
  root has file entries.
- Tests (`tests/unit/canopyd/entry-metadata.test.ts`):
  - edit, add, remove, move, directory add/remove, and a merged update;
  - document versions: a row per content change and none for a pure move of
    an identified page, a new `path:` key after moving an unidentified page,
    and rows kept after deletion;
  - rows always equal the file entries of the current root;
  - `modified_at` changes only on changed paths.

### 2. Offline migration `packages/canopyd/migrations/014-entry-metadata/`
- Create both tables. Backfill each tree by replaying `accepted_updates` in
  order, running `entryChanges(previous_root, root)` with each row's
  `accepted_at`, then stamp the schema version.
  - This is O(history × changed paths) and runs offline, so budget it on a
    Railway backup copy first.
- **Seed option:** history before the 2026-09 cutover is gone. So entries
  unchanged since a tree's first accepted update would all read as the cutover
  date. The migration takes an optional seed file (`tree → entry path → ms`),
  made from the Mac placed folders' file mtimes, and uses the seed where an
  entry's only stamp is the tree's first update. See the open question below.
- It follows `migrations/README.md`: back up first, rehearse on a copy until
  `verify.ts` passes, quiesce writers, run, verify, then delete the directory
  once the rollback window closes.
- **Gated on Joe's go-ahead** before it touches Railway.

### 3. Wire route
- `host.ts`: `GET /.arbor/trees/{id}/entry-metadata`, next to the snapshot
  route (:492).
- Protocol decoder and conformance vector in
  `docs/overstory-spec/conformance/`, plus a Swift mirror and test.
- Document it in `docs/overstory-spec` next to the snapshot read, stating that
  descriptive metadata is not part of any hash.

### 4. Arbor Sync
- `packages/arborsync/src/service.ts`: bootstrap forwards canopyd's
  `entryMetadata`, and `sparseSpine` drops its `stat` loop.
- Update every occurrence of `modifiedAtByPath`:
  - `packages/arborsync-client/src/index.ts:90`
  - `ArborSyncClient` `Protocol.swift` and `ArborSyncRESTClient.swift`
  - `ArborAppModel.swift:853`
  - `tests/unit/protocol.test.ts:84`
  - `tests/integration/server.test.ts` (359, 408, 429, 454)
  - `tests/fixtures/arborsync/bootstrap*.json`
  - `LoopbackServicesTests.swift`
  - `docs/implementing-sync-services/arborsync-api.md` (242, 266)
  - `plans/canopy-web/025-arbor-web.md:33`

### 5. Client
- `EntryMetadata`, the node shape change, the `SnapshotBridge` lookup by body
  entry, and the `acceptedAt` stamping described above.
- Placement fetches metadata, and the schema and format numbers are bumped.
- Tests:
  - `WorkingTreeRecencyTests`: bootstrap by entry path, with a directory body
    via `_index.md` and via its sibling `.md`, and a file node.
  - A transition stamps `acceptedAt`, not the clock.
  - The pending-view test from ccaeb760 still passes.

### 6. Deploy
Server and migration first, then the daemon, Mac and iPhone together. The
format bump re-places app-owned replicas on first launch.

## Open questions

- **Seeding from Mac mtimes.** Worth it, or accept that pages untouched since
  the cutover show under "Earlier" with the cutover date? That is still better
  than "Unknown date". The seed would be a one-time script run against the
  placed folders. It needs no daemon change.
- **Created time.** Should `createdAt` come now, since it's free: the first
  `set` for a path? Or wait for a use? Recommend waiting. The struct and wire
  already leave room.

## Verification
- Unit tests above, `bun run test`, `swift test --package-path
  swift/Packages/CanopyWorkingTree`, and the app build through
  `swift/Canopy.local.xcworkspace`.
- Migration rehearsal on a Railway backup copy:
  - row counts match the file entries of every current root;
  - `verify.ts` passes;
  - there's a timing report.
- iPhone: after the format bump re-places the Console tree, the sidebar
  shows Today / This Week / This Month / Earlier groups, and "Unknown date"
  appears only for entries with no stamp.
- Edit on the Mac, then watch the iPhone: the page moves to Today, stamped
  with the server's `acceptedAt`.
