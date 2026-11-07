# Agents 002: run tasks from anywhere

**Why and when:** from what Joe described on 2026-10-30 (thread "Bring AI into Story
smoothly"). Run should work from the iPhone, and (Joe, 2026-11-06) each user should be able
to choose what runs their tasks: their Mac, a cloud session, or anything else that can start
an agent, with Story knowing only "send this task to a runner". Codex should work as well as
Claude Code. Talking to the agent while it works is [Agents 004](../features/agents-004-talk-to-the-agent.md)
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
- No Run on the iPhone, no runner but the Mac you're on, and no Codex.

## Decisions

From Joe, 2026-11-06:

1. **Story only sends a task to a runner.** A run request is the same wherever it goes, and
   whatever runs it opens with `story agent start --task`, so presence, the done mark and the
   result look the same whichever runner did the work.
2. **Two ways to reach a runner.** A *present runner* keeps a presence stream open and receives
   `run` as a presence message (a Mac; later a host runner or a Codex machine); it is offered
   only while online. A *webhook runner* is a URL and a secret the device POSTs the run request
   to (a claude.ai scheduled task, GitHub Actions, your own server); it is always offered.
3. **Each person picks.** Settings has a Runners list, kept in the configuration tree; Run
   uses the default runner and a long-press picks another. With no runner available, Run is
   greyed out and says why ("Your Mac is asleep").
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
(phase 5). Models in TypeScript and Swift, and vectors for a run request, a runner and each
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

## Phase 3: the Runners list and the Mac runner

- **Runners in Settings** on the Mac and iPhone: each entry has a label, a kind (present or
  webhook), and is default or not. Present runners appear by themselves while online; webhook
  runners are added by hand.
- **The list lives in the configuration tree** (Joe, 2026-11-06; spec 04 §7) as `runners.yaml`,
  so every device of the account sees it. `tree-config-v1`'s closed file set gains it: entries
  keyed by a runner ID, each with its label, kind, URL (for a webhook), default flag, and the
  `DeviceID` of its bundle from `devices.yaml`. Revoking that device removes the runner, and
  removing the runner revokes the device, in one accepted root. No secret is written there:
  the webhook's secret stays in the Keychain (synced by iCloud), and the bundle's credential
  stays where it was handed out.
- **The Mac as a runner.** With "Run tasks on this Mac" on (default on), the Mac keeps a runner
  stream on every tree placed on it, not only the open one, and runs `run` messages as phase 2
  does. If two Macs are runners, the most recently active is the default.
- **Run on the phone** sends `run` to the chosen present runner, or POSTs to a webhook runner
  (phase 5). The block shows "Starting…" on the phone until an agent with that run id joins.

**Verification:** by hand: dictate a task on the phone, press Run with the Mac awake, see the
result; with the Mac asleep and no webhook runner, Run is greyed out. Check what a runner
stream on each placed tree costs the Mac and the host.

## Phase 4: one name for agents

`story agent` holds both cloud bundles (`create`, `list`, `revoke`, `run`, `start`, `finish`)
and presence reporting (`status`, `done`, `hook`, `install`). Pick the split before the
commands are documented further: for example `story cloud …` for bundles and `story agent …`
for reporting, keeping the old spellings as aliases for one release. Do this before phase 5's
prompt is published, since that prompt names the commands.

## Phase 5: webhook runners, starting with a claude.ai scheduled task

- **The request.** `POST <url>` with the run request as JSON and `Authorization: Bearer
  <secret>`. The runner's answer may carry `{ "url": … }`, which the block menu opens ("Open
  session"). Errors show on the block.
- **Access.** A webhook runner usually starts on a machine with nothing placed.
  Adding one mints a bundle for it (on a device that can create bundles) and the request
  carries its agent link, so the remote side needs no stored secret of ours; removing the
  runner revokes the bundle (Joe, 2026-11-06).
- **The claude.ai preset.** A scheduled task with only an API trigger: the request goes as
  `{"text": …}` with the beta header `experimental-cc-routine-2026-04-01`. Fire text arrives
  wrapped as untrusted `<routine-fire-payload>`, so the saved prompt opts in: "Run the Story
  task in the payload: `npx @ovst/cli agent start --task` with it, do the task, `done`,
  `finish`." The fire text is never approval, so the skill's "ask before what you can't undo"
  holds. `npx` needs no setup script, since npm is on the default allowlist; the user still
  allows their host's domain in the environment's network settings, which nothing can do for
  them. "Add claude.ai runner…" copies the prompt, opens claude.ai/code/routines, and takes
  the fire URL and token back, checking them with a test fire. Limits: 30 fires an hour per
  task; a cold start takes a minute or two.
- **Other webhooks** (GitHub Actions, your own server) take the same JSON; docs give one
  example of each.

**Verification:** a local webhook harness receives the request and runs phase 2's path; an
iOS unit test for both request shapes; by hand, Run from the iPhone with the Mac asleep
through the claude.ai preset.

## Phase 6: Codex

The same runner with `codex exec`, the same skill and `story agent` commands. Codex's hooks are
weaker than Claude Code's, so check what it can report; where it can't, Story Sync falls back
to the files it sees change in the placed folder during the run. The Mac runner's entry picks
the agent; the presence label follows it.

**Verification:** the fake-agent harness with Codex's event shape, then one real task by hand.

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
