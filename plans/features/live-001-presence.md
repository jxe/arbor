# Live 001: see who else is here

**Timing:** Soon.

**Why and when:** Joe asked on 2026-10-13 for presence in Overstory and Story: who is looking at a tree, which page each person is on, and where their cursor is when two people share a page. It must be light. Nothing is sent about cursors unless someone else is on the same page, and an idle reader costs a keepalive. No timing yet. The plan starts with the spec, because presence is the first live data a host relays that is not part of a tree.

> **Executor instructions**: Do the phases in order and stop after each for Joe's hands-on check. Each phase lists the spec and doc text that becomes true with it; change that text in the same phase. Phase 2 changes a host route, so it also runs `bun run test:protocol`. Pushing `main` deploys overstoryd. Never test against `arb.nxhx.org`.
>
> **Drift check**: `git diff --stat 1cfac9e..HEAD -- docs/overstory-spec/01-tree-operations.md docs/overstory-spec/05-access-control.md docs/overstory-spec/README.md packages/overstoryd/src/host.ts packages/overstoryd/src/overstoryd.ts swift/Packages/Overstory/Sources/Overstory/ProtocolClient.swift swift/Packages/OverstoryClient/Sources/OverstoryClient/HostWatchRunner.swift swift/StoryApp/StoryAppModel.swift swift/StoryApp/StoryRootView.swift`. Stop if a `presence` route or event already exists.

## Status

- **Effort**: M for phases 1 to 4; the exact caret (phase 6) adds a Quagmire release.
- **Risk**: LOW for phases 1 and 2: a new route, in memory, with nothing persisted. MEDIUM for phase 4, which is the first time Story shows another person inside the editor.
- **Progress**: TODO
- **Written against**: `1cfac9e`

## What happens today

Nothing in the spec, host or apps describes presence. The only related text is `docs/getting-started/intro.md` ("Multiplayer state comes from the tree"), which presence qualifies: it is the one deliberately ephemeral exception, not a second data plane for content.

What presence can reuse:

- **One host process.** overstoryd runs as a single instance: the deploy README forbids replicas against one SQLite volume. In-process memory can hold every live presence entry, and a restart or deploy just empties it.
- **Per-tree fan-out.** `subscribeObservations` (`packages/overstoryd/src/overstoryd.ts`) keeps a `Map<tree, Set<listener>>`. A presence hub has the same shape, except that it pushes small payloads directly and does not wake a reader of the durable log.
- **Stream authorization.** The watch route (`packages/overstoryd/src/host.ts`) uses `readableTree` at admission, `cachedAuthorization` while open, and the shared 250 ms `onAuthorizationTick`, which silently ends a revoked stream. It sends a keepalive every 20 s and lifts Bun's idle timeout with `server.timeout(request, 0)`. A presence stream needs all of this unchanged.
- **Caller identity.** A route has `HostAccount.id`, the profile TreeID, and `HostAuthentication.device`. `profile_facts` holds a profile's `displayName` and avatar hash for profiles homed here. For a placement account, whose profile is homed elsewhere, the host may have no name.
- **The app's live connections.** The Swift app holds one watch for the open tree (`serverWatchRunner` in `StoryAppModel.swift`), plus one for a visited tree (`StoryVisitFollower`). On iOS, `suspendLiveSync()` drops the watch in the background and `resumeLiveSync()` reopens it. `HostWatchRunner` is the reconnecting loop to copy.
- **The open page and the caret.** `WorkspaceReference { tree, path, stableKey }` names the open page. The caret is `binding.editorState.cursor`, a `BlockID`. `StoryRootView` already observes its changes (`draftCaretMoved`). `StoryDocumentBinding.blocks(overlapping:inSource:)` maps a UTF-8 byte range of a source object to blocks.
- **What does not carry over.** Block IDs are not shared between clients: they are derived per open (`digestID(seed:ordinal)`), and split blocks get a fresh UUID. A cursor on the wire must be a byte range in a named source, not a `BlockID`. Story code has no offset within a block; that is inside Quagmire's `EditorState`.

The watch stream cannot carry presence. Its `after` cursor is the only resume point, every frame is a durable observation, and the Swift client rejects unknown events (`ProtocolClient.swift`, "Unsupported tree watch event"). Presence gets its own route.

## Decisions

1. **One presence stream per open tree, with a roster of the whole tree and cursors for one page.** Each subscriber sees everyone else in the tree and the page they are on. A cursor event goes only to subscribers on the sender's page. Changing page is a small POST, not a reconnect. (Joe chose this over "same document only".)
2. **Being subscribed is being present.** Opening the stream joins the roster and closing it leaves. Presence has no heartbeat POST, no TTL and no resume cursor. A reconnect starts over with a fresh roster snapshot, the way a query stream starts over with `ready`.
3. **Visible by default, with a per-device opt-out.** A signed-in reader of the tree is shown to the tree's other readers. A device can turn this off ("Show me to others"). It then subscribes with `visible=false` and sees the roster but is not in it. A caller authenticated only by an access link, or not at all, may subscribe but is never listed. (Joe's choice.)
4. **Cursors are reciprocal.** Only visible subscribers receive cursor events. A hidden viewer sees who is where, but not their carets. This keeps the sending rule simple: a client sends cursor updates only while the roster shows another person on its page. No signal can reveal that a hidden viewer is present.
5. **A cursor is a byte range in a named source.** `{ source: Hash, anchor, head }` holds UTF-8 byte offsets into the file object whose hash is `source`. That is the bytes the sender is showing, which may be a local edit not yet accepted. A receiver showing the same object places the cursor exactly. Otherwise it may approximate it within its own version, but must not present it as exact. This survives any client's block model, and later carries an exact caret and selection with no wire change.
6. **Block-level first.** Story v1 sends the byte range of the block holding its caret and shows each peer's block. A new range is sent only when the caret moves to another block, so typing within a block sends nothing. The exact caret waits for Quagmire to report an offset and draw remote carets (phase 6). (Joe's choice.)
7. **The host names people, clients colour them.** A roster entry carries the profile TreeID and the host's display name for it, or `null`. A client derives a stable colour from the profile TreeID. One person on two devices appears once per device. The entry's presence ID is opaque and per stream, so a peer never learns another person's device ID.
8. **Bounded by construction.** The client sends at most 4 cursor updates a second, coalescing to the latest. The host keeps only the latest cursor per peer, drops superseded cursor frames to a slow consumer, caps a POST body at 1 KiB, and may answer `429`. A presence entry never touches SQLite.
9. **Scoped readers see only what they may read.** A peer on a page outside the subscriber's readable projection appears in the roster with `page: null`. Cursors are only ever sent between subscribers on the same page, and both of them can read it.

## The contract (what phase 1 writes)

```text
GET  /.overstory/trees/{TreeID}/presence[?visible=false]
POST /.overstory/trees/{TreeID}/presence/{PresenceID}
```

The GET is SSE with the shared framing (§4.2), with no `id` and no `after`. Events:

```ts
// event: presence.ready  (first event, once)
type PresenceReady = { self: PresenceID | null; peers: PresencePeer[] };   // self null when not visible

// event: presence.peer   (a peer joined or changed page)
type PresencePeer = {
  id: PresenceID;
  profile: TreeID;
  name: string | null;
  page: { path: LogicalPath; stableKey: string | null } | null;
};

// event: presence.cursor (only between visible subscribers on the same page)
type PresenceCursor = { id: PresenceID; selection: PresenceSelection | null };
type PresenceSelection = { source: Hash; anchor: number; head: number };

// event: presence.leave
type PresenceLeave = { id: PresenceID };

type PresenceID = string;   // opaque, unguessable, valid only for its stream
```

The POST body is `{ page?: { path, stableKey } | null, selection?: PresenceSelection | null }`. An omitted member leaves the value unchanged. Changing page clears the selection. The POST is accepted only from the caller that opened the stream, while it is open. Otherwise it is `404`, so a presence ID is not a credential. A POST naming a page the caller cannot read is `404`, with the same answer as a missing page.

## Phase 1: the spec, models and vectors

**Spec and docs, changed in this phase:**

- New `docs/overstory-spec/11-presence.md`: the contract above, decisions 2 to 5 and 7 to 9 as normative rules, and a sentence saying presence is never part of a tree, its history or a watch, and a host keeps none of it across restarts. Rates are SHOULDs for clients and MAYs for hosts.
- `docs/overstory-spec/README.md`: a row in the specification map, and the two routes in the route index.
- `05-access-control.md` §3.2: presence streams are admitted and kept like watches. Whole-tree or scoped read is required, the stream ends on revocation, and a presence entry is never disclosed outside the readable projection.
- `01-tree-operations.md` §4.2: presence streams use the shared framing and, like query streams, start over on reconnect.
- `docs/getting-started/intro.md`: qualify "Multiplayer state comes from the tree" with presence as the ephemeral exception.

**Code:** `PresenceReady`, `PresencePeer`, `PresenceCursor`, `PresenceLeave` and `PresenceSelection` in `packages/protocol/src/model/protocol.ts` and `swift/Packages/Overstory/Sources/Overstory/ProtocolModels.swift`.

**Vectors:** `conformance/presence-events.sse` (a ready, join, page change, cursor and leave sequence) and `conformance/presence-events-invalid.json` (an unknown event, a negative offset, `anchor` past a plausible bound, a missing `source`). Decode them in `tests/unit/protocol.test.ts` and `OverstoryTests.swift`.

**Verification:** `bun run test:affected`, `bun run check:links`, and the Swift `Overstory` package tests.

## Phase 2: overstoryd

- A `PresenceHub` in its own module: `Map<TreeID, Map<PresenceID, Entry>>`, where an entry is the account, visibility, page, latest selection and an outbound queue. Join, page change and leave fan out to every subscriber of the tree, filtered per subscriber by its readable projection. A cursor fans out only to visible subscribers on the same page. Each subscriber's queue holds at most one pending cursor per peer.
- The two routes in `host.ts`, beside the watch: `readableTree` at admission, `cachedAuthorization` and `onAuthorizationTick` while open, `server.timeout(request, 0)`, a keepalive comment every 20 s, and removal from the hub on any close.
- The display name comes from `readStoredProfile(db, account.id)` when the profile is homed here, otherwise `null`. Read it once at join.
- `docs/architecture/overstoryd/presence.md`: memory only, lost on restart, single process, the queue bounds. Link it from `docs/architecture/README.md`.

**Verification:** integration tests with two accounts and a third device of one of them:

- the roster on join, page change and leave;
- a cursor reaches a peer on the same page and not one on another page;
- a hidden subscriber receives the roster but no cursors, and never appears;
- an access-link reader is never listed;
- a scoped reader sees `page: null` for an unreadable page;
- revocation ends the stream and removes the entry;
- a POST from another caller, or after close, is `404`;
- a slow consumer gets only the latest cursor.

Then `bun run test:affected` and `bun run test:protocol`.

## Phase 3: the Swift client and the Mac app's plumbing

- `ProtocolClient.presence(tree:visible:)` and `ProtocolClient.updatePresence(tree:id:page:selection:)`.
- A `HostPresenceRunner` in `OverstoryClient`, modelled on `HostWatchRunner`: it reconnects with backoff, holds the roster, and exposes it as an observable value. It POSTs the page on every (re)connect.
- `StoryAppModel` starts one runner beside each host watch (the open tree, and a visited tree), with the same credential. It stops it with them, so iOS's `suspendLiveSync()` also leaves the roster.
- The page is the current `WorkspaceReference`. The selection is the byte range of the caret's block in the document's current source object. It is sent from `draftCaretMoved`, only while the roster shows another person on this page, and throttled per decision 8.
- The "Show me to others" setting is per device and defaults to on.

**Verification:** `HostPresenceRunner` tests against a stub host: reconnect resends the page, nothing is sent while alone on a page, throttling coalesces. The live scenario in `test:protocol` puts two Swift clients on one page and checks that each sees the other's block.

## Phase 4: showing it in Story (Mac)

- **Check first:** whether Quagmire 0.10 can decorate a block (a gutter mark or tint) without a release. If it cannot, v1 shows "Ana · Implementation" (the peer's block heading or first words) in the document header, and the in-text mark moves to phase 6.
- Small initials in the peer's colour in the document header for everyone on this page, and a dot beside each page in the sidebar where someone is. Hovering shows names.
- Each peer's block is marked in their colour when the block can be found. A cursor whose `source` differs from the shown source is mapped through the receiver's own version and drawn fainter. If it cannot be mapped, it is not drawn.
- `docs/implementing-editors/design.md` describes what Story shows and the opt-out. `status.md` records phases 1 to 4.

**Verification:** an app-hosted test that a roster update renders the header and sidebar markers. By hand with Joe: two Macs (or a Mac and a second account), the same tree, page changes, block moves, the opt-out, and quitting one side.

## Phase 5: iPhone

The runner already follows `suspendLiveSync`. Add the header initials and the block mark (or header text) to the iPhone editor and the setting to its preferences. By hand: the phone and a Mac on the same page. The phone leaves the roster within a second of being backgrounded and rejoins on return.

## Phase 6: exact caret and selection

This needs a Quagmire release: `EditorState` must report the caret and selection as a source byte range, and the editor must draw remote carets and selections given ranges and colours. Story then sends the exact range instead of the block's range. The wire and the host do not change. This follows the usual Quagmire release step in DEVELOPMENT.md.

## Not in this plan

- **Story for the web** joins with [Web 025](../later/story-web-025-story-web.md). The contract is plain SSE and POST, so a browser needs nothing new.
- **Agents and the `story` command appearing as present.** The route allows it, and an agent editing a page would be a good thing to see. Decide after phase 4.
- **Typing indicators, follow mode and avatars from the profile's image.** The roster carries the profile TreeID, so an avatar can be added later without a contract change.

## Open questions

1. **Re-anchoring across versions.** Byte offsets into another version are approximate. If that proves too rough in phase 4, a selection could carry a short quote of the text around `head` (as in W3C Web Annotation's `TextQuoteSelector`) at about 60 bytes more per update. Decide from phase 4's hands-on use, not up front.
2. **POST overhead.** Each cursor update is a request carrying the bearer token. HTTP/2 header compression makes that small, but check what Railway and Caddy actually negotiate with `URLSession`. At block level, updates are rare enough that it does not matter. It matters for phase 6, where a WebSocket might be worth its cost.
