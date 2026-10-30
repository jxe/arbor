# Agents 002: talk to the agent, and run tasks from the iPhone

**Timing:** Later, after [Agents 001](agents-001-presence-and-a-first-agent.md).

**Why and when:** the harder half of what Joe described on 2026-10-30 (thread "Bring AI into
Story smoothly"). Presence for an agent should support more back and forth than presence in
Google Docs or Notion: the agent can ask, and Joe answers right at its cursor, from whichever
device he's on. Run should work from the iPhone whenever the Mac happens to be awake. Codex
should work as well as Claude Code. Exact carets ([Live 002](live-002-exact-carets.md)) and suggestions ([Editor 003](editor-003-suggestions.md)) are
their own plans, for people and agents alike (Joe, 2026-10-30). Runs in history are
[Agents 003](agents-003-agent-runs-in-history.md).

> **Executor instructions**: Refresh "What happens today" against Agents 001 as built. Do the
> phases in order and stop after each for Joe's hands-on check. Phase 1 changes a host route,
> so it runs `bun run test:protocol`. Pushing `main` deploys overstoryd. Never test against
> `arb.nxhx.org`. Quagmire changes ship with an arbor release, never alone.

## Status

- **Effort:** M.
- **Risk:** LOW for the contract additions (in memory, nothing persisted). MEDIUM for Run from
  the iPhone, which starts a process on the Mac from another device.
- **Progress:** TODO, waiting on Agents 001.

## What happens after Agents 001

- Presence routes, the hub, `HostPresenceRunner`, and the agent peer with a status line.
- Task blocks, and Run on the Mac with Claude Code in the placed folder, with a Story MCP
  server (`status`, `done`), cursor following from the agent's streamed tool calls, an APFS
  snapshot for Undo Run, and one run at a time per tree.
- No way for the agent to ask, no Run on the iPhone, and no Codex.

## Decisions

From Joe, 2026-10-30, except where marked as a recommendation:

1. **The conversation vanishes.** Questions and answers are presence: never in the tree,
   never in history, gone when the stream closes.
2. **Questions stay between one person's devices** (recommendation). Others who can see the
   tree see that the agent is working and its status, but not its question or the answers.
3. **Run from the iPhone works only while a Mac that can run tasks is present.** Otherwise Run
   is greyed out with "Your Mac is asleep". No cloud runner.
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

- The Story MCP server gains `ask(text)`, which sets the question and blocks until an `answer`
  message arrives or the run is stopped.
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

The same runner with `codex exec` and its JSON event stream, the same skill and MCP server. A
Mac setting picks the agent; the presence label follows it.

**Verification:** the fake-agent harness with Codex's event shape, then one real task by hand.

## Not in this plan

- **Running tasks in the cloud** when no Mac is awake. The runner is a role a device takes on;
  a host-side runner (perhaps beside the execution sidecar) could take it later without a
  contract change.
- Exact carets: [Live 002](live-002-exact-carets.md). Suggestions: [Editor 003](editor-003-suggestions.md).
- Runs in history and attribution: [Agents 003](agents-003-agent-runs-in-history.md).

## Close out

Record what was built in `status.md` and delete this plan.
