# Agents 001: see who's here, and run a first agent task on the Mac

**Timing:** Soon.

**Why and when:** Joe asked on 2026-10-30 for the smoothest way to bring AI into Story
(thread "Bring AI into Story smoothly"). He chose an agent that is a collaborator, not a
feature: it edits the tree through the same sync path a person uses, and Story shows it the way
it shows a person, through presence. It runs Claude Code on Joe's own Mac, so there is no API
token and no credits. A task is a block on a page, added or dictated anywhere and run later
with a Run button.

This is the first of three plans. It holds presence (formerly **Live 001**, which Joe asked for
on 2026-10-13) and an easy first cut of agents: task blocks, Run on the Mac with Claude Code,
and the agent shown as a presence peer with a status line. The harder parts, such as
questions and answers, Run from the iPhone and Codex, are
[Agents 002](agents-002-talk-to-the-agent-and-run-from-anywhere.md). Exact carets
([Live 002](live-002-exact-carets.md)) and suggestions ([Editor 003](editor-003-suggestions.md)) are their own plans, for people and agents alike. Runs in history,
Undo Run through history and attribution are
[Agents 003](agents-003-agent-runs-in-history.md), after
[overstoryd 007](history-007-document-history-routes-and-restore.md). This plan also absorbs
**CLI 004** (external agents in placed folders), whose readiness check and skill the runner
needs.

> **Executor instructions**: Do the phases in order and stop after each for Joe's hands-on
> check. Each phase lists the spec and doc text that becomes true with it; change that text in
> the same phase. Phase 2 changes a host route, so it also runs `bun run test:protocol`.
> Pushing `main` deploys overstoryd. Never test against `arb.nxhx.org`. Quagmire changes ship
> with an arbor release, never alone. Check every `claude` flag named here against the version
> installed on Joe's Mac before relying on it.
>
> **Drift check**: `git diff --stat 776b64d..HEAD -- docs/overstory-spec/01-tree-operations.md docs/overstory-spec/05-access-control.md docs/overstory-spec/README.md packages/overstoryd/src/host.ts packages/overstoryd/src/overstoryd.ts swift/Packages/Overstory/Sources/Overstory/ProtocolClient.swift swift/Packages/OverstoryClient/Sources/OverstoryClient/HostWatchRunner.swift swift/StoryApp/StoryAppModel.swift swift/StoryApp/StoryRootView.swift`. Stop if a `presence` route or event already exists.

## Status

- **Effort:** M for presence (phases 1 to 5), as Live 001 estimated; S to M for task blocks
  and the runner (6 and 7).
- **Risk:** LOW for phases 1 and 2: a new route, in memory, with nothing persisted. MEDIUM for
  phase 4, the first time Story shows another person inside the editor, and for phase 7, the
  first time Story starts a process that edits Joe's files.
- **Progress:** TODO
- **Written against:** `776b64d`

## The experience at the end of this plan

1. On the iPhone, under "# Groceries", Joe types or dictates a task: "merge the duplicates
   and sort by aisle". It becomes a task block and waits.
2. On the Mac he presses **Run** on it.
3. A new presence peer appears, "Claude (Joe's Mac)", on that page. As it reads and edits,
   its mark moves to the block it's on, and a bubble says what it is doing ("reading
   Groceries", "merging duplicates"). Joe sees the same from the iPhone.
4. When it is done, the task block is gone, the bubble shows a one-line result for a few
   seconds, and the peer leaves. **Undo Run** on the Mac takes back what it changed.

The agent does not ask questions yet; it does the task as best it can. Status and result
vanish with the presence entry.

## What happens today

Nothing in the spec, host or apps describes presence, agents running from Story, or task
blocks. What this plan can reuse:

- **One host process.** overstoryd runs as a single instance (the deploy README forbids
  replicas against one SQLite volume), so in-process memory can hold every presence entry,
  and a restart or deploy just empties it.
- **Per-tree fan-out.** `subscribeObservations` (`packages/overstoryd/src/overstoryd.ts`)
  keeps a `Map<tree, Set<listener>>`. A presence hub has the same shape, except that it pushes
  small payloads directly and does not wake a reader of the durable log.
- **Stream authorization.** The watch route (`packages/overstoryd/src/host.ts`) uses
  `readableTree` at admission, `cachedAuthorization` while open, and the shared 250 ms
  `onAuthorizationTick`, which silently ends a revoked stream. It sends a keepalive every 20 s
  and lifts Bun's idle timeout with `server.timeout(request, 0)`. A presence stream needs all
  of this unchanged.
- **Caller identity.** A route has `HostAccount.id`, the profile TreeID, and
  `HostAuthentication.device`. `profile_facts` holds a profile's `displayName` and avatar hash
  for profiles homed here; for a placement account the host may have no name.
- **The app's live connections.** The Swift app holds one watch for the open tree
  (`serverWatchRunner` in `StoryAppModel.swift`), plus one for a visited tree
  (`StoryVisitFollower`). On iOS, `suspendLiveSync()` drops the watch in the background and
  `resumeLiveSync()` reopens it. `HostWatchRunner` is the reconnecting loop to copy.
- **The open page and the caret.** `WorkspaceReference { tree, path, stableKey }` names the
  open page. The caret is `binding.editorState.cursor`, a `BlockID`, observed in
  `StoryRootView` (`draftCaretMoved`). `StoryDocumentBinding.blocks(overlapping:inSource:)`
  maps a UTF-8 byte range of a source object to blocks.
- **What does not carry over.** Block IDs are not shared between clients: they are derived per
  open (`digestID(seed:ordinal)`), and split blocks get a fresh UUID. A cursor on the wire must
  be a byte range in a named source. Story has no offset within a block; that is inside
  Quagmire's `EditorState`.
- **The watch stream cannot carry presence.** Its `after` cursor is the only resume point,
  every frame is a durable observation, and the Swift client rejects unknown events
  (`ProtocolClient.swift`, "Unsupported tree watch event"). Presence gets its own route.
- **A file's object hash is `sha256(fileBytes)`** (spec 01), so an agent editing a file on
  disk can name the exact source its cursor refers to by hashing the bytes just written.
- **Placed folders.** Story Sync writes each placed tree as plain files under the folder
  recorded in `${STORY_HOME:-~/.story}/placements.yaml` and publishes edits made there.
  `story sync status --json` reports readiness and resolves locators. Whether it also shows
  that a local edit has reached the host is unchecked (CLI 004 step 1).
- **The editor.** Quagmire's `BlockKind` has `quote` but no callout and no block that runs
  something; `.templateButton` is the closest precedent for a block with a button, and nobody
  uses it. Story's `MarkdownCodec` reads `> ` as a quote.
- **On-device AI already exists**: `TranscriptPolisher` (QuagmireExtras, FoundationModels)
  tidies pinch dictation. This plan does not touch it.

## Decisions

Presence (Live 001; Joe's choices there stand):

1. **One presence stream per open tree, with a roster of the whole tree and cursors for one
   page.** Each subscriber sees everyone else in the tree and the page they are on. A cursor
   event goes only to subscribers on the sender's page. Changing page is a small POST, not a
   reconnect. (Joe chose this over "same document only".)
2. **Being subscribed is being present.** Opening the stream joins the roster and closing it
   leaves. No heartbeat POST, no TTL and no resume cursor. A reconnect starts over with a
   fresh roster snapshot.
3. **Visible by default, with a per-device opt-out** ("Show me to others"). A hidden device
   sees the roster but is not in it. A caller authenticated only by an access link, or not at
   all, may subscribe but is never listed. (Joe's choice.)
4. **Cursors are reciprocal.** Only visible subscribers receive cursor events. A client sends
   cursor updates only while the roster shows another person on its page.
5. **A cursor is a byte range in a named source.** `{ source: Hash, anchor, head }` holds
   UTF-8 byte offsets into the file object whose hash is `source`. A receiver showing another
   version may approximate it, but must not present it as exact.
6. **Send exact, show by block.** Story sends its exact caret or selection within the block it
   is editing (Quagmire already reports it), but shows each peer at block level: a marker and
   a tinted row. Drawing others' carets inside text is [Live 002](live-002-exact-carets.md),
   which then needs no wire or sending change. (Joe, 2026-10-31.)
7. **The host names people, clients colour them.** An entry carries the profile TreeID and the
   host's display name for it, or `null`. A client derives a stable colour from the profile
   TreeID. One person on two devices appears once per device. A presence ID is opaque and per
   stream.
8. **Bounded by construction.** At most 4 cursor updates a second, coalescing to the latest.
   The host keeps only the latest cursor per peer, drops superseded frames to a slow
   consumer, caps a POST body at 1 KiB, and may answer `429`. A presence entry never touches
   SQLite.
9. **Scoped readers see only what they may read.** A peer on a page outside the subscriber's
   readable projection appears with `page: null`.

Agents (Joe, 2026-10-30, except where marked as a recommendation):

10. **An agent is a presence peer of its own, under its person.** The device running it opens a
    second presence stream marked as an agent. The roster shows it as "Claude (Joe's Mac)", in
    a colour derived from the person's, with a mark that says it's an agent.
11. **An agent's presence carries a status line**, one short line that everyone who can see the
    peer sees. Like the rest of presence it is never in the tree and gone when the stream
    closes.
12. **A task is a block.** It can be added or dictated anywhere, including on the iPhone, and
    waits until someone presses Run. Where it sits is its scope: a task under a heading is
    about that section. In the file it is plain Markdown that other tools can read:

    ```markdown
    > [!agent] merge the duplicates and sort by aisle
    ```

    (Recommendation for the syntax: it reads as an ordinary quote anywhere that doesn't know
    it, and Claude Code reading the raw file sees the task in place.)
13. **Tasks run only from a Run button**, never automatically. In this plan, Run is on the Mac.
14. **The runner is Joe's own Claude Code**, started headless by Story on the Mac in the
    tree's placed folder, with his own sign-in. Story never holds a model API key.
15. **When a run finishes, its task block is removed.** History will be the archive
    (Agents 003).
16. **Edits land directly.** Suggestions are [Editor 003](editor-003-suggestions.md).

## The contract (what phase 1 writes)

```text
GET  /.overstory/trees/{TreeID}/presence[?visible=false][&agent=<label>]
POST /.overstory/trees/{TreeID}/presence/{PresenceID}
```

The GET is SSE with the shared framing (§4.2), with no `id` and no `after`. Events:

```ts
// event: presence.ready  (first event, once)
type PresenceReady = { self: PresenceID | null; peers: PresencePeer[] };   // self null when not visible

// event: presence.peer   (a peer joined, changed page, or an agent's status changed)
type PresencePeer = {
  id: PresenceID;
  profile: TreeID;
  name: string | null;
  page: { path: LogicalPath; stableKey: string | null } | null;
  agent: { label: string; status: string | null } | null;   // null for a person; status ≤ 140 characters
};

// event: presence.cursor (only between visible subscribers on the same page)
type PresenceCursor = { id: PresenceID; selection: PresenceSelection | null };
type PresenceSelection = { source: Hash; anchor: number; head: number };

// event: presence.leave
type PresenceLeave = { id: PresenceID };

type PresenceID = string;   // opaque, unguessable, valid only for its stream
```

The POST body is `{ page?, selection?, status? }`. An omitted member leaves the value
unchanged. Changing page clears the selection. `status` is accepted only on an agent stream.
The POST is accepted only from the caller that opened the stream, while it is open; otherwise
`404`, so a presence ID is not a credential. A POST naming a page the caller cannot read is
`404`, the same answer as a missing page. An agent stream (`agent=<label>`) is always visible.

Agents 002 adds a question, a runner flag and messages between one person's streams; the
contract is written so those are additions.

## Phase 1: the spec, models and vectors

**Spec and docs, changed in this phase:**

- New `docs/overstory-spec/11-presence.md` (renumber if 11 is taken): the contract above,
  decisions 2 to 5, 7 to 11 as normative rules, and a sentence saying presence is never part
  of a tree, its history or a watch, and a host keeps none of it across restarts. Rates are
  SHOULDs for clients and MAYs for hosts.
- `docs/overstory-spec/README.md`: a row in the specification map, and the two routes in the
  route index.
- `05-access-control.md` §3.2: presence streams are admitted and kept like watches. Whole-tree
  or scoped read is required, the stream ends on revocation, and a presence entry is never
  disclosed outside the readable projection.
- `01-tree-operations.md` §4.2: presence streams use the shared framing and, like query
  streams, start over on reconnect.
- `07-executable-documents.md` §13: a note that an agent run by a client is not an authored
  agent: it edits as its person, through that person's placement, and has no manifest.
  Authored agents remain [Apps 002](../later/apps-002-overstoryd-hosted-agents.md).
- `docs/getting-started/intro.md`: qualify "Multiplayer state comes from the tree" with
  presence as the ephemeral exception.

**Code:** `PresenceReady`, `PresencePeer`, `PresenceCursor`, `PresenceLeave` and
`PresenceSelection` in `packages/protocol/src/model/protocol.ts` and
`swift/Packages/Overstory/Sources/Overstory/ProtocolModels.swift`. Make
`PresenceSelection` extensible (decoders skip an unknown selection kind), because
[Schema language 007](../soon/schema-language-007-edit-collections-in-story.md#interaction-with-presence-agents-001)
will need a selection in one field of a collection row.

**Vectors:** `conformance/presence-events.sse` (ready, join, page change, cursor, an agent's
status, leave) and `conformance/presence-events-invalid.json` (an unknown event, a negative
offset, `anchor` past a plausible bound, a missing `source`, a status over the bound). Decode
them in `tests/unit/protocol.test.ts` and `OverstoryTests.swift`.

**Verification:** `bun run test:affected`, `bun run check:links`, and the Swift `Overstory`
package tests.

## Phase 2: overstoryd

- A `PresenceHub` in its own module: `Map<TreeID, Map<PresenceID, Entry>>`, where an entry is
  the account, visibility, page, latest selection, agent label and status, and an outbound
  queue. Join, page change, status and leave fan out to every subscriber of the tree, filtered
  per subscriber by its readable projection. A cursor fans out only to visible subscribers on
  the same page. Each subscriber's queue holds at most one pending cursor and one pending
  status per peer.
- The two routes in `host.ts`, beside the watch: `readableTree` at admission,
  `cachedAuthorization` and `onAuthorizationTick` while open, `server.timeout(request, 0)`, a
  keepalive comment every 20 s, and removal from the hub on any close.
- The display name comes from `readStoredProfile(db, account.id)` when the profile is homed
  here, otherwise `null`. Read it once at join.
- `docs/architecture/overstoryd/presence.md`: memory only, lost on restart, single process,
  the queue bounds. Link it from `docs/architecture/README.md`.

**Verification:** integration tests with two accounts and a third device of one of them:

- the roster on join, page change and leave;
- a cursor reaches a peer on the same page and not one on another page;
- a hidden subscriber receives the roster but no cursors, and never appears;
- an access-link reader is never listed;
- a scoped reader sees `page: null` for an unreadable page;
- revocation ends the stream and removes the entry;
- a POST from another caller, or after close, is `404`;
- a slow consumer gets only the latest cursor;
- an agent stream appears with its label, its status reaches every subscriber, and `status`
  on a person's stream is refused.

Then `bun run test:affected` and `bun run test:protocol`.

## Phase 3: the Swift client and the Mac app's plumbing

- `ProtocolClient.presence(tree:visible:agent:)` and
  `ProtocolClient.updatePresence(tree:id:page:selection:status:)`.
- A `HostPresenceRunner` in `OverstoryClient`, modelled on `HostWatchRunner`: it reconnects
  with backoff, holds the roster, and exposes it as an observable value. It POSTs the page on
  every (re)connect.
- `StoryAppModel` starts one runner beside each host watch (the open tree, and a visited
  tree), with the same credential. It stops it with them, so iOS `suspendLiveSync()` also
  leaves the roster.
- The page is the current `WorkspaceReference`. The selection is the exact range: Quagmire's
  `EditorState.textSelection` (UTF-16 offsets within the editing block's text) mapped through
  the codec to UTF-8 bytes of the document's current source object, accounting for inline
  Markdown such as `**` and links. When no block is being edited, it is the selected blocks'
  range. It is sent on caret and selection changes, only while the roster shows another
  person on this page, and throttled per decision 8.
- The "Show me to others" setting is per device and defaults to on.

**Verification:** `HostPresenceRunner` tests against a stub host: reconnect resends the page,
nothing is sent while alone on a page, throttling coalesces. The live scenario in
`test:protocol` puts two Swift clients on one page and checks that each sees the other's
block.

## Phase 4: showing people and agents in Story (Mac)

- **What Quagmire has (checked 2026-10-31, Quagmire `d58ae9d`):** `EditorAccessory` puts a
  host marker in a 32 pt lane beside a block, with a detail view that expands inline under
  it (choice review uses it). There is no row tint and no floating view. Joe wants a floating
  bubble, so this phase includes a Quagmire release (with the next arbor release):
  - **Peer markers:** a host-supplied list of `(BlockID, colour, label)` drawn as small
    initials in the accessory lane, stacked when several peers share a block.
  - **Row tint** (Joe unsure; build it behind a flag and decide by hand): a faint wash of the
    peer's colour behind the row.
  - **A floating bubble:** a host view anchored to a block, drawn over the page beside the
    row (not pushing text down), that follows the block as it moves or scrolls, and stays
    within the visible page.
- Small initials in the peer's colour in the document header for everyone on this page, and a
  dot beside each page in the sidebar where someone is. Hovering shows names.
- Each peer's block is marked in their colour when the block can be found. A cursor whose
  `source` differs from the shown source is mapped through the receiver's own version and
  drawn fainter. If it cannot be mapped, it is not drawn.
- An agent peer has the agent mark, and its status shows in the floating bubble beside its
  block.
- `docs/implementing-editors/design.md` describes what Story shows and the opt-out.

**Verification:** an app-hosted test that a roster update renders the header and sidebar
markers and an agent's bubble. By hand with Joe: two Macs (or a Mac and a second account), the
same tree, page changes, block moves, the opt-out, and quitting one side.

## Phase 5: presence on the iPhone

The runner already follows `suspendLiveSync`. Add the header initials, the block mark (or
header text) and the agent bubble to the iPhone editor, and the setting to its preferences.
By hand: the phone and a Mac on the same page. The phone leaves the roster within a second of
being backgrounded and rejoins on return.

## Phase 6: task blocks

- **Quagmire:** a `.task(text:)` block kind, drawn as a tinted callout with a small agent mark
  and a **Run** button at its end, and in Turn Into as "Agent task". The button calls a new
  `EditorHost.runTask(block:)`; the host decides whether it is shown and what it says ("Run",
  "Running…"). Released with the next arbor release.
- **Story's `MarkdownCodec`:** reads `> [!agent] text` as `.task` and writes it back
  byte-for-byte; a quote without the marker stays a quote. Pasteboard HTML writes it as a
  `<blockquote>`.
- **Adding one:** Turn Into on any block, or typing `[!agent]` at the start of a quote. On the
  iPhone, a pinch recording whose first word is "agent" becomes a task block, through the
  existing transcription path.
- On the iPhone, and on a Mac where the tree isn't placed, Run is hidden in this plan.

**Verification:** codec round-trip tests for task blocks among other blocks, nested under
headings and lists, and next to ordinary quotes. By hand on the iPhone: dictate a task and see
it on the Mac after sync.

## Phase 7: run a task on the Mac

This is CLI 004's work, with Story as the caller.

- **Readiness and publication.** Check whether `story sync status --json` shows that a local
  edit reached the host. If not, add `story sync status --wait [--timeout <s>]` (exit 0 when
  every in-scope tree is up to date, non-zero with the condition if one is held). The runner
  waits for readiness before starting and for publication before finishing.
- **The skill**, written so Codex can use it later (CLI 004 step 2): check `story sync status`
  first; resolve a locator before assuming its tree or writability; edit only the placed
  folder; keep frontmatter `id:` values and links; treat a held tree as a stop; keep to the
  task's section unless the task says otherwise; report what you are doing with the `status`
  tool. It is also installable on its own, so Joe's own Claude Code sessions follow it.
- **Starting a run.** On Run, Story finds the tree's placed folder from `placements.yaml`
  (no placement on this Mac: Run explains that). It snapshots the folder with an APFS clone
  (`cp -c -R`, without `.state`), opens an agent presence stream on the tree, and starts
  `claude -p` in the placed folder with streaming JSON output, edit permission only, no shell
  beyond `story` read commands, the skill as appended system prompt, and a Story MCP server.
  The prompt names the page's path, the section the task sits in, and the task text.
- **The Story MCP server** is a small stdio process the app ships, connected back to the app.
  Its tools: `status(text)` sets the presence status; `done(result)` sets the final line.
- **Following the agent.** Story reads the agent's streamed tool calls. A read of a file in the
  folder moves the agent's page there. An edit moves its cursor to the edited block: Story
  hashes the file's new bytes for `source` and finds the replaced range. Paths map to logical
  paths through the placement. Status falls back to the tool in use ("Reading Groceries")
  when the agent hasn't set one.
- **Finishing.** When the agent exits, Story removes the task block from the page file
  (matching its text in its section; nothing to do if the agent already removed it), waits for
  publication, shows the result for a few seconds, and closes the agent stream. On failure,
  the task block stays and the bubble shows why. A **Stop** button on the Mac ends the run.
- **Undo Run, for now.** The snapshot is kept until the next run on that tree, or a day. Undo
  Run restores every file the run changed whose content is still what the run left; files
  changed since are listed and left alone. Agents 003 replaces this with history.
- **One run at a time per tree**; a second Run waits in line.
- `docs/architecture/story-browser/agent-runner.md` describes the runner, the MCP server and
  the snapshot.

**Verification:** a harness with a fake agent (a script that emits the same streaming JSON and
edits files) covers cursor mapping, status, finishing, failure, Stop and Undo Run. By hand
with Joe (CLI 004 step 3): from outside the checkout, a research task over two placed trees and
one edit, then a real task on a day plan, watched from the iPhone.

## Not in this plan

- Questions and answers, Run from the iPhone and Codex:
  [Agents 002](agents-002-talk-to-the-agent-and-run-from-anywhere.md).
- Exact carets and selections, for people and agents: [Live 002](live-002-exact-carets.md).
- Suggestions, for people and agents: [Editor 003](editor-003-suggestions.md).
- Runs in history, Undo Run through history, the task archive and attribution:
  [Agents 003](agents-003-agent-runs-in-history.md).
- **Authored, host-run agents** stay [Apps 002](../later/apps-002-overstoryd-hosted-agents.md):
  agents that are part of a published app, used by visitors, calling the app's handles.
- **Story for the web** joins with [Web 025](../later/story-web-025-story-web.md). The contract
  is plain SSE and POST, so a browser needs nothing new.
- **Typing indicators, follow mode and avatars from the profile's image.** The roster carries
  the profile TreeID, so an avatar can be added later without a contract change.

## Open questions

1. **Re-anchoring across versions** (from Live 001). Byte offsets into another version are
   approximate. If that proves too rough in phase 4, a selection could carry a short quote of
   the text around `head` (as in W3C Web Annotation's `TextQuoteSelector`) at about 60 bytes
   more per update. Decide from phase 4's hands-on use.
2. **Concurrent editing.** Joe typing on a page while the agent edits the same page goes
   through the host's merge, which handles prose well. Watch phase 7's hands-on use for
   conflicts before adding any locking.

## Close out

Record the presence contract, the runner and the skill's location in `status.md`, and delete
this plan. (Live 001 and CLI 004 were folded into it on 2026-10-30.)
