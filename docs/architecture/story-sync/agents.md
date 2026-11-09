# Agents in placed folders

[Story Sync](README.md) · [Story Sync API §4a](../../implementing-sync-services/story-sync-api.md#4a-agents-in-placed-folders) · [Spec 12: presence](../../overstory-spec/12-presence.md)

Agents 001 shows any agent working in a placed folder as an agent of this
device's person. `AgentSessions` (`packages/story-sync/src/agents.ts`) keeps
one session per agent session:

- **Opening.** The first report for a session resolves its `cwd` to a placed
  tree (through the same scope resolution as `GET /v1/resolve`), opens an
  agent presence stream on that tree with the account's own client, and keeps
  reading it so the host's queue never backs up.
- **Following.** A Claude Code `PostToolUse` hook for Read, Edit, MultiEdit or
  Write moves the entry to that file's logical page. The cursor is a byte range
  in the file as it is now, named by `hashObject` of its bytes: the lines read,
  the first occurrence of an edit's new text, or the end of a written file.
  A file outside the session's tree moves nothing. Changes coalesce to at most
  four POSTs a second, the page before the rest because a page change clears
  the selection at the host.
- **Status.** The agent's own `story agent status` wins; otherwise the hook's
  tool names one ("Editing Groceries"). `Stop` shows "Waiting".
- **Ending.** `done` shows its text and leaves after five seconds; `SessionEnd`
  leaves at once; ten quiet minutes leave.

`story agent install` writes hooks, the skill and the `Bash(story agent:*)`
permission into `~/.claude/settings.json` and `~/.claude/skills/`, rather than
packaging a Claude Code plugin, so it needs no marketplace; reinstalling
replaces its own entries and uninstalling removes only them. All three name the
command that installed them, so `story agent start` from the npm package writes
`npx @ovst/cli agent` instead.

## Runs

`AgentRuns` (`packages/story-sync/src/agent-runs.ts`) starts a task's run:

- **Finding the agent.** Story Sync runs under launchd without the person's
  shell PATH, so `findClaude` tries `STORY_CLAUDE_PATH`, then the usual install
  locations (`~/.claude/local`, `~/.local/bin`, Homebrew, `/usr/local/bin`),
  then `PATH`.
- **Starting.** One run at a time per tree. The run snapshots the folder
  (every file but `.state` and `.git`, cloned where the filesystem can, as
  APFS does), records each file's hash, and starts `claude -p` in the folder
  with streaming JSON, `--session-id` set to the run's session, edits accepted,
  only file tools plus `story agent` and `story sync status`, and the skill
  appended to the system prompt. `STORY_AGENT_SESSION` makes the agent's own
  `story agent` commands land in the run's session.
- **Following.** The runner reads the agent's stream itself and reports each
  finished tool call as a hook would, so a run shows in presence whether or
  not `story agent install` was run.
- **Finishing.** On success it marks the task block done, `> [!agent-done]`
  with its text unchanged (matched by its text and continuation lines), and
  publishes. The person deletes done tasks when they no longer need Undo. The
  result is the agent's `story agent done` line, else the first line of its
  final message. Failure keeps the block and shows the last line of stderr.
- **Undo.** The files the run changed, with their hashes right after it, and
  the snapshot, kept for a day and saved in `agent-runs/runs.json` so they
  survive a restart. [overstoryd 007](../../../plans/later/history-007-page-history.md)
  step 7 plans to replace this with a history restore.
- **Run requests.** A run can be named by a run request (spec 12 §6): its
  `run` becomes the run's ID, so the same request sent twice runs once, and
  the agent's presence entry carries it as `agent.run`. When the folder holds
  the sender's version of the page (the range's `source` hash matches), the
  block under the range is the task; otherwise the first block with the
  task's text. At the end the block is found again by text, nearest the line
  it started on.

## Runs someone else starts

`story agent start --task <run request>` (JSON, `@file` or
`STORY_RUN_REQUEST`) posts the request to `/v1/agents/runs` with
`external: true`, at the Story Sync serving the tree's folder: this machine's,
or a fresh checkout's when a bundle is given too. Story Sync starts nothing.
It holds the tree, opens the agent's presence entry with the run's ID as a
*stand-in*, and prints what the agent should be told. The first other agent
session to report in that tree (Claude Code's hooks name their own session)
takes the stand-in over rather than showing twice. When that session says
`story agent done`, the block is marked done and published before the command
returns, so a `story agent finish` right after sends it; a session that ends
without `done` leaves the block and the run fails with why. External runs keep
no snapshot, so they have no Undo Run.

## The Mac as a runner

`TaskRunner` (`packages/story-sync/src/task-runner.ts`) runs in the device's
own long-lived Story Sync (`--control`, not a cloud session's), unless
`story agent runner off` (kept in `.state/runner.json`) or
`STORY_SYNC_RUNNER=0`. It keeps one presence stream per placed tree, opened
with `runner=<the Mac's name>` and `device=mac`, and every 30 seconds reopens
any that ended and follows placements that came or went. A `run` message
catches the folder up with the host, then starts the run as Run on the Mac
does, on the stream's own tree whatever URL the request names; when the run
ends, the sender is told `done` with the result ("Stopped", or "Failed: …"
for a run that failed or could not start). `stop` stops a run on that tree.
Clients list runner entries apart from people: the iPhone sends Run to the
newest of the person's own runners and offers the others on a long press.
