# Chores

Decided work too small for a plan: hand checks, schedules and soak gates left by finished
work, and small tasks. Anything here can just be done, with no design left. Anything not yet
decided is a [candidate](candidates.md); procedures live in the docs beside the code they test.
Nothing here authorizes installing, restarting Joe's apps, changing live data or deleting
backups. When an item is done, record its revision, date and evidence in
[status](../status.md) and delete it here.

## Hand checks

### Inviting and joining follow-ups

Left from the 2026-10-11 invitation work ([status](../status.md#cli-package-people-and-joining-by-invitation--2026-10-11)).

- [ ] Go through the Mac getting-started list by hand after a join: photo, Sync a Folder,
  a new folder in Documents, opening a shared tree. The host side is checked (a folder
  becomes a tree under a just-claimed account); the screen itself has only been compiled.
- [ ] Try **Install Command Line Tool…** from the released Mac app: the link at
  `/usr/local/bin/story`, the administrator prompt when that folder needs one, and `story
  --help` in a new Terminal window. The bundled command runs through a link; the menu item
  and the prompt have not been tried.

### Agents 001 follow-ups

Left from Agents 001 ([status](../status.md#agents-001-presence-and-agent-tasks--2026-11-01)).

- [ ] A real task on a day plan, started with Run on the Mac and watched from the iPhone: the
  agent's mark and bubble move as it reads and edits, the task ends checked off with its
  result, and Undo Run takes the change back.
- [ ] The iPhone leaves the roster within a second of going to the background and rejoins on
  return; a Mac on the same page sees both.
- [ ] Run the app-hosted Story tests for presence and agent runs with Story quit.

### Schedule the object collector

Formerly overstoryd 017; the first live run is recorded in
[status](../status.md#known-gaps). A bound on `document_versions`, which holds most retained
bytes, is part of [overstoryd 007](features/history-007-document-history-routes-and-restore.md).

- [ ] Schedule the `railway ssh` collection command
  ([deployment](../packages/overstoryd/deploy/README.md#collecting-unreferenced-objects))
  daily or weekly from Joe's machine, keeping each report. Joe's go-ahead.

## Observation and soak closeout

Dated evidence closes these; elapsed time alone does not.

- [ ] **Declined folder paths (Filesystem 011):** after Story Sync restarts on it, record one
  real rejection (a `LinkPreviews/` directory in the account checkout is easiest), that
  other edits still publish, `story sync declined` lists the path, and `story sync declined restore`
  removes it.
