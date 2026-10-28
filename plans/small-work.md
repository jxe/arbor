# Small work and verification

Tasks too small for a plan of their own, and the install, deploy, hand-check and soak
gates left by finished work. Nothing here authorizes installing, restarting Joe's apps,
changing live data or deleting backups. When an item is done, record its revision, date
and evidence in [status](../status.md) and delete it here.

## Small work

### Teach external agents to work in placed folders

Formerly CLI 004. Agents edit placed folders with their own tools; `story sync status [<locator>]
--json` already reports readiness and resolves locators. No new read/mutation commands, no
MCP server, no new story-sync routes.

- [ ] Check whether `story sync status --json` shows that a local edit reached the host; if not,
  add `story sync status --wait [--timeout <s>]` (exit 0 when every in-scope tree is up to date,
  non-zero with the condition if one is held).
- [ ] Write one short skill for Claude Code and Codex from one source: check `story sync status`
  first; resolve a locator before assuming its tree or writability; edit only the placed
  folder; keep frontmatter `id:` values and links; wait for publication and report changed
  paths; treat a held tree as a stop.
- [ ] From outside the checkout, have both agents do a research task over two placed trees
  and one edit, wait for publication and report the changed locator; revise the skill.

### Inviting and joining follow-ups

Left from the 2026-10-11 invitation work ([status](../status.md#cli-package-people-and-joining-by-invitation--2026-10-11)).

- [ ] Go through the Mac getting-started list by hand after a join: photo, Sync a Folder,
  a new folder in Documents, opening a shared tree. The host side is checked (a folder
  becomes a tree under a just-claimed account); the screen itself has only been compiled.
- [ ] Try **Install Command Line Tool…** from the released Mac app: the link at
  `/usr/local/bin/story`, the administrator prompt when that folder needs one, and `story
  --help` in a new Terminal window. The bundled command runs through a link; the menu item
  and the prompt have not been tried.

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

## Manual recipes

**Editor recovery.** Rebuild the app and use a disposable page: edit offline, reconnect
without Sync Now, and verify host and peer convergence. Quit while offline with unpublished
edits and verify the reopened page shows them from the change log, then that they publish.
Preserve real user text before testing process interruption.

**Automatic publication.** If publication stalls, capture the machine phase and the actual
preparation error before any manual retry; the two historical stalls were a no-work pass
that left `preparing: true` with no task, and a preparation failure raised outside the
submission error handler. A fix never clears a pending request, rewrites its digest,
discards a saved head or alters protocol semantics.

**Resource policy soak.** Exercise Story consent and revocation and configuration
conflict resolution on the isolated production copy, including queued configuration writes.
The schema 13 migration backups were deleted on 2026-10-26, so take a fresh backup of the
live host before the soak. Required before enabling a
real application ([Apps 005](later/apps-005-source-resolution-and-sidecar.md)).
