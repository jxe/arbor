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
replaces its own entries and uninstalling removes only them.

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
- **Finishing.** On success it removes the task block (matched by its text,
  with its continuation lines and the blank line after) and publishes. The
  result is the agent's `story agent done` line, else the first line of its
  final message. Failure keeps the block and shows the last line of stderr.
- **Undo.** The files the run changed, with their hashes right after it, and
  the snapshot. The snapshot goes when the tree's next run starts or after a
  day. Agents 003 replaces this with history.
