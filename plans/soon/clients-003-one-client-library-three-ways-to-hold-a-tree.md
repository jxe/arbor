# Clients 003: One client library, three ways to hold a tree

**Why:** Joe wants it to be easy to build an app like Story on any platform (Android,
Windows, anything) and wants three ways for an app to hold a tree to share as much code as
possible: alongside Story Sync, as a replica checkout like the iPhone's, and page by page
straight from overstoryd as someone browses. The choice should depend on the machine (disk
space, whether Story Sync runs there), not on which app was written. He does not want one
shared native engine: he wants client-library ports in each language that are alike in
structure, each supporting all three ways (Joe, 2026-11-06). On the Mac, Story opens placed
trees alongside Story Sync, reading pages only from the folder, and opens visits page by
page (Joe, 2026-11-07). Investigation and Joe's replies: thread "Unify client modes for any
platform", 2026-11-05 to 2026-11-07.

> **Executor instructions**: Work in the order of the steps; each ends with the apps working
> as before, so each can land on main by itself. Swift steps need Joe's Mac to build and
> hand-check (iPhone for step 4), so do them on a branch until they build there. Routes that
> change on overstoryd (step 5) redeploy the host when pushed: ask Joe before pushing them.
> Remove code in the same commit that makes it unused; the last section lists what goes.

## Status

- **Effort**: XL, in seven steps
- **Risk**: MEDIUM. It changes how every app opens a tree. Edits, the change log and the
  update machine don't change, so the risk is to reading and launch speed, not to data.
- **Comes after**: nothing. [Sharing 002](../../status.md#invite-from-the-command-line-and-hosts-older-than-story--2026-11-07)
  (`story invite` as a client of `@ovst/client`, built 2026-11-07) points the same way. [Native 006](../when-needed/performance-006-sparse-ios-placement.md) (sparse
  iPhone placement) becomes a prefetch setting once step 4 is done.

## What exists

Read on arbor main 2026-11-05 to 2026-11-07; nothing was run.

Every way Story opens a tree builds the same `WorkingTree` and `UpdateCoordinator`. They
differ in where accepted objects come from, how much of the tree is held, and whether it is
kept on disk, and each way is written out separately in `swift/StoryApp/StoryAppModel.swift`:

| Where | Function | How the tree is held | Objects from | On disk |
|---|---|---|---|---|
| Mac, placed tree | `openPlacedTree` | every directory and page, rebuilt every launch | Story Sync `/v1/bootstrap` and `/v1/objects` (`DaemonObjectStore`) | change log only |
| Mac, launch preview | `restoreLocalWorkspaceIfAvailable` | scanned from the folder (`LocalFolderPreview`) | folder | no |
| iPhone, placed tree | `place` | whole snapshot (`WorkingTreePlacementService`) | host | full replica |
| Mac, writable remote tree | `openWritableRemoteTree` | whole snapshot | host | full replica |
| Mac, read-only visit | visit path, `StoryVisitSnapshot`, `StoryVisitFollower` | whole snapshot | host | no |
| Story Sync (TypeScript) | `TreeManager` | whole tree | host | the folder |

- **No way opens one page cheaply.** Every way holds at least every directory and Markdown
  page; a visit downloads the whole snapshot.
- **The two libraries cover different ways.** TypeScript has only the folder (Story Sync);
  Swift has only the replica and visit ways. TypeScript has no node index at all.
- **Story Sync speaks a private shape for reads.** `/v1/bootstrap` (a sparse spine as CBOR)
  and `/v1/objects/{hash}` exist only on Story Sync, so code written for overstoryd can't
  read through Story Sync.
- **Swift's engine depends on an app package.** `OverstoryWorkingTree` imports `StoryKit`.
- **The seams already exist in TypeScript.** `@ovst/working-tree`'s coordinator takes an
  `AcceptedSource` (where objects come from) and an `AcceptedTree` (the folder, or an index).
- **The host already serves everything a page-by-page reader needs**, one object per
  request: descriptor, object route by hash, watch (spec 01 §1.1–1.2).

## Design

### One engine, three settings

Every port has one engine. It differs in three settings that don't interact:

| Setting | Values |
|---|---|
| Prefetch | opened pages only · every directory and page · everything |
| Object sources | a chain tried in order: memory, disk cache, placed folder, Story Sync, host. Every object is checked against its hash, so the order is only about speed |
| Durability | node index and change log in memory or on disk (the change log is always on disk when the tree can be edited) |

A **folder** is an optional fourth part that only a daemon (Story Sync) uses: an
`AcceptedTree` that writes accepted files to disk.

The node index always loads directories lazily, so the prefetch setting is a background
policy over the same index, not a different tree. Every way computes its own roots: editing
a page needs only the directories from the root down to it, which any way holds once the
page is open. Edits, chaining and offline work are therefore the same everywhere. The host
derives roots only for collection rows, as now.

The three ways are named combinations:

| Way | Prefetch | Sources | Durability | Used for |
|---|---|---|---|---|
| **Browse** | opened pages | memory, host | memory | visits; trees too big for the device |
| **Replica** | everything | disk, host | disk | iPhone trees; Mac writable remote trees |
| **Alongside Story Sync** | opened pages | memory, folder | memory | Mac placed trees |
| *(Story Sync itself)* | everything | disk, host | disk, plus the folder | the daemon |

In **Alongside Story Sync** the folder is the only page source (Joe, 2026-11-07): the app
reads a file only when its bytes hash to the accepted object, and otherwise waits for Story
Sync to write it. Directory objects come from Story Sync's loopback read routes (step 2).
Writes and watching still go straight to the host. The launch preview stops being its own
path: it is this same session, read-only until the coordinator confirms a basis.

A small policy chooses the way from facts, not from `#if os`: whether the tree is placed in
a folder on this machine with Story Sync running, free disk, tree size, and whether the
caller can write (a visitor session or read-only placement gets Browse). The person can
override it per tree.

The one real edge case is **search and backlinks**, which need every page. On a tree that
isn't fully prefetched they are hidden for now; `WorkspaceProviderCapabilities` already has
flags for both.

### Seven modules, alike in every language

Each port has the same seven modules with the same interfaces and the same conformance files.
Names follow each language's habits (Joe: exact names don't matter). A module depends only
on modules above it. Platform things (storage, keychains, sockets) come in through small
interfaces.

| # | Module | Holds | TypeScript now | Swift now |
|---|---|---|---|---|
| 1 | protocol | canonical CBOR, objects, pages, directories, deltas, source traces, locators, HTTP client, SSE | `@ovst/protocol` | `Overstory` |
| 2 | objects | `ObjectSource` and its chain; memory, disk and host sources | `@ovst/object-store`, `AcceptedSource` | `OverstoryObjectStore` |
| 3 | tree | `AcceptedTree`; the lazy node index | missing | `WorkingTree` (not lazy) |
| 3b | folder (daemons only) | the folder `AcceptedTree` | `@ovst/fs` | not needed |
| 4 | sync | local changes, change log, update machine, coordinator, review | `@ovst/working-tree` | `OverstoryWorkingTree` |
| 5 | session | `TreeSession`: open a tree with settings, the three ways, prefetch, watch, presence | missing (`TreeManager` does part) | missing (`StoryAppModel` does it inline) |
| 6 | accounts | device keys, sessions, visitor sessions, pairing, placements, consent | `@ovst/client` | `OverstoryClient` |
| 7 | workspace | what an editor or UI uses: resolve, children, open document, admit edits, search | story-sync's `Workspace` | `WorkspaceProvider` in `StoryKit` |

Outside the library, in each language: editors, app UI, and the daemon process (Story Sync
is module 5 with a folder, plus a loopback server).

## Protocol additions

Spec first, with conformance vectors, then overstoryd and both clients.

1. **Path read.** `GET /.overstory/trees/{id}/snapshots/{root}/path/{logical path}` returns
   the directory objects from the root to an entry and the entry's own object, in one
   bundle. Browse opens a page in one round trip. Immutable, cached like a snapshot.
2. **Watch without payloads.** `watch?after=…&objects=none` sends each accepted update
   without its objects; a client refetches only what it holds.
3. **Story Sync serves the standard read routes on loopback** (descriptor, snapshots, path
   read, objects, entry metadata, watch) from its cache, falling through to the host. Not a
   spec change; `docs/implementing-sync-services/story-sync-api.md` changes.

## Steps

1. **Swift engine off `StoryKit`.** Move the workspace interface (`WorkspaceProvider` and
   its models) and whatever else `OverstoryWorkingTree` takes from `StoryKit` into the
   library side, so the engine imports no app package. No behaviour change.
2. **Story Sync serves standard reads; the Mac uses them.** Add the read routes to Story
   Sync. `openPlacedTree` reads its spine through them with the ordinary `ProtocolClient`
   and an `ObjectSource` chain. `/v1/bootstrap` and `/v1/objects` go. No visible change;
   compare launch timings (`tree-open`, `launch-preview`) before and after.
3. **Swift `TreeSession` and object-source chain.** One `open(tree, settings)` in
   `OverstoryClient` returns the workspace, coordinator and watch. `StoryAppModel` keeps
   only which tree and which way. Move visits first, then iPhone placements and Mac
   writable remote trees, then Mac placed trees.
4. **Lazy node index.** Split `WorkingTree` into the index (module 3) and the sync half
   (module 4) and make directories load on first use; the prefetch policies run on top.
   Visits become Browse. Mac placed trees become Alongside Story Sync, with the folder as
   the only page source and no whole tree in memory. The launch preview becomes the same
   session.
5. **Path read and payload-free watch** in the spec, overstoryd, Story Sync's loopback
   reads, and the Swift session. Ask Joe before pushing the overstoryd change.
6. **TypeScript node index and `TreeSession`**, shaped like Swift's. Story Sync's
   `TreeManager` uses it. The Web 025 plan's `WebHost` becomes this session.
7. **Parity and the porting guide.** A script lists each module's public types in both
   languages and flags ones only one side has. A porting guide in
   `docs/implementing-sync-services/` gives the module order for a new language and the
   conformance files per module.

## What goes away

Remove each in the commit that makes it unused.

### Story Sync endpoints

| Endpoint | Used by now | Gone in | Replaced by |
|---|---|---|---|
| `GET /v1/bootstrap` | Mac `openPlacedTree`, launch's early bootstrap | step 2 | standard descriptor and snapshot reads on loopback |
| `GET /v1/objects/{hash}` | Mac `DaemonObjectStore`, CLI `daemon-client.ts` | step 2 | standard object route on loopback |
| `GET /v1/credential` | Mac `StorySyncCredentialProvider`, CLI | step 3 | the app opens its own session from the device key through the accounts module, as the CLI's `HostAccountStore` already does |

What stays on `/v1` is daemon control: status, trees, events, sync, pending, held and
declined changes, placement move/pause/resume, resolve, agents, and account setup.

Account setup (`/v1/me`, `/v1/me/backup`, `/v1/me/restore`, `/v1/bootstrap/accounts` and
`/cancel`, `/v1/bootstrap/pairings/claim`, `/v1/bootstrap/placements`, `/v1/accounts`) is
the accounts module's job and could leave Story Sync the same way, but that is
[Sharing 002](../../status.md#invite-from-the-command-line-and-hosts-older-than-story--2026-11-07)'s direction and not part of
this plan.

### Swift app and client code

- `DaemonObjectStore` (`StoryApp/StorySync/StorySyncLoopbackServices.swift`), and the
  bootstrap and object calls in `StorySyncRESTClient.swift` (step 2).
- `StorySyncCredentialProvider` and the credential call (step 3).
- `place`, `openPlacedTree`, `openWritableRemoteTree`, `openOrPlaceWorkingTree`,
  `synchronizedProvider` and the visit path in `StoryAppModel.swift`, folded into
  `TreeSession` (step 3); the early-bootstrap task in `restoreLocalWorkspaceIfAvailable`.
- `StoryVisitSnapshot` and `StoryVisitFollower` (`StoryApp/StoryVisits.swift`): the session
  watches (step 3).
- `WorkingTreePlacementService` (`OverstoryClient`): placement is the Replica prefetch
  (step 4).
- `LocalFolderPreview` (`OverstoryWorkingTree`) and the separate preview path at launch
  (step 4).
- `UpdateCoordinator.sparseDirectoryGraph`, the catch-up spine walk: the lazy index fetches
  what it needs (step 4).
- `SnapshotBridge`'s sparse-spine install for placed trees (step 4); keep only what Replica
  needs.

### TypeScript code

- `bootstrapTree` in `packages/story-sync/src/service.ts`, the `/v1/bootstrap` and
  `/v1/objects` handlers in `sync-http.ts`, and the bootstrap, object and credential calls
  in `packages/cli/src/daemon-client.ts` (steps 2 and 3).
- `AcceptedSource` merges into the `ObjectSource` chain (step 6).

### Docs

- `docs/implementing-sync-services/story-sync-api.md` §3a (objects) and §3b (bootstrap and
  credential), rewritten as "Story Sync serves the standard reads".
- The Mac half of step 0 in spec 01 §3.1 ("installs a sparse spine … from the loopback
  object route").

## Verification

- Conformance vectors for the path read and payload-free watch, run by both clients and
  overstoryd (`bun run test:protocol`).
- Session vectors (open, prefetch, switch source, offline edit then reconnect) run in both
  languages.
- `swift test` for each Swift package, `swift/scripts/test-story-editor-local.sh`, and the
  full TypeScript suite.
- Launch timings on Joe's Mac before and after steps 2 and 4 (`tree-open`,
  `launch-preview`, `editor-drawn` notes in the network log); the Mac placed tree must
  not get slower.
- Visiting a large tree on the Mac opens its first page without downloading the snapshot
  (network log shows a path read, not a snapshot).

## STOP conditions

- The lazy index would let an edit be published against directories the client hasn't
  checked against the accepted root.
- Mac launch to first drawn page gets slower than before step 2 and the cause isn't clear.
- The folder-only page source can show a page that doesn't match the accepted state.
