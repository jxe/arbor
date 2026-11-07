# Agents 002: run tasks from anywhere

**Why and when:** from what Joe described on 2026-10-30 (thread "Bring AI into Story
smoothly"). Run should work from the iPhone, and (Joe, 2026-11-06) each user should be able
to choose what runs their tasks: their Mac, a cloud session, or anything else that can start
an agent, with Story knowing only "send this task to a runner". Webhook runners (a claude.ai
scheduled task, GitHub Actions, your own server) are [Agents 005](../features/agents-005-webhook-runners.md)
and Codex is [Agents 006](../features/agents-006-codex.md) (Joe, 2026-11-07). Talking to the agent while it works is [Agents 004](../features/agents-004-talk-to-the-agent.md)
(split off by Joe, 2026-11-07). Runs in history are
[overstoryd 007](../later/history-007-page-history.md) steps 6 and 7.

> **Executor instructions**: Refresh "What happens after Agents 001" against Agents 001 as built. Do the
> phases in order and stop after each for Joe's hands-on check. Phase 1 changes a host route,
> so it runs `bun run test:protocol`. Pushing `main` deploys overstoryd. Never test against
> `arb.nxhx.org`. Quagmire changes ship with an arbor release, never alone.

## Status

- **Effort:** M to L.
- **Risk:** LOW for the contract additions (in memory, nothing persisted). MEDIUM for runners,
  which start agents with write access to your trees from another device or a URL.
- **Progress:** TODO. Agents 001 is done (2026-11-01). Done early: a cloud agent from a bundle
  shows in presence under the bundle's label.
- **Left from Agents 001, not built:** `story sync status --wait` (agents check readiness
  with `story sync status`).

## What happens after Agents 001

- Presence routes, the hub, `HostPresenceRunner`, and the agent peer with a status line.
- Any Claude Code session in a placed folder reports to Story Sync through `story agent
  status|done|hook` (a skill, hooks and a permission that `story agent install` merges into
  Claude Code's user settings), and shows as an agent peer. Run on the Mac has Story Sync start
  `claude -p` there (`AgentRuns`), with an APFS snapshot for Undo Run and one run at a time per
  tree; success marks the block `> [!agent-done]` with the result.
- A bundle or one-tree agent link (`story agent create`, or Share → Use with an agent… on the
  Mac) checks trees out on any machine with `story agent start`; `finish` proves the work
  reached the host. `start` installs the hooks labelled with the bundle's name.
- Task blocks are `> [!agent]` quotes drawn as Quagmire callouts with Run, Stop and Undo Run.
- No Run on the iPhone, and no runner but the Mac you're on.

## Decisions

From Joe, 2026-11-06:

1. **Story only sends a task to a runner.** A run request is the same wherever it goes, and
   whatever runs it opens with `story agent start --task`, so presence, the done mark and the
   result look the same whichever runner did the work.
2. **Two ways to reach a runner.** A *present runner* keeps a presence stream open and receives
   `run` as a presence message (a Mac; later a host runner or a Codex machine); it is offered
   only while online. A *webhook runner* is a URL and a secret the device POSTs the run request
   to (a claude.ai scheduled task, GitHub Actions, your own server); it is always offered.
3. **Each person picks.** Run uses the default runner and a long-press picks another. With
   no runner available, Run is greyed out and says why ("Your Mac is asleep").
4. **Messages go through presence, not the tree.** Asking a present runner to run a task and
   stopping it are short ephemeral messages between one person's streams, so nothing is
   written to a page to make them happen. They vanish like presence.

## The contract additions (phase 1)

```text
GET  /.overstory/trees/{TreeID}/presence[?visible=false][&agent=<label>][&runner=<label>]
POST /.overstory/trees/{TreeID}/presence/{PresenceID}/messages
```

```ts
// The one thing every runner receives.
type RunRequest = {
  tree: string;                                   // canonical tree URL
  page: { path: LogicalPath; stableKey: string | null };
  task: { text: string; range: PresenceSelection | null };  // range in the sender's source, if known
  run: string;                                    // run id, chosen by the sender
};

type PresencePeer = {
  // ...as in Agents 001, plus:
  runner: string | null;         // a runner's label ("Joe's Mac") when this stream runs tasks
};

type PresenceAgent = {
  label: string;
  status: string | null;
  run: string | null;            // the run this agent is doing, so a phone can match it to the block
};

// event: presence.message (only from a stream of the same profile, only to the named stream)
type PresenceMessage = { from: PresenceID; body: PresenceMessageBody };
type PresenceMessageBody =
  | { kind: "run"; request: RunRequest }
  | { kind: "stop"; run: string }
  | { kind: "done"; run: string; result: string };
```

The presence POST accepts `run` on an agent stream. The messages POST body is
`{ to: PresenceID, body }`, at most 4 KiB, delivered only when both streams are open and
belong to the same profile; otherwise `404`, the same answer as a missing peer. The host
relays the body and keeps nothing. A runner stream is an ordinary person stream that also
names itself as a runner; a hidden stream cannot be a runner. [Agents 004](../features/agents-004-talk-to-the-agent.md)
adds a question and an `answer` message on the same route.

## Phase 1: runners and messages on the wire

Spec 11 (presence) gains the additions above; spec 05 §3.2 says messages flow only between one
profile's streams. `RunRequest` gets its own section, since webhook runners receive it too
([Agents 005](../features/agents-005-webhook-runners.md)). Models in TypeScript and Swift, and vectors for a run request, a runner and each
message kind (plus invalid ones: an unknown kind, an oversize body). The hub delivers messages.

**Verification:** integration tests: a message reaches the named stream of the same profile
and is `404` across profiles or to a closed stream; a hidden stream asking to be a runner is
refused. Then `bun run test:affected` and `bun run test:protocol`.

## Phase 2: one way to run a task, whatever runs it

- **`story agent start --task <run request>`** (JSON, or `@file`, or `STORY_RUN_REQUEST`) checks
  out the request's tree if it isn't placed, finds the task block (by range, else by text, as
  `findTaskBlock` does), records the run, and joins presence with `run` set. `story agent done
  "<result>"` marks the block `> [!agent-done]` with the result; `finish` (or the session
  ending without `done`) leaves the block and shows why. The skill tells the agent what the
  task is and these steps.
- **Mac Run uses the same path.** `AgentRuns` keeps starting `claude -p`, but its bookkeeping
  becomes this code, so a Mac run, a webhook run and a by-hand run behave alike.
- **Undo Run** needs the pre-run snapshot, so it's offered only by a runner that keeps one (the
  Mac); others say "Undo needs history" until [overstoryd 007](../later/history-007-page-history.md)
  step 7.

**Verification:** the fake-agent harness runs a request on a placed tree and on a fresh
checkout from a bundle: block marked done with the result; a failed or abandoned run leaves
the block; a second client sees the agent with the run's id.

## Phase 3: the Mac as a runner, and Run from the iPhone

- **Story Sync is the Mac's runner**, since it runs whether or not Story is open and already
  starts runs (`AgentRuns`). With running on (`story agent runner on|off`, default on), it
  keeps a runner stream, labelled with the Mac's name, on every tree placed on the Mac, and
  runs each `run` message as phase 2 does, answering `done` to the sender when it ends.
- **The runners you can pick** are the present runners in a tree's roster: your own streams
  with a runner label. With several, the one that joined last is the default. A list kept in
  the configuration tree is needed only for runners that aren't present, so it moves to
  [Agents 005](../features/agents-005-webhook-runners.md).
- **Run on the iPhone** sends `run` from the page's presence stream to the default runner;
  the block shows "Starting…" until an agent with that run id joins, then the agent's status.
  With no runner present, Run is greyed out and says why ("Your Mac isn't running Story
  Sync"). Stop sends `stop`.

**Verification:** a Story Sync test with a fake agent: a `run` message on a placed tree runs
and answers `done`; `stop` stops it. By hand: dictate a task on the phone, press Run with the
Mac awake, see the result; with Story Sync stopped, Run is greyed out. Check what a runner
stream on each placed tree costs the Mac and the host.

## Phase 4: one name for agents

`story agent` keeps every command (Joe, 2026-11-07): its help groups them into the ones
for you (`create`, `list`, `revoke`, `run`) and the ones for the agent (`start`, `finish`,
`status`, `done`, `hook`, `install`).

## Not in this plan

- **More runner kinds**, each added later without changing the run request:
  - *A host runner on the user's subscription:* the user runs `claude setup-token` once,
    the host keeps the token encrypted and runs headless Claude Code in a sandbox beside the
    execution sidecar, as a present runner on every tree of that account. Needs a check that
    Anthropic's terms allow a setup-token to run on a server, even for its owner.
  - *An agent inside Story on the iPhone* with the user's own API key: no Mac, host or
    claude.ai, billed per use, not Claude Code (Story writes the loop and page tools), and
    stopped by iOS shortly after the app leaves the screen, so short tasks only. A
    subscription token can't be used this way.
- Exact carets: [Live 002](../features/live-002-exact-carets.md). Suggestions: [Editor 003](../features/editor-003-suggestions.md).
- Runs in history and attribution: [overstoryd 007](../later/history-007-page-history.md) steps 6 and 7; both names in
  line provenance: its steps 8 and 9.

## Close out

Record what was built in `status.md` and delete this plan.
