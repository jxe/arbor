# Agents 002: talk to the agent, and run tasks from the iPhone

**Timing:** Later, after [Agents 001](../../status.md#agents-001-presence-and-agent-tasks--2026-11-01).

**Why and when:** the harder half of what Joe described on 2026-10-30 (thread "Bring AI into
Story smoothly"). Presence for an agent should support more back and forth than presence in
Google Docs or Notion: the agent can ask, and Joe answers right at its cursor, from whichever
device he's on. Run should work from the iPhone whenever the Mac happens to be awake. Codex
should work as well as Claude Code. Exact carets ([Live 002](live-002-exact-carets.md)) and suggestions ([Editor 003](editor-003-suggestions.md)) are
their own plans, for people and agents alike (Joe, 2026-10-30). Runs in history are
[overstoryd 007](history-007-document-history-routes-and-restore.md) steps 5 and 6.

> **Executor instructions**: Refresh "What happens today" against Agents 001 as built. Do the
> phases in order and stop after each for Joe's hands-on check. Phase 1 changes a host route,
> so it runs `bun run test:protocol`. Pushing `main` deploys overstoryd. Never test against
> `arb.nxhx.org`. Quagmire changes ship with an arbor release, never alone.

## Status

- **Effort:** M.
- **Risk:** LOW for the contract additions (in memory, nothing persisted). MEDIUM for Run from
  the iPhone, which starts a process on the Mac from another device.
- **Progress:** TODO.
- **Left from Agents 001, not built:** a dot beside each page in the sidebar where someone is,
  and `story sync status --wait` (agents check readiness with `story sync status`).

## What happens after Agents 001

- Presence routes, the hub, `HostPresenceRunner`, and the agent peer with a status line.
- Any Claude Code session in a placed folder reports to Story Sync through `story agent
  status|done|hook` (a skill, hooks and a permission that `story agent install` merges into
  Claude Code's user settings), and shows as an agent peer. Run on the Mac has Story Sync start
  `claude -p` there, with an APFS snapshot for Undo Run and one run at a time per tree.
- A cloud agent started from a bundle (`story agent start`) shows in presence too: start
  installs the same hooks labelled with the bundle's name, and its instructions tell any agent
  to report with `status` and `done`.
- Task blocks are `> [!agent]` quotes drawn as Quagmire callouts with Run, Stop and Undo Run.
- No way for the agent to ask, no Run on the iPhone, no Run in a cloud session, and no Codex.

## Decisions

From Joe, 2026-10-30, except where marked as a recommendation:

1. **The conversation vanishes.** Questions and answers are presence: never in the tree,
   never in history, gone when the stream closes.
2. **Questions stay between one person's devices** (recommendation). Others who can see the
   tree see that the agent is working and its status, but not its question or the answers.
3. **Run from the iPhone works only while a runner is present.** A runner is a Mac that can run
   tasks. With a cloud scheduled task set up (phase 5), Run works with no runner at all;
   otherwise Run is greyed out with "Your Mac is asleep".
4. **Messages go through presence, not the tree.** Asking a Mac to run a task, answering, and
   stopping are short ephemeral messages between one person's streams, so nothing is written
   to a page to make them happen.

## The contract additions (phase 1)

```text
GET  /.overstory/trees/{TreeID}/presence[?visible=false][&agent=<label>][&runner=true]
POST /.overstory/trees/{TreeID}/presence/{PresenceID}/messages
```

```ts
type PresencePeer = {
  // ...as in Agents 001, plus:
  runner: boolean;               // this stream's device can run tasks
};

type PresenceAgent = {
  label: string;
  status: string | null;
  question: { id: string; text: string } | null;  // only to the same profile's streams; null to others
};

// event: presence.message (only from a stream of the same profile, only to the named stream)
type PresenceMessage = { from: PresenceID; body: PresenceMessageBody };
type PresenceMessageBody =
  | { kind: "run"; page: { path: LogicalPath; stableKey: string | null }; task: PresenceSelection }
  | { kind: "answer"; question: string; text: string }
  | { kind: "stop" }
  | { kind: "done"; result: string };
```

The presence POST accepts `question` on an agent stream. The messages POST body is
`{ to: PresenceID, body }`, at most 1 KiB, delivered only when both streams are open and
belong to the same profile; otherwise `404`, the same answer as a missing peer. The host
relays the body and keeps nothing. A `run` message's `task` names the task block's byte range
in the page source the sender is showing. A runner stream is an ordinary person stream that
also says its device can run tasks; a hidden stream cannot be a runner.

## Phase 1: questions, runners and messages on the wire

Spec 11 (presence) gains the additions above; spec 05 §3.2 says messages flow only between one
profile's streams. Models in TypeScript and Swift, and vectors for a question, a runner and
each message kind (plus invalid ones: an unknown kind, an oversize body). The hub replaces a
question with `null` for subscribers of another profile and delivers messages.

**Verification:** integration tests: a question reaches only the same profile; a message
reaches the named stream of the same profile and is `404` across profiles or to a closed
stream; a hidden stream asking to be a runner is refused. Then `bun run test:affected` and
`bun run test:protocol`.

## Phase 2: the agent asks

- `story agent ask <text>` sets the question and blocks until an `answer` message arrives or
  the run is stopped, then prints the answer. Check it against Claude Code's and Codex's
  command timeouts; if waiting proves unreliable, this is the point to add the thin MCP
  wrapper over Story Sync's routes (Agents 001, decision 17).
- The agent's bubble grows a reply field when it has a question; Return sends `answer` to the
  agent stream. Stop sends `stop` from any of Joe's devices.
- The skill says when to ask: before a change it can't undo cleanly, or when the task is
  ambiguous, and otherwise not.

**Verification:** the fake-agent harness covers ask, answer and stop. By hand on the Mac and
iPhone: a task that must ask, answered from the other device.

## Phase 3: Run from the iPhone

- With "Run tasks on this Mac" on (a Mac setting, default on), the Mac keeps a runner stream
  on every tree placed on it, not only the open one.
- The phone's Run is enabled when the roster shows a runner of the same person. Pressing it
  sends `run` with the task's page and range. The Mac resolves the range against its own copy
  of the page (or by the block's text if the source differs) and runs it as Agents 001 does.
- If two Macs are runners, the phone picks the one most recently active and says which.

**Verification:** by hand: dictate a task on the phone, press Run with the Mac awake, answer
its question on the phone, see the result; with the Mac asleep, Run is greyed out. Check what
a runner stream on each placed tree costs the Mac and the host.

## Phase 4: Codex

The same runner with `codex exec`, the same skill and `story agent` commands. Codex's hooks are
weaker than Claude Code's, so check what it can report; where it can't, Story Sync falls back
to the files it sees change in the placed folder during the run. A
Mac setting picks the agent; the presence label follows it.

**Verification:** the fake-agent harness with Codex's event shape, then one real task by hand.

## Phase 5: Run in a Claude Code cloud session, and one name for agents

Run on the iPhone starts a fresh Claude Code cloud session on Joe's subscription through a
scheduled task's API trigger (research 2026-11-01 and 2026-11-06, [docs](https://code.claude.com/docs/en/routines)).
Nothing idles waiting for tasks and nothing on the Mac needs to be awake. This phase does not
depend on phases 1 to 3 (no presence messages), so it can be built first.

**What already exists.** A bundle or one-tree agent link (`story agent create`, or Share →
Use with an agent… on the Mac) checks trees out on any machine with `story agent start`,
and `finish` proves the work reached the host. `start` installs the hooks, so the session
shows in presence as Joe's agent. Story Sync holds publishing while the agent edits.

**The scheduled task.** One per person, made once on claude.ai (no schedule, API trigger only):

- **Environment:** network access Custom with the host's domain plus the default package list
  (npm); `STORY_CLOUD_BUNDLE` as an environment variable holding a bundle for the trees Run
  may touch; setup script `npm i -g @ovst/cli && story agent install`, so the hooks and skill
  are in Claude Code's settings before the session starts. Check whether a task with no
  repository can use a non-default environment; if not, give it a tiny repository.
- **Saved prompt:** the fire text arrives wrapped as untrusted `<routine-fire-payload>` data, so
  the saved prompt must say to carry out the Story task it describes: `story agent start
  --task …` with the payload's tree, page and task, do the task in the checked-out folder,
  `story agent done "<result>"`, then `story agent finish`. The fire text is never approval,
  so the skill's "ask before something you can't undo" holds (and waits, until phase 2).
- **Fire token:** shown once on claude.ai; Joe pastes the fire URL and token into the iPhone's
  Settings. Story keeps them in the Keychain (synced, so a Mac could fire too). A leaked token
  can start sessions that edit the bundle's trees, the same reach as a leaked bundle; Regenerate
  on claude.ai revokes it. Holding it on the host instead needs a secret store and a relay
  route there, so not in the first cut.

**To build:**

1. **`story agent start --task <page>:<task text>`** (or a `story agent task` subcommand) gives
   an outside agent the bookkeeping Run has on the Mac (`AgentRuns`) without Story Sync starting
   `claude -p`: the run is recorded against the block, `done` marks it `> [!agent-done]` with
   the result, and a failed or abandoned session leaves it unchanged with a note. Tests in the
   CLI sync suite with the fake agent.
2. **iPhone Run.** With a fire URL and token in Settings, Run POSTs `{text}` with the tree's
   canonical URL, the page path, the block's stable key and its text (beta header
   `experimental-cc-routine-2026-04-01`). The block shows "Starting in the cloud…" (on the
   phone only) until the agent joins the page's presence, then the usual bubble; the response's
   session URL is kept so the block menu can open the session. Errors (401, 30 fires an hour per
   task) show on the block. No Mac and no runner stream are involved.
3. **Undo Run** for a cloud run: the snapshot dies with the machine, so there is none until
   history restore ([overstoryd 007](history-007-document-history-routes-and-restore.md) step 6).
   Say so in the block menu rather than offer a button that can't work.
- **One name.** `story agent` holds both cloud bundles (`create`, `list`, `revoke`, `run`,
  `start`, `finish`) and presence reporting (`status`, `done`, `hook`, `install`). Pick the
  split before the commands are documented further: for example `story cloud …` for bundles
  and `story agent …` for reporting, keeping the old spellings as aliases for one release.

**Verification:** the fake-agent CLI test for `--task` (block marked done, failure leaves it);
an iOS unit test for the fire request; then by hand, Run from the iPhone with the Mac asleep
(in [Joe's to-do](../joe.md) when built). Waits on an `@ovst/cli` release with `--task`.

**Size:** S to M: the CLI bookkeeping is a reuse of `AgentRuns`' marking; the phone side is a
Settings pane, a Keychain entry and one request. Startup is a cold cloud machine plus `npm i`,
so expect a minute or two before the agent appears.

## Phase 6: show work in progress, when the agent chooses (Joe, 2026-11-01)

Since Agents 001, Story Sync holds a tree's publishing while an agent edits it: an edit tool's PreToolUse hook (or a Run's start) holds the folder in memory, and Stop, `done`, SessionEnd, the quiet timeout or the run's end lets go, so the work goes up as one change. Joe would like the text to sync while the agent works, at least sometimes, decided by the agent.

- `story agent sync` publishes what the folder holds now and keeps the hold, so a long task can show its progress at a point where the page reads well.
- The skill says when to use it: after each finished part of a long task, never mid-edit.
- Open: whether a Run can ask for live syncing up front (e.g. a task block option), and whether the person's own edits during a held run need anything beyond the usual merge.

## Phase 7: longer tasks as a task with blocks under it (Joe, 2026-11-01)

A task block can have blocks indented under it, like sub-bullets: the task line is the headline, the blocks under it are the details. Run sends the agent the task with all its children, and a finished run removes the task together with them. In Markdown the children are the quote's own nested content or the indented blocks that follow; settle which when this is built, so Story and `findTaskBlock` agree. (Shift-Return line breaks inside a task came first, in Agents 001's follow-ups.)

Settled 2026-11-06: phase 5 runs from the iPhone through a scheduled task's API trigger; phase 3's Mac runner stays for running on the Mac's own Claude Code.

## Not in this plan

- **A host-side runner** (perhaps beside the execution sidecar) that needs no cloud session of
  your own. The runner is a role a device takes on, so it could come later without a contract
  change.
- Exact carets: [Live 002](live-002-exact-carets.md). Suggestions: [Editor 003](editor-003-suggestions.md).
- Runs in history and attribution: [overstoryd 007](history-007-document-history-routes-and-restore.md) steps 5 and 6; both names in
  line provenance: [overstoryd 006](../later/history-006-line-provenance.md).

## Close out

Record what was built in `status.md` and delete this plan.
