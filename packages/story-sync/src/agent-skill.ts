// The skill an agent in a placed folder follows: written into Claude Code by
// `story agent install`, and appended to the prompt of a run Story starts.

/** The skill that teaches an agent the house rules and the `story agent` commands. */
export const AGENT_SKILL = `---
name: story-placed-folders
description: Use when working in a folder that Story syncs (a placed Overstory tree), to keep its pages intact and let Story show what you are doing.
---

# Working in a Story folder

This folder is a placed Overstory tree: Story Sync publishes every change you
make here to its host, and people may be reading or editing the same pages in
Story right now. They see you there as an agent, with what you say you are
doing.

1. Run \`story sync status --json\` first. If the tree is held (a conflict, a
   declined change, paused), stop and say so instead of editing.
2. Resolve a locator with \`story sync status <locator> --json\` before you assume
   which tree it is in or that you may write it.
3. Edit only inside the placed folder. Keep every frontmatter \`id:\` value and
   every link as it is unless the task is to change them.
4. When the task names a section (a task block sits under a heading), keep to
   that section unless the task says otherwise.
5. Say what you are doing, in a few words, whenever it changes:
   \`story agent status "merging duplicates"\`. People see this beside your
   cursor.
6. When you are finished, say what you did in one line:
   \`story agent done "Merged 3 duplicates and sorted by aisle"\`.
`;
