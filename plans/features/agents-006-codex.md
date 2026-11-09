# Agents 006: Codex as a runner

**Why:** Codex should work as well as Claude Code (Joe, 2026-10-30). Split from Agents 002 (Joe, 2026-11-07).

**Order:** after [Agents 002](../../status.md#agents-002-run-tasks-from-anywhere--2026-11-07), which defines the run
request, `story agent start --task` and the Runners list.

## Status

- **Effort:** S to M.
- **Risk:** MEDIUM: it starts agents with write access to your trees from elsewhere.

## The work

The same runner with `codex exec`, the same skill and `story agent` commands. Codex's hooks are
weaker than Claude Code's, so check what it can report; where it can't, Story Sync falls back
to the files it sees change in the placed folder during the run. The Mac runner's entry picks
the agent; the presence label follows it.

**Verification:** the fake-agent harness with Codex's event shape, then one real task by hand.


## Close out

Record what was built in `status.md` and delete this plan.
