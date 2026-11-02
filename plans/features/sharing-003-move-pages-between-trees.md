# Sharing 003: move a page to another tree from the share sheet

**Timing:** Now. Mac built 2026-11-01 (Joe: "just build it"); the iPhone is next.

**Why and when:** on 2026-11-01 Joe wanted a public "Shared" tree and a way to move pages from his todos tree into it while keeping them linked from todos. His usual audiences are public, private and work (MAI, a group-owned tree), but trees are their own thing and don't map one-to-one onto audiences. He wants moving and sharing combined in the share sheet: the sheet names the tree a page is in and who has access to that tree, and picking another tree moves the page there. Mockup Joe approved: [Story share sheet sketch](https://claude.ai/artifact/2Mcuwup5SH9RHbCKZ7XTDV) (version 5).

## Status

- **Effort**: M to L
- **Risk**: MEDIUM. A move publishes a page to a new audience, which can't be taken back once someone has read it. The sheet shows the destination's access before anything moves.
- **Depends on**: nothing. People 001's person picker (phase 2) will serve the access section; it can land before or after.
- **Category**: product completion

## What exists

Read from source on 2026-11-01; nothing here was run.

- **The share sheet is tree-level and doesn't say so.** `StorySharePanel` in `swift/StoryApp/StoryRootView.swift` opens on a page but shows the people picker, "Who has access" and the Everyone row for the whole tree (`.tracked(access)`), or offers to make a local folder a tree (`.promotable`).
- **Links into another tree already work.** A cross-tree link uses a canonical or `overstory://<TreeID>/…` locator (spec 02 §4, spec 03 §1). Story shows it as a link block with the subtitle from `treeLinkSubtitle(tree:)` in `StoryAppModel.swift`, such as "Tree · Public · On this Mac".
- **Moves and renames inside a tree heal links.** `performWithReceipt` in `StoryAppModel.swift` collects `linkHealingSources` and calls `healLinks` after a `.rename` or `.move`. No action moves a page out of its tree.
- **Each tree has one history and one set of access rules** (spec 01, "Trees and identity"). A page that moves to another tree starts a new history there, and its earlier versions stay in the old tree.
- **The sidebar's tree picker** lists placed trees grouped by account (`SidebarTree` in `StoryRootView.swift`).

## Decisions

- **Separate trees, not public folders.** Joe's public pages go in their own tree, not in a public folder inside todos. Todos' history holds private drafts, and a folder rule would make every nearby move or rename change what's public.
- **The share sheet has two sections.**
  1. **Tree:** "This page is in [Todos ▾]". The menu names trees by their own names.
  2. **Who has access to <tree>:** today's people picker, people and Everyone rows, with a note that access covers every page in the tree.
- **Picking another tree previews the move.** The label becomes "Move this page to", the access section shows the destination tree's people, and a summary lists the subpages that move along and the links that point to pages people in the destination can't open. The button becomes "Move to <tree>". Nothing moves until it's pressed, and Cancel goes back to the current tree.
- **What a move does.**
  1. Writes the page and its subpages into the destination tree, at its top level, keeping their names (a fork below).
  2. Puts a link block to the new page where the page was in its old parent, so the old tree reads as it did.
  3. Rewrites other links in the old tree that pointed at the page or its subpages as cross-tree links, the way rename heals links today.
  4. Rewrites links inside the moved pages that point back into the old tree as cross-tree links, so they still work for Joe.
  5. Removes the pages from the old tree.
- **The tree menu** (Joe asked how its choices are decided; my proposal, not yet confirmed):
  - Trees on this device where you can add pages: your own trees, and group trees like MAI where you have write access.
  - Not read-only trees, and not your profile, account configuration or People directory trees.
  - Grouped by account like the sidebar picker, current tree first.
  - "New Tree…" at the bottom makes a tree and then shows its access in the same sheet. This also answers sharing one page with one person.
  - Trees not on this device come later; moving into them means writing through the host.

## Settled while building (2026-11-01)

- **Links to pages that stay behind** (Joe confirmed) are rewritten as `overstory://<old tree>/…` locators, so they still open for Joe. Readers of the new tree who can't read the old one see the link text but can't open it. Story doesn't move those pages, drop the links, or ask; the preview lists them.
- **The page lands at the top level** of the destination, as `<name>`, or `<name>-2` if that's taken.
- **New Tree…** (Joe asked for it) is the menu's last item: a name, the account it goes under, and who can see it (only people you add, everyone can view, everyone can edit). The tree starts empty in `~/Documents/<name>` at `<account URL>/<slug>`, and the sheet then previews moving the page into it.

## Open questions for Joe

- **One-off shares** with a single person: is New Tree… enough? (Joe: "something to think about".)
- **The MAI tree:** on the MAI host as a placement, or on Joe's host with the MAI group as administrator?
- **Undo:** the old pages go to the old tree's Trash, but Undo doesn't bring them back. Worth building, or is Trash enough?

## Mac (built)

The share sheet's Tree section, the destination preview and Move are in `StorySharePanel` (`swift/StoryApp/StoryRootView.swift`); the move is the "Moving a page to another tree" extension of `StoryWorkspaceState` (`StoryAppModel.swift`); link rewriting is `CrossTreePageMove` in StoryKit, tested in `CrossTreeMoveTests`. A move:

1. reads the page and everything beneath it through the open tree's provider,
2. writes them into the destination's placed folder (Story Sync publishes them), rewriting links that leave the moved set; nothing in the old tree changes unless every file was written,
3. retargets the old tree's links to the moved pages (backlinks plus the parent), adding a link at the end of the parent page when it didn't already link to the page,
4. trashes the old pages, and the sheet then shows the parent page, because the open page is now the Trash copy.

A page in Trash can't move, and a move is refused when the destination already holds one of its page IDs: two pages with one ID stop Story opening that tree (2026-11-02, when moving the Trash copy of an already moved page published a second copy to Shared).

**Hand check (Joe):** move a disposable page with one subpage and one link to a private page into a writable tree. The new tree shows the pages, the old parent has a link that opens them, another page's link to them still opens, the iPhone shows both trees after sync, and the old pages are in Trash. Then New Tree… with "Everyone can view", and its public URL shows a page moved there.

## iPhone

*Built on branch `claude/project-thread-eyd0mt` (2026-11-01, Joe: "build the iphone version on a branch"), steps 1–4 and 6; step 5 (New Tree… on the iPhone) not yet. Not tried on a device.*

The iPhone opens one tree at a time, from a working tree the app keeps itself (`place(tree:from:configurationTree:)`, replicas under `StorySupportDirectories.workingTrees`); there is no Story Sync and no folder to write into. Its share sheet already reads a tree's access through `NativeAccountService`. So a move on the iPhone writes through a second working tree instead of a folder:

1. **Destinations.** The iPhone's placed trees (`nativePlacements`) the account can write (`grantsWrite`), minus profiles and the People directory, grouped by account like the Mac. Trees known from the directory but not placed on the iPhone come later.
2. **A destination working tree.** Open the destination's replica the way `place` does (open it if it was placed before, else place it from a snapshot), with its own `UpdateCoordinator`, but without switching the visible provider to it. A small type owns it for the length of one move and closes it after.
3. **Write.** For each moved page, `createMarkdown` (parent folders with `createDirectory`) with the source `CrossTreePageMove.movedSource` gives; each file with `importFile`. Then publish and wait until the destination's coordinator reports the update accepted. If that fails, nothing in the open tree changes, and the destination's local changes are discarded.
4. **The old tree.** Retarget links, leave the parent link and trash the pages exactly as on the Mac. This part already only uses the provider, so it moves out of the `#if os(macOS)` block as it is.
5. **New Tree… on the iPhone.** Declaring a tree needs the profile key or an administrator device (`TreeConfigurationClient.declareAndMount`); a paired iPhone without the key can't. Show New Tree… only where the iPhone is an administrator, and place the new tree on the iPhone only (no folder).
6. **Offline.** Moving needs both hosts reachable; while offline the menu shows the trees but Move is disabled with "Connect to move pages between trees."

**Proof:** on the iPhone, move a page into a tree the iPhone has placed; the Mac shows it in the new tree after sync, with the link in the old parent.

