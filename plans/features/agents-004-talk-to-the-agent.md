# Agents 004: talk to the agent while it works

**Why and when:** the other half of what Joe described on 2026-10-30 (thread "Bring AI into
Story smoothly"), split from [Agents 002](../../status.md#agents-002-run-tasks-from-anywhere--2026-11-07) by Joe
on 2026-11-07. Presence for an agent should support more back and forth than presence in
Google Docs or Notion: the agent can ask, and Joe answers right at its cursor, from whichever
device he's on. Exact carets ([Live 002](live-002-exact-carets.md)) and suggestions
([Editor 003](editor-003-suggestions.md)) are their own plans, for people and agents alike
(Joe, 2026-10-30).

**Order:** after Agents 002 phase 1, whose presence messages route this uses.

> **Executor instructions**: Phase 1 changes a host route, so it runs `bun run test:protocol`.
> Pushing `main` deploys overstoryd. Never test against `arb.nxhx.org`. Stop after each phase
> for Joe's hands-on check.

## Status

- **Effort:** M.
- **Risk:** LOW: questions and answers are presence, in memory, nothing persisted.
- **Left from Agents 001, not built:** a dot beside each page in the sidebar where someone is.

## Decisions

From Joe, 2026-10-30, except where marked as a recommendation:

1. **The conversation vanishes.** Questions and answers are presence: never in the tree,
   never in history, gone when the stream closes.
2. **Questions stay between one person's devices** (recommendation). Others who can see the
   tree see that the agent is working and its status, but not its question or the answers.

## Phase 1: questions and answers on the wire

```ts
type PresenceAgent = {
  // ...as in Agents 002, plus:
  question: { id: string; text: string } | null;  // only to the same profile's streams; null to others
};

type PresenceMessageBody =
  // ...as in Agents 002, plus:
  | { kind: "answer"; question: string; text: string };
```

The presence POST accepts `question` on an agent stream; the hub replaces it with `null` for
subscribers of another profile. Spec 11, models in TypeScript and Swift, and vectors.

**Verification:** integration tests: a question reaches only the same profile; an answer
reaches the named stream of the same profile only.

## Phase 2: the agent asks

- `story agent ask <text>` sets the question and blocks until an `answer` message arrives or
  the run is stopped, then prints the answer. Check it against Claude Code's and Codex's
  command timeouts; if waiting proves unreliable, this is the point to add the thin MCP
  wrapper over Story Sync's routes (Agents 001, decision 17).
- The agent's bubble grows a reply field when it has a question; Return sends `answer` to the
  agent stream. Stop sends `stop` from any of Joe's devices, to any runner's agent.
- The skill says when to ask: before a change it can't undo cleanly, or when the task is
  ambiguous, and otherwise not.

**Verification:** the fake-agent harness covers ask, answer and stop. By hand on the Mac and
iPhone: a task that must ask, answered from the other device.

## Phase 3: show work in progress, when the agent chooses (Joe, 2026-11-01)

Since Agents 001, Story Sync holds a tree's publishing while an agent edits it: an edit tool's PreToolUse hook (or a Run's start) holds the folder in memory, and Stop, `done`, SessionEnd, the quiet timeout or the run's end lets go, so the work goes up as one change. Joe would like the text to sync while the agent works, at least sometimes, decided by the agent.

- `story agent sync` publishes what the folder holds now and keeps the hold, so a long task can show its progress at a point where the page reads well.
- The skill says when to use it: after each finished part of a long task, never mid-edit.
- Open: whether a Run can ask for live syncing up front (e.g. a task block option), and whether the person's own edits during a held run need anything beyond the usual merge.

## Phase 4: longer tasks as a task with blocks under it (Joe, 2026-11-01)

A task block can have blocks indented under it, like sub-bullets: the task line is the headline, the blocks under it are the details. Run sends the agent the task with all its children, and a finished run removes the task together with them. In Markdown the children are the quote's own nested content or the indented blocks that follow; settle which when this is built, so Story and `findTaskBlock` agree. (Shift-Return line breaks inside a task came first, in Agents 001's follow-ups.)


## Close out

Record what was built in `status.md` and delete this plan.
