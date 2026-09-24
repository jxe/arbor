# CLI 004: Teach external agents to work in placed folders

Historical identifier: **Smaller project 004**. Cut down 2026-09-24: the earlier
read/mutation command surface (`arbor read`, `children`, `search`, `backlinks`,
`recovery`, `write`, `create`, `move`, `copy`, `trash`, `restore`) is dropped. It was
to be "thin commands over `ArborSyncRESTClient`", but after the working-tree
redesign that client has no read, search or mutation calls, and adding them would
put an editor path back in the daemon. Git history keeps the old plan.

**Status:** PLANNED · S. Nothing below is built yet; what it builds on is.

## What an agent already has

- **Placed folders are the interface.** An agent reads and edits ordinary files in a
  placed tree with its own tools; Arbor Sync's update machine publishes the changes
  and pulls others' (see [the update machine](../../docs/implementing-sync-services/update-machine.md)).
- **`arbor status [<locator>] --json`** reports whether Arbor Sync is running, every
  in-scope tree's condition, and an overall `ready`; with a locator it also resolves
  it (tree ref, historical flag, placement condition). This already covers the old
  plan's `arbor resolve`.
- **Short-lived cloud workspaces** (`arbor cloud ...`) give a sandboxed agent an
  isolated root with exact placements and an explicit finish
  ([CLI](../../docs/getting-started/cli.md#short-lived-cloud-sessions)).

## Work

1. **Wait for publication.** An agent needs to know its edits reached Canopy before
   it reports them. Check whether `arbor status --json`'s `ready` and per-tree
   conditions already say that after a local edit (pending, held, up to date). If
   not, add `arbor status --wait [--timeout <s>]`, which exits 0 once every in-scope
   tree is up to date and non-zero with the tree's condition if one is held.
2. **One reusable skill**, packaged for Claude Code and Codex from one source. It
   teaches the agent to:
   1. run `arbor status --json` first and stop if Arbor Sync is not ready;
   2. resolve a locator with `arbor status <locator> --json` before assuming its
      tree, placement or writability;
   3. edit files in the placed folder only, never under Arbor's state directories;
   4. keep Markdown frontmatter `id:` values and links intact;
   5. wait for publication (step 1) and report the changed paths; and
   6. treat a held tree as a stop: report it, don't retry or discard.
   Keep it short; command help stays authoritative.
3. **Try it from outside the checkout.** Run Claude Code and Codex from a directory
   outside this repository on a research task over two placed trees and an edit
   task on one document; revise the skill from what goes wrong.

## Completion gate

From outside the source checkout, both agents discover the skill, confirm Arbor Sync
is ready, make one edit in a placed folder, wait until it is published, and report
the changed locator.

## Later, not in this plan

`arbor call <script-locator#handle> --input <json>` for compiled query and mutation
handles, once Apps 003 and 006 produce them.

## Deliberate absences

No model-provider client or Overstory-owned conversation loop, no MCP server before
the CLI proves insufficient, no new arborsync routes, and no direct writes to
Arbor's private state.
