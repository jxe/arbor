# People 001: a directory you own, and Go to…

**Why and when:** Joe asked on 2026-10-20 for People to remember the people and trees he has
come across, not only what connected hosts list. Its main jobs are finding someone and forming
groups to share with: family, different groups at work. That means knowing whether a group
already exists, whether it covers everyone needed, inviting whoever is missing, and finding a
person whose tree ID you don't know. He also wants a way back to any tree or page he has
visited without remembering its host URL or path, like Chrome's address bar. The directory is a
collection with a grouped arrangement, so this plan waits for
[Schema language 005](../soon/schema-language/005-collections-that-sync.md): collections that sync
correctly, offline on every device. Joe, 2026-10-22: that foundation is what has to come first;
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
- **Gated on:** [Schema language 005](../soon/schema-language/005-collections-that-sync.md)
  milestones 1 to 5 (the logical form, layered USL, logical collections, row operations with
  field merge, and collections that sync natively on Mac and iPhone, offline), on main. Not
  milestone 6 (rows on the host).
- **Not gated on:** [Schema language 002](schema-language-002-cranberries-in-story.md)'s
  presented views and structured editor. People's screens are Story's own SwiftUI over the
  directory's rows, as `StoryDirectoryView` is today; if 002's editor lands first, the People
  arrangement can move onto it.
- **Relates to:** [Links 001](../soon/links-001-tree-id-links.md), whose lookup searches visited
  trees. Phase 3 here replaces the store that plan extends.

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
Contact.sightings[] &fold <-> Sighting.contact

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
  remove it. Links 001's lookup step 3 reads this collection instead.
- A Go to… field (⌘L on Mac, the search in the tree picker on iPhone) matches pages and trees by
  title and headings, folder path, people (owner, sharer, last editor), icon, the link text
  followed or the group shared through, and earlier queries. Ranking favors frequent and recent
  visits, and a query used before ranks its pick first. Return opens the page, ⌘Return the
  tree's root. A pasted link or `tr_…` goes through Links 001's lookup.
- A contact's page lists their trees from this collection.
- **Proof:** with the Mac offline, typing a remembered page title finds a page in a tree visited
  last week on another host.

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
