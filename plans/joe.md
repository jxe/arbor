# Joe's to-do

Things only Joe can do: hand checks on his Mac and iPhone, releases and publishing, go-aheads
for live data, and soaks that need his devices or his daily use. Plans don't carry these.
When a plan's remaining work is only items like these, they move here and the plan is
deleted (see [plans](README.md#when-work-is-done)). Each item names where it came from and
what finishes it.

When Joe reports an item done (or a session watches him do it), record its date and evidence
in [status](../status.md) and delete it here. Joe may also drop an item; say so in status
when it was a gate for something.

## Hand checks

### Clients 003

On main since fa661f3, 2026-11-07
([status](../status.md#clients-003-one-client-library-three-ways-to-hold-a-tree--2026-11-07)).

- [ ] Launch timings on the Mac with the branch's Story: `tree-open`, `launch-preview` and
  `editor-drawn` in `~/Library/Application Support/Story/Logs/network-<date>.jsonl`, against
  main's. The placed tree must not open slower. The numbers decide
  [Clients 003](soon/clients-003-launch-preview-and-choosing-the-way.md) step 1.
- [ ] First launch: allow the Keychain prompt for Story Sync's device key once; Story then
  opens sessions itself.
- [ ] Open pages in folders you haven't opened yet, edit one while Story Sync is behind, and
  check a folder file edited outside Story never shows as the accepted page.
- [ ] Visit a large tree: the first page opens without a snapshot download (network log
  shows a path read).
- [ ] iPhone: a placed tree and the personal directory open and sync as before.

### Coalesced typing (Merge 002)

Built 2026-11-07 on branch `claude/merge-002` ([status](../status.md#coalesced-typing-bursts-merge-002-case-1--2026-11-07)).
The Swift publication tests pass on the Mac; Story itself has not been rebuilt with it.

- [ ] Go-ahead to merge the branch to main (it changes what Story and Story Sync send, not the host).
- [ ] After merging and rebuilding Story: type a sentence, backspace a word and Option-arrow a block
  on a long page, then check the request in the network log is one update with one or a few frames,
  and that a second device shows the same text.

### Inviting and joining

Left from the 2026-10-11 invitation work ([status](../status.md#cli-package-people-and-joining-by-invitation--2026-10-11)).

- [ ] Go through the Mac getting-started list by hand after a join: photo, Sync a Folder,
  a new folder in Documents, opening a shared tree. The host side is checked (a folder
  becomes a tree under a just-claimed account); the screen itself has only been compiled.
- [ ] Try **Install Command Line Tool…** from the released Mac app: the link at
  `/usr/local/bin/story`, the administrator prompt when that folder needs one, and `story
  --help` in a new Terminal window. The bundled command runs through a link; the menu item
  and the prompt have not been tried.

### Agents 001

Left from Agents 001 ([status](../status.md#agents-001-presence-and-agent-tasks--2026-11-01)).

- [ ] A real task on a day plan, started with Run on the Mac and watched from the iPhone: the
  agent's mark and bubble move as it reads and edits, the task ends checked off with its
  result, and Undo Run takes the change back.
- [ ] The iPhone leaves the roster within a second of going to the background and rejoins on
  return; a Mac on the same page sees both.
- [ ] Run the app-hosted Story tests for presence and agent runs with Story quit.

### Read-only placements and domain names

Built 2026-11-05 and deployed ([visitor sessions](../status.md#visitor-sessions-and-read-only-placements--2026-11-05),
[domain locators](../status.md#domain-locators-your-own-domain-names-your-profile--2026-11-05)).

- [ ] **Read-only placement on the Mac:** `story place --read-only <url of a tree shared with
  you on another host> <folder>`, then check that the owner's edits arrive and your edits in
  that folder are not sent.
- [ ] **Your domain names your profile:** `story me domain <one of your domains>`, publish the
  TXT record it prints, let Story Sync publish the profile, then `story me domain --check`.

### Sharing 003: moving pages between trees

Built on the Mac and iPhone ([status](../status.md#move-a-page-to-another-tree--2026-11-01)).

- [ ] **Mac:** move a disposable page with one subpage and one link to a private page into a
  writable tree. The new tree shows the pages, the old parent has a link that opens them,
  another page's link to them still opens, the iPhone shows both trees after sync, and the
  old pages are in Trash. Then New Tree… with "Everyone can view", and its public URL shows a
  page moved there.
- [ ] **iPhone:** move a page into a tree the iPhone has placed; the Mac shows it in the new
  tree after sync, with the link in the old parent.

### Filesystem 026: pages as logical nodes

Released in Story 0.1.6; Joe's todos tree converted 2026-11-01
([status](../status.md#pages-as-logical-nodes-built--2026-10-28)).

- [ ] **Todos tree as pages:** edit front matter on a todos page on the Mac and the iPhone (add
  and change a property, edit the body), and check both see it and nothing conflicts.

### Keep current contents

Built 2026-11-01 ([status](../status.md#merge-as-blocks-and-elements--2026-11-01)).

- [ ] On the next real conflict on a page, try **Keep current contents**: it lists only the
  lines a version holds that the page lacks, and keeping them clears the choice.

### Sharing 002 and 004: invitations and old hosts

Built 2026-11-07 ([status](../status.md#invite-from-the-command-line-and-hosts-older-than-story--2026-11-07)).

- [ ] **Invite from the terminal:** `story invite https://arb.nxhx.org/~<throwaway>`, see it
  pending in the Mac People sheet, `story invite cancel` it, see it gone. Once more from
  `bunx @ovst/cli` instead of the app's bundled command, and note whether macOS asks before a
  different binary reads the device key.
- [ ] **Too-old host:** the next time `minimumHostProtocol` is raised, open Story with a tree
  placed from a host still on the older image and check the "Story can't start" alert (Mac)
  and screen (iPhone).
- [ ] **Story's tests for both** (they need Story quit): `xcodebuild test -workspace
  swift/Story.local.xcworkspace -scheme Story -destination platform=macOS -only-testing:StoryAppTests/StoryAppTests/hostProtocolLevels -only-testing:StoryAppTests/StoryAppTests/invitationVectors`.

### Names 001: your own domain

Built 2026-11-07 ([status](../status.md#trees-at-your-own-domain--2026-11-07)).

- [ ] Pick a subdomain (say `notes.<your domain>`), run `story me domain <it>` and publish the
  CNAME it prints. On Railway, add the domain to the overstoryd service in the dashboard and
  publish the records Railway shows instead. Once `story me domain --check` says it reaches
  arb.nxhx.org: `https://<it>/` shows your profile, `arb.nxhx.org/~joe/…` in a browser
  goes there, Copy Link gives the domain form, and the People sheet shows the domain.

## Releases and publishing

- [ ] **Quagmire 0.16.0** with the next arbor release: main builds only against local
  Quagmire, because the pinned 0.15.0 lacks `EditorPeer(avatar:)`. Release it and move
  arbor's pin (found while building Clients 003, 2026-11-07).

### Sharing 004: Railway template

Built 2026-11-05 ([status](../status.md#start-your-own-community-from-a-railway-template--2026-11-05)).

- [ ] Make the `ghcr.io/jxe/overstoryd` package public after the first image publishes (a
  release tag, or running Publish host image by hand).
- [ ] Create the template in Railway's dashboard as the deploy README's "The template
  (maintainers)" says, and put its link in that README (or give it to a session to add).
- [ ] Rehearse from a fresh Railway account: deploy, find the founder link in the logs, open it
  in Story on a Mac with no identity, invite a second person, and restart the service.

## Go-aheads

Steps a session has ready but must not take without Joe's word, because they change live
data or something outside the repository.


- [ ] **Schedule the object collector.** Run the `railway ssh` collection command
  ([deployment](../packages/overstoryd/deploy/README.md#collecting-unreferenced-objects))
  daily or weekly from Joe's machine, keeping each report. Formerly overstoryd 017; the first
  live run is recorded in [status](../status.md#known-gaps). A bound on `document_versions`,
  which holds most retained bytes, is part of
  [overstoryd 007](later/history-007-page-history.md).
- [ ] **Convert the other trees to pages** once every writer (Oliver included) runs Story
  0.1.6 or later: back up the host, then set `OVERSTORYD_PAGES=1` on Railway; each owner's
  Story Sync converts their trees. Gates [Filesystem 026](soon/filesystem-026-page-provenance-and-cleanup.md)'s
  cleanup.

## Soaks

Dated evidence closes these; elapsed time alone does not.

- [ ] **Declined folder paths (Filesystem 011):** after Story Sync restarts on it, record one
  real rejection (a `LinkPreviews/` directory in the account checkout is easiest), that
  other edits still publish, `story sync declined` lists the path, and `story sync declined restore`
  removes it.
