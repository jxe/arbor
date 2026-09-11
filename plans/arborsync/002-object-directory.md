# Arbor Sync 002: The object directory

> **Executor instructions**: Follow this plan phase by phase. Run every
> verification command and confirm the expected result before moving to the
> next phase. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. Preserve unrelated working-tree changes. When the
> implementation is complete, move this file to `plans/_done/arborsync/` with
> its identifier unchanged, record the verification evidence there, and update
> both plan indexes.
>
> **Drift check (run first)**:
> `git diff --stat <Arbor Sync 001 done commit>..HEAD -- packages/fs/src/wire-tree.ts packages/stores/src/object-index.ts packages/arborsync/src packages/arborsync-client/src packages/canopy-client/src/sync-state.ts packages/canopy-client/src/tree-sync.ts packages/cli/src/index.ts packages/core/src/protocol.ts native/Packages/ArborObjectStore native/Packages/ArborSyncClient native/ArborApp/ArborAppModel.swift tests/integration/server.test.ts tests/performance docs/arborsync-api.md docs/local-system.md docs/reference-implementation.md`
> If the walker port, the index schema, the descriptor shape, or the Swift
> `DirectoryObjectStore` layout changed, refresh the excerpts and file:line
> references below before writing code.

## Status

- **Priority**: P1 (the second piece of "Rearchitect Arbor Sync" in
  `plans/README.md`)
- **Effort**: L
- **Risk**: MEDIUM (no wire change; one new on-disk structure the daemon must
  keep consistent; the loopback object route is deleted)
- **Depends on**: [Arbor Sync 001](001-file-bytes-are-the-object.md) landed,
  migrated, and soaked. Do not start before the soak is recorded.
- **Answers**: `plans/open-questions.md` item 9.
- **Category**: daemon architecture, local storage, native client
- **Planned at**: commit `231d16a`, 2026-09-11

## Why this matters

Arbor Sync makes placed folders content-addressable and keeps them equal to
Canopy's accepted root. Today the content-addressable part is tangled with the
synchronization loop: the folder walker, the SQLite path-to-hash index with
its stat tuples, the directory re-encoder, an in-memory fetch-through cache,
and the loopback route `GET /v1/objects/{hash}` all live inside the daemon,
and other processes reach the store only over HTTP
(`packages/arborsync/src/object-cache.ts`, `server.ts:213-230`).

After Arbor Sync 001 a file on disk *is* its object. The interface that
follows is a directory: `${ARBOR_DATA_HOME}/objects/<TreeID>/<hex>`, where a
file object is a hardlink to the real inode and a directory object is a small
file the maintainer writes. A reader opens, reads, and verifies. The daemon
stops owning a read surface; the sync engine becomes a client of a store it
can inspect with `ls` and check with `shasum`. The route is deleted rather
than reduced: the web editor will get its own backend before it is restored,
so no HTTP consumer remains.

Costs, measured before the question was promoted (`plans/open-questions.md` item 9 at commit `d5c02f6`): a hardlink costs a directory entry and shares the inode, so file objects are free and only retained old versions cost their size until GC. Every option pays the same file read and hash on lookup, and the lookup itself (an open, or a SQLite query of tens of microseconds) is noise beside it; the only overhead worth removing is the loopback HTTP hop of a few hundred microseconds plus one copy, and only when many small objects are fetched in a burst. The walk still needs path-to-hash rows with stat tuples to know which links are stale, so the SQLite index stays and the directory is a second structure kept consistent with it. Same volume only; cross-volume falls back to copying. A key-value store would buy nothing over either: it either dangles like a pointer or copies like git.

What the carve-out is, honestly: not "a hardlinker" but the walker, the index,
and the materializer of `objects/<TreeID>/`, in one package that arborsync
composes in-process. A separate process would need its own watcher; one
watcher, one walker, one index is the invariant.

## Design decisions

### D1. Package and naming

New workspace package `packages/object-store` published as
`@arbor/object-store`, the TypeScript twin that
[Native 023](../native/023-rebuild-the-web-editor-on-the-working-tree.md)
reserved, with two entry points so the root stays browser-safe.

| TypeScript `@arbor/object-store` (root entry) | Swift `ArborObjectStore` | Role |
|---|---|---|
| `ObjectStore { bytes(hash) }` | `ObjectStore` | verified read by hash |
| `verifyObject(bytes, hash)` | `verifyObject` | throws on mismatch |
| `ObjectStoreError` (`missing`, `hashMismatch`, `io`) | `ObjectStoreError` | same cases |
| `InMemoryObjectOverlay` | `InMemoryObjectOverlay` | overlay with `retain(reachableFrom:)`, walking by entry kind |
| `LayeredObjectStore(overlay, platform)` | `LayeredObjectStore` | overlay first |
| `ChainedObjectStore(stores)` | `ChainedObjectStore` (new) | first store that does not throw `missing` wins |
| `CanopyObjectStore(client, tree)` | `CanopyObjectStore` | the Wire object route |

| TypeScript `@arbor/object-store/directory` (Bun only) | Swift | Role |
|---|---|---|
| `DirectoryObjectStore(directory, { readOnly? })` | `DirectoryObjectStore` plus a new `init(readingFrom:)` that neither creates nor chmods | flat `<dir>/<hex>` layout, verify-on-read, `store()`, `hashes()`, `retain()` |
| `ObjectIndex` (moved from `@arbor/stores`, schema unchanged) | none | path to hash with the stat tuple |
| `ObjectDirectory` (the maintainer, D3) | none | keeps `objects/<TreeID>/` equal to a placed folder |

- Dependencies: `@arbor/core`, `@arbor/wire`, `@arbor/fs` (for
  `snapshotDirectory`). `@arbor/fs` must never import `@arbor/object-store`;
  the walker's `SnapshotObjectIndex` port stays in `@arbor/fs`.
- `tsconfig.json` paths: `"@arbor/object-store"` and
  `"@arbor/object-store/directory"`; `package.json` `exports` for `.` and
  `./directory`. A boundary test like `tests/unit/wire/package-boundary.test.ts`
  asserts the root entry never mentions `bun:sqlite`, `node:fs`, `@arbor/fs`,
  or `@arbor/canopy`.
- Layout is flat hex with no `sha256:` prefix and no sharding, exactly the
  layout Swift `DirectoryObjectStore` already reads
  (`native/Packages/ArborObjectStore/Sources/ArborObjectStore/DirectoryObjectStore.swift:17`),
  so the Mac reuses it unchanged.
- Naming: `ObjectDirectory` is the maintained thing; `DirectoryObjectStore` is
  the reader. Do not call the maintainer a store. It is what keeps a store true.

### D2. Location and keying

`${ARBOR_DATA_HOME}/objects/<TreeID>/<hex>`.

- Keyed by TreeID, not by the workspace's stateID: `bindWorkspaceIdentity`
  (`packages/stores/src/private-state.ts:290-310`) guarantees one path per
  TreeID per machine, `arbor mv` keeps the TreeID, and clients know TreeIDs.
  The SQLite index stays in the stateID-keyed workspace directory
  (`<.state>/workspaces/<stateID>/index.sqlite`) because it is private to the
  walk.
- `LocalTreeDescriptor.objectsPath?: string` (TypeScript
  `packages/core/src/protocol.ts:149`, Swift `Protocol.swift:93`) names the
  directory so clients never guess the layout. Present for `placed` and
  `replica` placements that are not `missing`; absent for `remote`.
- Pathless replicas and the account-configuration checkout are `Workspace`s
  like any other (`tree-manager.ts:261, 437, 480`) and get an object directory
  the same way.
- Unplacing a tree removes `objects/<TreeID>/` where the placement is dropped.
- Nested trees: the walker stops at a boundary and emits `{name, tree}`
  (`packages/fs/src/wire-tree.ts:152-155`); nothing below a boundary is ever
  linked into the parent's directory. The nested tree is its own placement
  with its own directory.
- Same volume only for links. A folder on another volume (an external disk)
  falls back to copying; that is a cost, not a failure.

### D3. `ObjectDirectory`

```ts
export interface ObjectDirectoryOptions {
  root: string;                        // the placed folder, realpath
  directory: string;                   // ${ARBOR_DATA_HOME}/objects/<TreeID>
  index: ObjectIndex;                  // <.state>/workspaces/<stateID>/index.sqlite, owned here now
  boundaries(): ReadonlyMap<string, string>;
  exclusions(): readonly string[];
  describeCollectionFile?: DescribeSnapshotCollectionFile;
  retainedRoots(): Promise<Hash[]>;    // accepted root, pending candidate roots, conflict draft and candidate roots
}

export class ObjectDirectory {
  snapshot(): Promise<LazyTreeSnapshot>;        // the walk: links files, writes directories, remembers rows
  forget(...absolutePaths: string[]): void;     // watcher invalidation (rule 3)
  store(objects: Iterable<{ hash: Hash; bytes: Uint8Array }>): Promise<void>;  // publish pending-body objects
  verify(): Promise<{ removed: Hash[] }>;       // read and hash every member; unlink corrupt ones
  gc(): Promise<{ unlinked: number }>;          // retain current root ∪ retainedRoots(); sweep the rest
  rebuild(): Promise<void>;                     // uncached walk (today's revalidateObjectIndex) then gc
  reader(): DirectoryObjectStore;
}
```

Mechanics. Each is an invariant with a test in Phase A.

1. **File link.** After the walker hashes `absolute` to `H`:
   `link(absolute, <dir>/<hex(H)>)`. `EEXIST` is fine (verified lazily).
   `EXDEV` falls back to copy into `<dir>/.<uuid>.tmp`, fsync, `link` into
   place, unlink the temp (Canopy's pattern,
   `packages/canopy/src/objects.ts:145-183`). **Then re-stat `absolute` and
   remember that tuple.** `link(2)` bumps the file's `ctime`, and index rows
   key on `ctime_ns` (`packages/stores/src/object-index.ts:31`). Remembering
   the pre-link stat would invalidate every row on the next walk and re-hash
   the whole folder every time.
2. **Directory write.** Bytes are in hand from the walker's `rememberDirectory`
   port. Write temp, fsync, `link` into place, unlink temp; never `rename`
   over an existing object; fsync the directory.
3. **Invalidation.** `forget(absolute)` reads the stored row first. If it is a
   `file` row with hash `H` and `stat(<dir>/<hex(H)>)` reports the same
   `(ino, dev)` as the row, the object is unlinked: the inode was edited in
   place (Vim, `sed -i`), so the link now holds wrong bytes. Otherwise (a
   rename-style save produced a new inode) the old object stays readable until
   GC. `rebuild()`'s row-disagreement path applies the same rule after watcher
   gaps. Verify-on-read remains mandatory in every reader regardless.
4. **Retention.** Mark from the current folder root (last walk) plus
   `retainedRoots()`, walking directory objects in `<dir>` by entry kind: a
   `file` member is a leaf; a `directory` reference whose object is absent ends
   that branch. Sweep unlinks the rest. GC runs after each revalidation (the
   existing 30 minute cadence, `workspace.ts:83`) and on `rebuild`. Walks and
   GC are serialized per tree.
5. **Pending objects.** An object that only ever lived in a pending request
   body (the folder moved on before the request was sent, or a conflict draft)
   is not in `<dir>` unless published. arborsync calls `store()` with the
   request's envelopes when it persists a pending update
   (`savePendingTreeUpdate`, `appendPendingTreeSuccessor` in
   `packages/canopy-client/src/sync-state.ts`) and with the draft objects when
   it stores a conflict. Retention then keeps them through `retainedRoots()`.
6. **Standalone.** `arbor objects verify|rebuild|gc <folder>` in
   `packages/cli/src/index.ts`, beside `daemon`, `place`, and `mv`. It resolves
   the placement from `placements.yaml`, opens the same index and directory,
   and refuses `rebuild` and `gc` while the control daemon reports the
   placement active. `verify` is always safe.

### D4. Clients read the directory; Canopy stays behind it on the Mac

The Mac app's platform store for a placed tree becomes
`ChainedObjectStore([DirectoryObjectStore(readingFrom: objectsPath), CanopyObjectStore(client, tree)])`.
The directory answers everything the folder holds; Canopy covers the window
in which a file was edited in place after the app read the spine but before
it read the object. The app already holds a credentialed `ArborWireClient`
at that point (`ArborAppModel.swift:826-833`). A visit of an unplaced tree
uses `CanopyObjectStore` directly, which is already the fallback at
`ArborAppModel.swift:981-985`; the `?origin=` route is gone.

## Current repository state

Confirm these facts during the drift check:

- `packages/arborsync/src/workspace.ts:178` opens `ObjectIndex` at
  `<state>/index.sqlite`; `:193-198` hands it to `snapshotDirectory`;
  `:210-236` revalidates (and emits the only `diagnostic` event for silently
  changed files); `:990-992` and `:1025-1038` invalidate on watcher events.
- `packages/arborsync/src/object-cache.ts` resolves a hash from the index
  (`:70-84`, deleting the row on mismatch at `:80-81`), the pending body
  (`:119-130`), then Canopy through a 64 MiB LRU (`:132-142`).
- `packages/arborsync/src/service.ts:301-341` (`bootstrapTree`) and
  `packages/canopy-client/src/tree-sync.ts:91-98, 234, 301` walk through
  `workspace.objectIndex()`; the walk's root decides `blocked: "unsettled"`
  and the candidate root pushed to Canopy.
- The static file surface (`server.ts:327-340`, `workspace.ts:538-547`) reads
  the folder directly and does not touch the index.
- `packages/canopy-client/src/sync-state.ts:66-121` stores the pending update
  with inline object envelopes at `<.state>/sync/<tree>.json`.
- Swift `DaemonObjectStore` (`ArborSyncLoopbackServices.swift:45-73`) wraps
  the route; `ArborAppModel.swift:786-848` opens a placed tree with it,
  `:925-942` calls `client.object(tree:hash:)` directly to re-pack an adopted
  request, `:950-1000` opens visits.
- `native/ArborApp/ArborSupportDirectories.swift:5-13` computes the data home
  (`$ARBOR_DATA_HOME` or `~/.arbor`) and the app already reads
  `placements.yaml` and account YAML from it directly.
- `tests/performance/object-index.bench.ts` measures cold, warm, and
  incremental walks over 50,000 files through `Workspace.open`.
- Nothing sweeps orphaned `.arbor-write-*` or `.arbor-txn-*` files today, and
  there is no object GC of any kind.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Product tests | `bun run test` | exit 0 |
| Protocol conformance | `bun run test:protocol` | pass |
| Walk benchmark | `bun run test:performance` | warm walk within today's bound; link count asserted |
| Standalone verify | `bun run arbor -- objects verify <placed folder>` | `0 corrupt`, member count equals the folder's file and directory count |
| Swift object store | `swift test --package-path native/Packages/ArborObjectStore` | exit 0 |
| Swift sync client | `swift test --package-path native/Packages/ArborSyncClient` | exit 0 |
| Swift working tree | `swift test --package-path native/Packages/ArborWorkingTree` | exit 0 |
| App tests | the `Arbor` scheme in `native/project.yml` through Xcode | green |
| Diff hygiene | `git diff --check` | no output |

Never run raw SwiftPM commands against `native/Packages/ArborQuagmire`.

## Scope

### In scope

- `packages/object-store/` (new), `packages/stores/src/{index,object-index}.ts`
  (move), `tsconfig.json`, root `package.json` only if the root imports it
- `packages/arborsync/src/{workspace,service,tree-manager,server,object-cache,events}.ts`
- `packages/canopy-client/src/{tree-sync,sync-state}.ts` (walk and pending
  publication hooks only)
- `packages/arborsync-client/src/index.ts`, `packages/core/src/protocol.ts`
- `packages/cli/src/index.ts` (`arbor objects`)
- `native/Packages/ArborObjectStore` (`ChainedObjectStore`,
  `DirectoryObjectStore.init(readingFrom:)`),
  `native/Packages/ArborSyncClient` (`Protocol.swift`, `ArborSyncRESTClient.swift`,
  `ArborSyncLoopbackServices.swift`, tests), `native/ArborApp/ArborAppModel.swift`
- `tests/unit/object-store/`, `tests/integration/object-directory.test.ts`,
  `tests/integration/server.test.ts`, `tests/performance/object-index.bench.ts`
- `docs/arborsync-api.md`, `docs/local-system.md`,
  `docs/reference-implementation.md`, `docs/client.md`,
  `spec/01-tree-operations.md:736-738`, `status.md`, `plans/README.md`,
  `plans/open-questions.md`, `plans/native/022-*.md`, `plans/native/023-*.md`

### Out of scope

- Any wire change (Arbor Sync 001 is complete before this starts).
- A separate daemon or process for the maintainer.
- An HTTP surface for the directory. The web editor's own backend is a later
  plan.
- iOS: the phone has no daemon and keeps its own `objects/` overlay.
- Sharding, packing, or a size limit for the directory.
- Sweeping the folder's orphaned transaction temp files (a separate cleanup).

## Git workflow

- Branch `codex/arborsync-002-object-directory` if needed.
- Commit Phase A and Phase B separately; Phase A must be green on its own with
  the route still serving.
- Do not push or deploy unless separately instructed.

## Phase A: the package and the maintainer, composed by arborsync, route still up

### Step A.1: `@arbor/object-store`

- Create the package per D1. Move `packages/stores/src/object-index.ts` to
  `packages/object-store/src/directory/object-index.ts`; `@arbor/stores` drops
  the export and the `bun:sqlite` import it carried for it.
- `src/index.ts`: the browser-safe set, including `CanopyObjectStore` over
  `WireClient.object`.
- `src/directory/{index,directory-object-store,object-index,object-directory}.ts`.
- `tests/unit/object-store/package-boundary.test.ts`.

### Step A.2: arborsync composes it

- `packages/arborsync/src/workspace.ts:169-190`: replace `new ObjectIndex(...)`
  with `new ObjectDirectory({...})`. `directory` is
  `join(arborDataRoot(), "objects", tree)`. `retainedRoots` reads
  `placement.ref`, every candidate root in `pendingTreeUpdate(tree)` and its
  successors, and the stored conflict's draft and candidate roots.
  `objectIndex()` returns the maintainer's port. `revalidateObjectIndex`
  becomes `objectDirectory.rebuild()`, and the `diagnostic` event for a
  silently changed file is re-homed there. Watcher paths (`:990-992`) call
  `forget(...)`. Dispose closes the index.
- `service.ts` (`bootstrapTree`, `snapshotWorkspace`) and
  `canopy-client/src/tree-sync.ts` walk through `snapshot()`: one walker, one
  index, one watcher.
- Pending persistence calls `store()` (D3 rule 5).
- Unplacement removes the directory (`tree-manager.ts`).
- `descriptor()` (`workspace.ts:239`) and `tree-manager.ts` add `objectsPath`;
  `packages/core/src/protocol.ts:149`, `packages/arborsync-client`, and Swift
  `Protocol.swift:93` carry it.
- `object-cache.ts`: `fromIndex` reads from `objectDirectory.reader()`. The
  pending and Canopy sources stay until Phase B so the route keeps its
  behavior.

### Step A.3: `arbor objects`

`verify`, `rebuild`, `gc` per D3 rule 6. Output is counts and hashes only.

### Step A.4: tests and the benchmark

`tests/unit/object-store/{directory-object-store,object-directory}.test.ts`
and `tests/integration/object-directory.test.ts` (daemon-composed). The
invariants, each its own test:

- **I1** For every `file` entry of the current root,
  `hashObject(readFile(objects/<hex>))` equals the entry hash, and the object
  and the folder path share `(ino, dev)` on the same volume. (daemon)
- **I2** An in-place edit (open `r+`, write, close, no rename): after the
  watcher event the old object is gone, the reader reports `missing`, and the
  next walk links the new hash. With the watcher gap simulated, `rebuild()`
  does the same. (daemon)
- **I3** A rename-style save: the old object stays readable and verifiable
  until `gc()`; `gc()` removes it once no retained root reaches it; `gc()`
  never unlinks anything reachable from `retainedRoots()` even after the
  folder has moved on.
- **I4** `EXDEV` (injected): the copy path yields a verifiable object with a
  different inode; `forget` does not unlink it; `gc` collects it later.
- **I5** A second walk with no changes reads zero files (spy on the port's
  `fileHash` hits or on `readFile`), which proves rule 1's post-link re-stat.
- **I6** A corrupt member (bytes overwritten in `<dir>`) is unlinked by
  `verify()` and never returned by the reader.
- **I7** No file below a nested boundary appears in the parent's directory;
  the nested tree's directory holds it.
- **I8** `store()` is idempotent; `EEXIST` with identical bytes is fine;
  different bytes for one hash throws.

`tests/performance/object-index.bench.ts`: add a link-count assertion
(50,000) and keep the warm-walk bound unchanged from today's. This is the
guard for rule 1.

### Step A.5: docs made true by Phase A

- `docs/local-system.md:5-33`: the data-home tree gains
  `objects/<TreeID>/<hex>`; `:35-52` moves the index paragraph under the
  maintainer and describes links, invalidation, and retention.
- `docs/reference-implementation.md:34-39`: `@arbor/object-store` exists; the
  daemon's folder is a working tree whose object store is the object
  directory.

### Phase A verification

`bun run typecheck && bun run test && bun run test:performance`;
`bun run arbor -- objects verify <placed folder>` on the developer Mac against
a real placement reports zero corrupt members.

## Phase B: delete the route; switch every client; docs

### Step B.1: delete

- `packages/arborsync/src/server.ts:213-230`; `service.ts` `objectBytes` and
  the cache composition (`:277-291`); `packages/arborsync/src/object-cache.ts`
  entirely (`OBJECT_HASH_PATTERN` moves to `@arbor/wire`).
- TypeScript `ArborSyncRESTClient.object`
  (`packages/arborsync-client/src/index.ts:131-137`).
- Swift `ArborSyncRESTClient.object` (`ArborSyncRESTClient.swift:158-178`)
  and `DaemonObjectStore` (`ArborSyncLoopbackServices.swift:45-73`).
- `tests/integration/server.test.ts:158-272`,
  `LoopbackServicesTests.swift:202-220`.

### Step B.2: the Mac app

- `ArborAppModel.swift:786-848`: platform store per D4, built from
  `placed.objectsPath`; a missing `objectsPath` on a placed tree is an error
  surfaced to the user, not a silent Canopy-only open.
- `:925-942`: re-pack adopted requests from that store; a `missing` declines
  adoption instead of failing the open (the daemon resubmits its own request
  anyway).
- `:950-1000`: visits use `CanopyObjectStore` directly.

### Step B.3: docs made true by Phase B

- `docs/arborsync-api.md`: delete §3a; drop the route from the surface list
  at `:22`; §3b says objects are read from `objectsPath`.
- `docs/local-system.md:88-113, 143`: "the Mac reads the daemon's object
  directory"; the visit sentence loses `?origin=`.
- `docs/reference-implementation.md:79`; `docs/client.md` wherever it names
  the route; `spec/01-tree-operations.md:736-738` ("lazily read from the local
  object directory"); `status.md:11, 22`.
- `plans/native/022-*.md:31` and `plans/native/023-*.md:22, 26, 35`:
  `DaemonObjectStore` becomes `DirectoryObjectStore`/`ChainedObjectStore`;
  023's asset-URL note becomes a note that the web editor's own backend
  serves assets.
- `plans/README.md:91, 106`: the two reachability items no longer reference
  the daemon's object route.
- `plans/open-questions.md` item 9: answered by this plan.

### Phase B verification

- `bun run typecheck && bun run test && bun run test:protocol`.
- `swift test --package-path native/Packages/{ArborSyncClient,ArborObjectStore,ArborWorkingTree}`.
- `grep -rn "/v1/objects\|DaemonObjectStore\|object(tree:" packages native docs spec plans`
  returns only `plans/_done` history.
- Manual: open a placed tree and a visit by locator in the Mac app; edit a
  binary in place with `sed -i` and confirm the app still opens it (Canopy
  fallback) and `arbor objects verify` reports the relink after the next walk.

## Done criteria

- [ ] `@arbor/object-store` exists with the two entry points and the boundary
      test; `ObjectIndex` no longer lives in `@arbor/stores`.
- [ ] Every placed tree, pathless replica, and account checkout has
      `objects/<TreeID>/` kept equal to its folder by one walker and one watcher.
- [ ] Invariants I1 through I8 pass; the warm walk does not regress.
- [ ] `GET /v1/objects` is gone from code, clients, tests, docs, and spec.
- [ ] The Mac app reads objects from `objectsPath` with Canopy behind it;
      visits read Canopy directly.
- [ ] `arbor objects verify` reports zero corrupt members on the developer
      Mac's real placements.
- [ ] Open question 9 is closed.

## STOP conditions

Stop and report if:

- the warm walk regresses (rule 1's post-link re-stat is broken);
- `@arbor/fs` would need to import `@arbor/object-store`;
- the maintainer needs anything from `@arbor/arborsync` beyond the injected
  callbacks in `ObjectDirectoryOptions`;
- a route consumer exists that Phase A did not migrate (the Phase B grep);
- the Mac needs a Canopy fetch for an object the folder still holds (retention
  or rule 1 is wrong; fix in Phase A, do not paper over in the app);
- Arbor Sync 001's soak has not been recorded.

## Maintenance notes

- The object directory is bytes by hash. Kind lives on directory entries. Never
  add a manifest or sidecar that makes the directory less than what `ls` shows.
- Verify-on-read is not optional in any reader, because in-place writers can
  change a linked inode between the walk and the read.
- Retention roots are the current folder root, the accepted root, pending
  candidates, and conflict roots. If a new kind of root appears (Reliability
  007's merge states, for example), add it to `retainedRoots()` before it is
  stored.
- If the directory ever needs to be shared by an HTTP surface again, serve it
  as static files with immutable cache headers; do not rebuild a lookup route.
