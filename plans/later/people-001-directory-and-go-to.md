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
> hands-on check. Forks 1–3 are settled (Joe, 2026-10-25); settle fork 4 before phase 3. Go to…
> (a side slice, any time) needs only fork 5.

## Status

- **Effort:** L, in phases.
- **Risk:** MEDIUM. It's the first collection Story keeps for itself, and group edits write
  to group profile trees on hosts.
- **State:** phase 1 built (2026-10-25, through 6ebe9ea): the directory tree, kept by code, shown with
  USL views, and found from the Mac's tree picker. Joe: "this will do for now". See "As built" below.
- **Order** (Joe, 2026-10-24): the directory tree comes first, because it is People's point;
  Go to… and tree-ID links are a side slice for any time.
- **Gated on:** phase 1 on part 1 of [Schema language 007](../soon/schema-language-007-edit-rows-in-story.md),
  its backend (Story writes rows from code on Mac and iPhone; part of [Schema language 002](schema-language-002-cranberries-in-story.md)'s
  milestone 3a), not on editing in the view (Joe, 2026-10-25): in phase 1 the directory is kept
  by code and shown with Schema language 006's read-only view ([status](../../status.md#collections-in-story-on-the-mac--2026-10-25)). Phase 2 on 002's milestones 3, 4 and 7. The Go to…
  slice on nothing. Schema language 005 ([status](../../status.md#collections-that-sync--2026-10-24))
  is on main.
- **Built on 002** (Joe, 2026-10-24): People is the directory's collection shown with 002's
  database views, and the directory is 002's first customer. Only Go to… and the share sheet
  are hand-built.
- **Includes Links 001** (following a link that names a tree by its ID), folded in on
  2026-10-24 (the Go to… slice and phase 4): once the directory records trees and where they were found, finding a tree
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
  people with no tree ID yet (a name, and an email or phone). A row's key is what a
  `contact:<key>` `Person` value names ([spec 11 §3](../../docs/overstory-spec/11-schema-language.md#3-models-and-fields)): any collection can list a placeholder as
  an author or owner before they join, and Story shows it by this row's `name`. Each row carries your notes, its
  *sightings* (how you met: invited you, you invited them, shares with you, in a group together,
  opened their profile), and the last card seen (name, avatar, handle, host).
- **Trees**: one row per tree you placed, opened, or were shared, or one linked from a page
  you followed. Each row holds the owner (a `Person`), last-known title and host, the pages
  visited with their titles, headings, folder path and icon, visit times, and the queries you
  picked it with.

A sketch, written before the 2026-10-24 syntax (rewrite it in the layered form in phase 1);
field names are placeholders:

```
model Contact {            // keyed by the key `contact:<key>` values name
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
  visits  Number           // derived or per device: see phase 1
  last    Date
}
```

**Group membership is not copied.** Groups stay group profile trees on hosts, because
sharing needs them there. The People arrangement groups contacts by the groups they are in,
read from those trees; moving a row under a heading edits that group tree's `members`, through
002 milestone 7's groups that are other trees.

**What arrives on its own.** A contact row is added when there is a real tie: an invite either
way, a share either way, a group in common, or opening their profile or tree. A link that only
appears in a page you read doesn't count until you follow it. Host communities stay live,
collapsed sections and are not copied.

## Phase 1: the directory tree, kept by code (after Schema language 007 part 1)

- Create the private directory tree on first launch, named from the config tree (fork 1), with
  its `schema.usl` (People and Trees).
- Record sightings where they happen today: invitation claims, placements, shares, group edits,
  profile opens. Record visits in the Trees collection on Mac and iPhone; import `Visits.json`
  and the current `Directory.json` rows once, then remove `Visits.json`.
- Story keeps the directory from code (007's `appendRows`: derived row changes, queued while
  offline, sent through the host on every device) and shows it with 006's read-only
  collection view, grouped by group; a contact's row lists their trees. Editing it by hand
  comes with 007 part 2, and forming groups in phase 2.
- **No same-field races.** Both devices write directory rows with nobody at the keyboard, and
  two of them setting the same field of one row makes a decision
  ([spec 10 §7.1](../../docs/overstory-spec/10-source-intent.md#71-collection-rows)) nobody
  can answer in a read-only view. So a sighting or a visit is a new row with a fresh id, not an
  edit to a shared one; counts and last-seen times (`visits`, `last`) are derived when
  presented or kept per device, never one field both devices bump.
- **Placeholders by name.** The People rows without a profile feed `PresentOptions.people`
  as `contact:<key>` ids, so every collection's placeholder chips and groups (already drawn as
  not-yet-a-person, showing the key) show the contact's `name`. When a contact gets a profile
  (an invite claimed, a profile linked by hand), rewrite that contact's `contact:<key>` values
  to the profile id in the collections Story can write, as row operations, the same way group
  membership follows them.
- **Proof:** a person met only through an invite is still in the directory after their host
  stops listing them; a tree visited on the iPhone shows in the directory on the Mac; a games
  author entered as a placeholder shows by name, and by their profile once they join.

**As built (2026-10-25).** The tree is `/~handle/directory`, mounted in the profile's
`mounts.yaml`, administered by the profile alone, and activated with a seed snapshot that
`tools/directory-seed.ts` makes from `tools/directory-seed/` into
`PersonalDirectorySeed.swift` (Story doesn't encode tables; a test checks it is current).
The seed has a `_version` (5). Until the directory has migrations, `PersonalDirectoryKeeper`
replaces a directory made from an older seed with the current one, which empties it: ties,
your own trees and placed trees come back on the next refresh, past visits don't. So a change
to either schema, even to views alone, costs Joe his visits; batch them.

Every row is a fact, keyed so two devices recording it make one row:

- People: `Tie {person, group?, kind}` keyed `kind-person-group` (Community, Group, Shared,
  SharedWithYou, Invited, InvitedYou, Opened), with the card as seen then; `Contact` (by hand,
  later). Ties come from the host directory refresh (a group you're in together, a person in
  your sharing rules, a community for people with another tie) and profile opens; you are
  listed in your own groups.
- Trees: `Tree {title, path, host, owner, parent, kind}` keyed by TreeID, with kind (Profile,
  Group, Community, Settings, Tree) and owner read from the canonical path; `Visit {tree, …}`
  with a fresh id per page opened (at most one an hour per page and device; pages opened
  before the keeper is ready are recorded once it is); `Placement {tree, device}` per device.
  Your profile, configuration and the groups you run (`writableProfiles`) and every tree
  placed on the device get `Tree` rows on each refresh.

Views use the USL additions of 2026-10-25 (spec 11 §8: `rows:`, `re Person`, paths,
`~latest`/`~earliest`/`~count`/`~ago`): People by group, Everyone and Recent with
`rows: person`; Trees Recent (`visits.at ~latest ~ago`), By kind and By owner.

Finding it: on the Mac the sidebar toolbar is the tree picker (Recent, then Special: You,
Account Settings, groups you run; then People & Trees… ⇧⌘D; then Open Tree…), with search
below; the People footer and sheet are gone. Not yet: invitation claims, shares made elsewhere
than a refresh shows, rewriting `contact:` values, a migration path, and the Go to… typeahead.

## Phase 2: People as a database view (after 002 milestones 3, 4 and 7)

People is the directory's People collection presented and edited with Schema language 002's
views and structured editor, not hand-built screens (Joe, 2026-10-24). What the directory asks
of those milestones is listed in each of them.

- The arrangement lives in the directory's schema as `~views`: By group, Recent, By host, with
  You first. Group headings are group profile trees (002 milestone 7's groups that are other
  trees); host communities are read-only groups the host supplies, collapsed.
- Forming groups is the editor's own drag: under a heading to add, out to move, Option-drag
  (Mac) to copy, a row action to remove; "+" after the headings and "Group these…" for a
  selection. Locked headings for groups you can't edit; unsynced changes dimmed.
- Placeholder contacts are rows without a profile. Each group a placeholder is in reserves an
  `invite:` member; the row's actions are Copy invite link and Send invite…, and a status cell
  shows not invited, invited, or joined. Accepting turns the placeholder into the profile and
  keeps groups, shares and notes (fork 4).
- Retire `StoryDirectoryView`'s hand-built sections and the Members sheet for groups; keep the
  sheet for host communities.
- **Proof:** make a group by dragging three people on the Mac; it shows on the iPhone and the
  host's group tree lists them.

## Phase 3: the share sheet (hand-built)

- The share sheet takes people and groups in one field and compares the picks with your groups:
  an exact match suggests the group, a near match offers to add the missing person to it, and
  three or more unmatched people offer "Make a group of these…". The same picker serves New
  Group and `Person` fields in collections (002's chip picker uses it).
- Search widens past your contacts: host communities, then members of groups shared with you,
  then an exact `~handle@host` or `tr_…`, then "Add as a placeholder and invite".
- **Proof:** share with a placeholder and accept the link from another account.

## Side slice: Go to… and tree-ID links on the Mac

Any time, before or after the phases: it needs nothing from Schema language 002. It reads the
directory's Trees collection when phase 1 has made it, else what the Mac already records.

- **Visits remember pages.** `VisitedTreeRecord` (`StoryVisits.swift`) gains the pages visited
  in each tree with their titles, headings, folder path and icon, and the visit count and time;
  placed trees are searched from Story Sync's tree list. Visits on placed trees are recorded
  too.
- **Go to…**: a field (shortcut a fork; ⌘L is Copy Link and ⇧⌘L Open Location today) that
  matches pages and trees by title, headings and folder path, ranks frequent and recent visits
  first and puts a query's earlier pick first. Return opens the page, ⌘Return the tree's root.
  A pasted link or `tr_…` goes through the lookup below.
- **Links by tree ID,** the spec and the Mac's handling of links in documents (below, "Links
  that name a tree by its ID", first step), with the Trees collection (or, before phase 1, `Visits.json`) as lookup step 3.
- **Proof:** with the Mac offline, typing a remembered page title finds a page in a tree visited
  last week on another host; a raw `overstory://tr_…` link in a page to a tree on
  `arb.nxhx.org` that is neither placed nor visited opens at the linked page.

## Links that name a tree by its ID

Story writes `overstory://tr_…/path` for every link to another tree, but can follow one only
when the tree is placed, was visited this session, or is found on a connected account's host;
opens from outside the app ignore it. Joe wants these links honored wherever the device can
find the tree. The Go to… slice builds the lookup on the Mac from the Trees collection (or
`Visits.json` before phase 1); phase 4 adds opens from outside the app, the iPhone and the CLI.

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
3. **the directory's Trees collection** (`Visits.json` before phase 1), whose row gives the
   host the tree was found on; a stale row falls through to asking that host by ID;
4. the host of the document that holds the link;
5. each host where the device has an account, home host first;
6. not found: an error naming the hosts asked.

Steps 4 and 5 call `ProtocolClient.descriptor(tree:)` (`GET /.overstory/trees/{TreeID}`), and
a hit is **recorded** (in the Trees collection, or `Visits.json` before phase 1), so the next lookup stops at step 3. Asking a
host needs proof of activation in the types: `locateTree` takes an `Activation`
(`.documentLink`, `.typedLocation`, `.confirmedOpen`, each made only by its own UI path), and
returns a `TreeLocation` (`.open`, `.placed(path)`, `.known(row)`, `.host(origin,
descriptor)`). `openRemoteLocator` splits into resolving a path to a descriptor and
`openRemoteTree(origin:descriptor:path:)`, which also fixes the lost path.

**Steps:**

- **Spec and links in documents (Mac), in the Go to… slice.** Locators §4: replace "using a verified
  endpoint hint or already-known server record" with the rule (no host named; the fixed order; ask only on
  activation; accept only a matching descriptor; fail naming the hosts asked) and define the
  hint as the host form. §1: one sentence on what each `overstory://` form carries. §5: no
  route finds a host from a TreeID. 02-directory-format: when to write each link form.
  `design.md`: following a link to another tree. Code: `locateTree` with its tests against
  stub hosts (each step's hit, a wrong TreeID discarded, a stale row falling through, two
  hosts holding the tree, no activation means no requests), and `OverstoryRemoteLocator`
  refusing a `tr_` authority. `swift/scripts/test-story-app.sh`, `bun run check:links`.

## Phase 4: links from outside the app, the iPhone and the command line

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

1. **Where the directory lives.** *Settled (Joe, 2026-10-25): its own tree.* Its own private
   tree that the config tree names. The config tree is governed by `tree-config-v1` (spec 04 §7), whose closed set of
   files the server validates, so collections inside it would mean changing that policy. A
   separate tree could later be shared as a household address book.
2. **Privacy.** *Settled (Joe, 2026-10-25): yes, they sync.* Visits and sightings sync through
   the home host, which can then see them.
3. **Groups you can't edit.** *Settled (Joe, 2026-10-25): show them, as locked headings.*
4. **Placeholder invites.** One link that covers every group a placeholder is in, or one per
   group.
5. **Go to… metadata.** Pages are in. Anything else beyond the list in the Go to… slice, such as front
   matter tags or type?

## Not in scope

- Full-text search of page bodies.
- Sharing the directory itself.
- People from hosts the device has no account on, beyond exact lookups.
