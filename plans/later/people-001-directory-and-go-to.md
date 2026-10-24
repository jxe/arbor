# People 001: a directory you own, Go to…, and links by tree ID

**Why and when:** Joe asked on 2026-10-20 for People to remember the people and trees he has
come across, not only what connected hosts list. Its main jobs are finding someone and forming
groups to share with: family, different groups at work. That means knowing whether a group
already exists, whether it covers everyone needed, inviting whoever is missing, and finding a
person whose tree ID you don't know. He also wants a way back to any tree or page he has
visited without remembering its host URL or path, like Chrome's address bar. The directory is a
collection with a grouped arrangement, so this plan waited for
Schema language 005: collections that sync correctly
([status](../../status.md#collections-that-sync--2026-10-24)), on main since 2026-10-24. Joe, 2026-10-22: that foundation is what has to come first;
the general database views of [Schema language 002](schema-language-002-cranberries-in-story.md)
are separate and later. The UX was worked out first in the doc
[People directory UX](https://claude.ai/code/artifact/b3c3e9a9-aeee-49f9-b973-b9bee2d256bb)
(thread "People directory memory").

> **Executor instructions**: Refresh "What happens today" against the source first; People and
> the visit store will have moved. Do the phases in order and stop after each for Joe's
> hands-on check. Settle the forks at the end with Joe before phase 1.

## Status

- **Effort:** L, in phases.
- **Risk:** MEDIUM. It's the first collection Story keeps for itself, and group edits write
  to group profile trees on hosts.
- **State:** TODO.
- **Gated on:** nothing now. It waited for Schema language 005
  ([status](../../status.md#collections-that-sync--2026-10-24)) milestones 1 to 5 (the logical form, layered USL, logical collections, row operations with
  field merge, and SQLite that syncs through Story Sync), on main. Not milestone 6 (rows on
  the host). Native offline collections are this plan's phase 0, moved here from 005 (Joe,
  2026-10-24).
- **Not gated on:** [Schema language 002](schema-language-002-cranberries-in-story.md)'s
  presented views and structured editor. People's screens are Story's own SwiftUI over the
  directory's rows, as `StoryDirectoryView` is today; if 002's editor lands first, the People
  arrangement can move onto it.
- **Includes Links 001** (following a link that names a tree by its ID), folded in as phase 4
  on 2026-10-24: once the directory records trees and where they were found, finding a tree
  by ID is a directory question. Its earlier text is in git history at `7b29f1b`
  (`plans/soon/links-001-tree-id-links.md`).

## What happens today

Written against `a664714`.

- `StoryDirectoryView` (`swift/StoryApp/StoryDirectoryView.swift`) shows You, People (the host
  community), Groups, and Others. The list is `StoryWorkspaceState.directory`, the union of each
  connected host's `/directory` answer (`buildDirectory`, `packages/overstoryd/src/directory.ts`):
  community members, groups the account can read, and profiles named in access rules on trees it
  administers.
- `DirectoryStore` (`swift/StoryApp/StoryDirectory.swift`) caches each origin's answer in
  `Directory.json` and replaces it on every refresh. Nobody met through an invite, a placement
  or a followed link is remembered unless a host still lists them.
- Groups are edited in a Members sheet; New Group is Mac only.
- Visited trees are in `VisitedTreeStore` (`Visits.json`, `swift/StoryApp/StoryVisits.swift`),
  Mac only, and nothing searches them by title.

## The design

**The directory is a private tree of collections you own.** It holds two collections:

- **People**: one row per profile you know (people and groups), plus *placeholder* rows for
  people with no tree ID yet (a name, and an email or phone). Each row carries your notes, its
  *sightings* (how you met: invited you, you invited them, shares with you, in a group together,
  opened their profile), and the last card seen (name, avatar, handle, host).
- **Trees**: one row per tree you placed, opened, or were shared, or one linked from a page
  you followed. Each row holds the owner (a `Person`), last-known title and host, the pages
  visited with their titles, headings, folder path and icon, visit times, and the queries you
  picked it with.

A sketch in layered USL (003); field names are placeholders:

```
model Contact {
  profile   Person?        // absent while a placeholder
  name      Text
  reach     Text?          // email or phone, placeholders only
  notes     Markdown?
  invited   Date?
  sightings Sighting[]
  lastCard  Text?          // JSON of the last directory card
}

model Sighting {
  kind    Text             // invited-you, you-invited, shares, group, opened
  detail  Text?
  at      Date
  contact Contact          // cross-reference
}
Contact.sightings[] @fold <-> Sighting.contact

model Visited {
  tree    Text             // TreeID
  owner   Person?
  title   Text
  host    Text?
  pages   Text[]           // titles, headings, folder paths
  queries Text[]           // what was typed when it was picked
  visits  Number
  last    Date
}
```

**Group membership is not copied.** Groups stay group profile trees on hosts, because
sharing needs them there. The People arrangement groups contacts by the groups they are in,
read from those trees; moving a row under a heading edits that group tree's `members`. People
does this itself; 002's milestone 7 ("pages that present collections kept elsewhere") would
generalize it.

**What arrives on its own.** A contact row is added when there is a real tie: an invite either
way, a share either way, a group in common, or opening their profile or tree. A link that only
appears in a page you read doesn't count until you follow it. Host communities stay live,
collapsed sections and are not copied.

## Phase 0: collections offline in Story on Mac and iPhone, if needed

Moved from Schema language 005 milestone 5 (Joe, 2026-10-24, who isn't sure Story on iOS or
Mac needs to sync collections at all: Story Sync does). Before building it, check whether the
phase 1 to 3 proofs need it, or whether People can read and write the directory through the
host when online and carry it intact offline. If it is needed:

- Story on Mac and iPhone reads and writes logical collections offline with no Story Sync in
  the path: a native projection (SQLite, which iOS has) built from the logical form, validated
  with the StoryKit USL port, and fed by a row-change kind in `UpdateCoordinator` beside
  `appendStructure` (`UpdateCoordinator+LocalChanges.swift`). 005 milestone 3 already makes
  native working trees keep a collection's tables and rows.
- It covers [Apps 010](apps-010-native-offline-collection-file-projection.md) (rows readable
  offline on native), which can then be deleted.
- **Proof:** a collection edited offline on the iPhone and on the Mac merges when both
  reconnect.

## Phase 1: the directory tree, and People reading it

- Create the private directory tree on first launch, named from the config tree (fork 1), with
  its `schema.usl`.
- Record sightings where they happen today: invitation claims, placements, shares, group edits,
  profile opens.
- Import the current `Directory.json` rows once, as contacts with a "host directory" sighting.
- `StoryDirectoryView` reads contacts plus the live host answers. Sections: You, each group as a
  heading (from group trees), each host community (collapsed), Ungrouped (newest first).
  Arrangement menu: By group, Recent, By host.
- **Proof:** a person met only through an invite still shows after their host stops listing them;
  the same contacts appear on Mac and iPhone.

## Phase 2: forming groups in place, placeholders, and the share sheet

- Drag a row under a heading to add, out to move, Option-drag (Mac) to copy; a context menu to
  remove; "+" after the headings and "Group these…" for a selection. Locked headings for groups
  you can't edit. Unsynced changes show dimmed.
- Placeholder contacts: each group a placeholder is in reserves an `invite:` member; the row
  offers Copy invite link and Send invite…, and shows not invited, invited, or joined. Accepting
  turns the placeholder into the profile and keeps groups, shares and notes (fork 4).
- The share sheet takes people and groups in one field and compares the picks with your groups:
  an exact match suggests the group, a near match offers to add the missing person to it, and
  three or more unmatched people offer "Make a group of these…". The same picker serves New
  Group and `Person` fields in collections.
- Search widens past your contacts: host communities, then members of groups shared with you,
  then an exact `~handle@host` or `tr_…`, then "Add as a placeholder and invite".
- Retire the Members sheet for groups; keep it for host communities.
- **Proof:** make a group by dragging three people on the Mac; it shows on the iPhone and the
  host's group tree lists them. Share with a placeholder and accept the link from another account.

## Phase 3: Go to…

- Record visits in the Trees collection on Mac and iPhone; import `Visits.json` once, then
  remove it. Phase 4's lookup reads this collection.
- A Go to… field (⌘L on Mac, the search in the tree picker on iPhone) matches pages and trees by
  title and headings, folder path, people (owner, sharer, last editor), icon, the link text
  followed or the group shared through, and earlier queries. Ranking favors frequent and recent
  visits, and a query used before ranks its pick first. Return opens the page, ⌘Return the
  tree's root. A pasted link or `tr_…` goes through phase 4's lookup.
- A contact's page lists their trees from this collection.
- **Proof:** with the Mac offline, typing a remembered page title finds a page in a tree visited
  last week on another host.

## Phase 4: links that name a tree by its ID

Story writes `overstory://tr_…/path` for every link to another tree, but can follow one only
when the tree is placed, was visited this session, or is found on a connected account's host;
opens from outside the app ignore it. Joe wants these links honored wherever the device can
find the tree. Phase 4 may start before phases 1 to 3, using `Visits.json` as the visit
record, and switch to the Trees collection when phase 3 lands.

**Done already** (`c0bc636`, 2026-10-20): `openNestedTree` (`StoryAppModel.swift`) asks each
connected account's host for a tree it cannot find locally (`openHostedTree`). Refresh the
rest of this section against the source before starting.

**Faults beside the gap:** `OverstoryRemoteLocator` (`StoryVisits.swift`), Story Sync's
`/v1/resolve` and `story open` read the authority of `overstory://tr_…` as a DNS name and
would request `https://tr_…`; the Mac's `onOpenURL` drops a non-invite URL until onboarding
is ready, so a link that launches the app is probably lost (read from the code, not
reproduced); `openRemoteLocator` loses the path inside a placed or writable tree.

**Decisions:**

1. **The hint is the host form.** A link meant for a reader who shares no record with its
   author is written `overstory://host/path` or `https://host/path`. The spec gains no hint
   syntax. A raw TreeID link carries identity, not location.
2. **One fixed lookup order, stopping at the first hit**, which is not the guessing locators
   §4 forbids: the same device with the same records always reaches the same place.
3. **A host is asked for a tree only by ID, only where the reader has an account or is
   already reading, and only when a person activates the link.** Rendering never asks.
4. **An open from the OS confirms before a network lookup** ("Look for this tree on
   arb.nxhx.org?"); a local hit opens at once. A click in a document needs no confirmation.
5. **A host's answer is checked:** the descriptor must carry the requested TreeID.
6. **The editor keeps writing the raw form** between trees; "Copy link" and share links stay
   in the host form.

**The lookup.** One function per client, `locateTree`, replaces the body of `openNestedTree`
and returns where the tree is; a separate step opens it:

1. open now (the current tree or an open nested tree);
2. placed on this device;
3. **the directory's Trees collection** (or `Visits.json` before phase 3), whose row gives the
   host the tree was found on; a stale row falls through to asking that host by ID;
4. the host of the document that holds the link;
5. each host where the device has an account, home host first;
6. not found: an error naming the hosts asked.

Steps 4 and 5 call `ProtocolClient.descriptor(tree:)` (`GET /.overstory/trees/{TreeID}`), and
a hit is **recorded in the Trees collection**, so the next lookup stops at step 3. Asking a
host needs proof of activation in the types: `locateTree` takes an `Activation`
(`.documentLink`, `.typedLocation`, `.confirmedOpen`, each made only by its own UI path), and
returns a `TreeLocation` (`.open`, `.placed(path)`, `.known(row)`, `.host(origin,
descriptor)`). `openRemoteLocator` splits into resolving a path to a descriptor and
`openRemoteTree(origin:descriptor:path:)`, which also fixes the lost path.

**Steps,** each stopping for Joe's hands-on check:

- **Spec and links in documents (Mac).** Locators §4: replace "using a verified endpoint hint
  or already-known server record" with the rule (no host named; the fixed order; ask only on
  activation; accept only a matching descriptor; fail naming the hosts asked) and define the
  hint as the host form. §1: one sentence on what each `overstory://` form carries. §5: no
  route finds a host from a TreeID. 02-directory-format: when to write each link form.
  `design.md`: following a link to another tree. Code: `locateTree` with its tests against
  stub hosts (each step's hit, a wrong TreeID discarded, a stale row falling through, two
  hosts holding the tree, no activation means no requests), and `OverstoryRemoteLocator`
  refusing a `tr_` authority. `swift/scripts/test-story-app.sh`, `bun run check:links`.
- **Opens from the OS (Mac).** `StoryIncomingLocator` gains `.tree(id:path:stableKey:)`;
  `onOpenURL` records a pending open consumed once a window's model exists (fixing the
  cold-launch drop for host-form links too); the confirmation sheet; Open Location accepts
  `overstory://tr_…` as `.typedLocation`. By hand: `open 'overstory://tr_…/page'` with the
  app closed and running.
- **iPhone.** `.onOpenURL` with the same pending open; `locateTree` places a `.host` result
  with `place(tree:from:configurationTree:)`, so it opens only trees on hosts where the phone
  has an account. An invitation URL is [Sharing 001](sharing-001-join-on-iphone-first.md)'s;
  whichever lands first adds the handler and the other adds its case. Open Location takes a
  locator.
- **The command line.** `/v1/resolve` and `story open` stop reading `tr_` as a DNS name and
  resolve through placed trees, then the account hosts. Remove the daemon's non-spec
  `overstory://tree/<TreeID>/…` form if nothing writes it. `docs/getting-started/cli.md`.
  Gate: `bun run test:affected`, and `bun run test:protocol` if `/v1/resolve` changes shape.

**Not here:** a route or syntax that finds a host from a TreeID alone (decision 1); Story for
the web; anonymous visits on the iPhone. If one TreeID turns out to have different roots on
two hosts, stop and bring it to Joe.

## Forks for Joe

1. **Where the directory lives.** Recommended: its own private tree that the config tree
   names. The config tree is governed by `tree-config-v1` (spec 04 §7), whose closed set of
   files the server validates, so collections inside it would mean changing that policy. A
   separate tree could later be shared as a household address book.
2. **Privacy.** Visits and sightings sync through the home host, which can then see them.
   Accept that, or keep the Trees collection on each device.
3. **Groups you can't edit.** Show them as locked headings, or only groups you're in.
4. **Placeholder invites.** One link that covers every group a placeholder is in, or one per
   group.
5. **Go to… metadata.** Pages are in. Anything else beyond the list in phase 3, such as front
   matter tags or type?

## Not in scope

- Full-text search of page bodies.
- Sharing the directory itself.
- People from hosts the device has no account on, beyond exact lookups.
