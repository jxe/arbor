# Small work and verification

Tasks too small for a plan of their own, and the install, deploy, hand-check and soak
gates left by finished work. Nothing here authorizes installing, restarting Joe's apps,
changing live data or deleting backups. When an item is done, record its revision, date
and evidence in [status](../status.md) and delete it here.

## Small work

### Show declined folders in the Mac app

Formerly Native 012. Story Sync keeps a folder's declined paths unpublished while the rest
syncs and serves `GET /v1/declined`, `POST /v1/declined/restore` and
`POST /v1/declined/resend` ([API](../docs/implementing-sync-services/story-sync-api.md#4-identity-account-bootstrap-and-declined-changes),
[declined folder changes](../docs/implementing-editors/declined-folder-changes.md));
`story sync declined` is the reference client. The Mac app reads none of it.

- [ ] Decode `declined` on daemon trees (`LocalStorySyncTreePresentation`) and list each
  placed folder that has it in Sync Status: name, path, declined paths, the host's reason,
  and the guide's sentence (kept in the folder, not published; the rest keeps syncing;
  making them match the host releases them).
- [ ] Add `restoreDeclined(tree:)` and `resendDeclined(tree:)` beside `discardHeld`; offer
  "Restore Host Version…" (confirmation names the paths and says edits there are lost) and
  "Send Again"; refresh after either.
- [ ] Keep `sync: "conflict"` with the existing discard. Reword
  `editProfileConfigurationFile`'s check, which names a review that no longer exists, to use
  `declined` and point at Sync Status. Keep `conflicted: true` (accepted alternatives)
  visually distinct.
- [ ] Verify with a `StoryAppTests` case on the bundled daemon (make a declined change as
  `tests/integration/self-sync.test.ts` does, see it listed, restore it), then by hand on
  Joe's Mac with his go-ahead.

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

- [ ] Show pending invitations in the People list itself, not only in the host's member sheet.
- [ ] Go through the Mac getting-started list by hand after a join: photo, Sync a Folder,
  a new folder in Documents, opening a shared tree. The host side is checked (a folder
  becomes a tree under a just-claimed account); the screen itself has only been compiled.
- [ ] Try **Install Command Line Tool…** from the released Mac app: the link at
  `/usr/local/bin/story`, the administrator prompt when that folder needs one, and `story
  --help` in a new Terminal window. The bundled command runs through a link; the menu item
  and the prompt have not been tried.
- Editing a group's members without opening its page needs a second writable working tree
  on the device; it is a design question, not small work.

### Schedule the object collector

Formerly overstoryd 017; the first live run is recorded in
[status](../status.md#known-gaps). A bound on `document_versions`, which holds most retained
bytes, is part of [overstoryd 007](later/history-007-document-history-routes-and-restore.md).

- [ ] Schedule the `railway ssh` collection command
  ([deployment](../packages/overstoryd/deploy/README.md#collecting-unreferenced-objects))
  daily or weekly from Joe's machine, keeping each report. Joe's go-ahead.

### Smaller candidates

- **`story untrack`.** Ignore rules never untrack an already-published path; today the
  recipe is move out, sync the deletion, move back. One command could publish the deletion
  and leave the bytes. The bytes stay in accepted history, so a leaked secret still needs
  rotating.
- **Ignored paths in the Mac app's publish view.** Mark which paths the ignore rules keep
  out and which ignored paths are still tracked.
- **Sidebar creations as `addEntry`.** The sidebar's `createMarkdown`/`createDirectory`
  still publish snapshots; emit `addEntry` from `retainStructure` for them too.

### Story Sync and trees it hasn't placed

- [ ] Story Sync answers 404 for objects of a tree it hasn't placed, so the Mac opens the
  People directory with `HostObjectStore` instead of the window's usual store
  (`openPersonalDirectory`). Serve such objects from the host, or say why not.

## Native release and hands-on review

- [ ] Install the tested rejected-update retirement, broader operation capture and
  accepted-choice review when Joe can quit both apps. Verify the exact revision and
  destination server support first. Quagmire 0.9.0 is pinned.
- [ ] Verify opening existing state, automatic publication, cross-device propagation and
  restart without losing drafts, pending requests or newer editor work. Do not overwrite
  active source journals with an older snapshot-only build.
- [ ] macOS/iPhone hands-on: layout, typing, focus, selection, scrolling, keyboard routing,
  VoiceOver, large text and installed review-draft recovery.

## Native 011 hand checks

The client folds, route removals and shared account service
([status](../status.md#native-011-account-service--2026-09-25)) build and pass their suites
on a Mac; these have not been tried by hand.

- [ ] Run `swift/scripts/hosted-smoke.ts`.
- [ ] From the Mac app against a disposable host, create a pairing offer and pair a second
  device with it.
- [ ] Mac onboarding through `StorySyncAccountService` against a disposable data home and
  host: create an identity, back it up, recover it, adopt a legacy keychain identity, claim
  an account, cancel and resume a claim, pair from another device's code and resume an
  interrupted pairing, choose a tree; the account panel's actions likewise. Check
  `GET /v1/accounts` shows the identity, account and credential in the data home, not the
  keychain.
- [ ] iPhone through `KeychainAccountService`: pair from the Mac's QR code, list accounts,
  Place a Tree and Sync & Accounts panels, a People profile and avatar, Disconnect and Pair
  Again; no keychain entry moves.

## Overstory identifier rename hand check

The 2026-09-24 rename ([status](../status.md#overstory-identifiers-and-ui-copy--2026-09-24))
builds and passes its suites on a Mac.

- [ ] Install the Mac app and check the renamed copy: Make This an Overstory Tree, Story is
  up to date, and the camera, microphone and speech permission prompts.

## Ignore policy restart check

Filesystem 005 ([status](../status.md#ignored-filesystem-content-filesystem-005--2026-09-25))
passes its Swift tests on a Mac.

- [ ] Restart the installed Story Sync on this build and confirm each placed folder returns
  to idle without publishing a change.

## Server refinements

Owner: [overstoryd 014](when-needed/merge-014-merge-handles-many-cases.md). Everything here is on main
and so deployed (the host builds from main; Joe pushed on 2026-10-11): independent
source-range inspection, the Markdown transfer and list-insertion refinements, the transfer
extensions (list items, table rows and contextual links; same-anchor ordering; keyed
JSON/YAML members; TS/JS function moves) and the fast-path acceptance of basis moves. The
server step for block moves and Move to Document is therefore done, and a Native build that
publishes them may be installed. None of it has been tried by hand.

- [ ] Verify by hand in both arrival orders on disposable trees: a list item moved
  between lists beside an edit to another item; a table row copied beside a cell edit; a
  paragraph with a relative link moved within one directory (merges) and into another
  (reviews); a paragraph moved to where another device appended one; a JSON member moved
  beside an edit to its value; a TS function moved beside a literal edit to it. Record each
  result and that the replayed history check still passes.
- No client emits a new transfer form before its server step is on main and recorded in
  status.

## Placement hosts

What remains of Security 007 ([status](../status.md#trees-on-other-hosts--2026-09-28)).
A live second overstoryd is Joe's decision.

- [ ] Once a live placement host exists, try by hand the iPhone opening a tree there
  (Place a Tree lists the account's other hosts). The iPhone pairs only with an HTTPS host.
- Making a folder into a tree from the Mac app after setup, onto any host, is
  [Filesystem 024](later/filesystem-024-open-plain-folders-on-the-mac.md).

## Observation and soak closeout

Dated evidence closes these; elapsed time alone does not.

- [ ] **Native 022:** record completion of the ordinary-use working-tree soak (before
  Web 025).
- [ ] **Story Sync 001:** record the raw-byte protocol soak, including ordinary use on both
  platforms.
- [ ] **Clients 001:** ordinary use of the one update machine on Mac, iPhone and the daemon;
  record continued automatic Mac publication through edits, merges, offline work and
  reconnect without Sync Now. If a stall recurs, capture the machine phase and preparation
  error before retrying. Phone foreground refresh is expected.
- [ ] **Declined folder paths (Filesystem 011):** after Story Sync restarts on it, record one
  real rejection (a `LinkPreviews/` directory in the account checkout is easiest), that
  other edits still publish, `story sync declined` lists the path, and `story sync declined restore`
  removes it.
- [ ] **Hetzner sync lab:** run `packages/overstoryd/deploy/hcloud-sync-lab` against the
  update-machine daemon. Its runner was rewritten on 2026-09-27 and typechecks but has not
  run since.

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
Keep the schema 13 migration backups until this soak closes. Required before enabling a
real application ([Apps 005](later/apps-005-source-resolution-and-sidecar.md)).
