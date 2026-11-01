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
