# CLI 004: external agents work in placed folders

**Timing:** Later.

**Why and when:** Claude Code, Codex and other agents can already edit a placed folder with
their own tools. What they lack is knowing when a tree is ready, when their edit has reached
the host, and what not to touch. This was a small-work item; it moved here on 2026-10-28
because it is a project, not a chore.

## Status

- **Effort:** S to M.
- **Risk:** LOW. No new read or mutation commands, no MCP server, no new story-sync routes.
- **State:** TODO.

## Steps

`story sync status [<locator>] --json` already reports readiness and resolves locators.

1. Check whether `story sync status --json` shows that a local edit reached the host; if not,
   add `story sync status --wait [--timeout <s>]` (exit 0 when every in-scope tree is up to date,
   non-zero with the condition if one is held).
1. Write one short skill for Claude Code and Codex from one source: check `story sync status`
   first; resolve a locator before assuming its tree or writability; edit only the placed
   folder; keep frontmatter `id:` values and links; wait for publication and report changed
   paths; treat a held tree as a stop.
1. From outside the checkout, have both agents do a research task over two placed trees
   and one edit, wait for publication and report the changed locator; revise the skill.

## Close out

Record the skill's location and the agents' runs in `status.md`, and delete this plan.
