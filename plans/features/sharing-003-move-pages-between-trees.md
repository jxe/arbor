# Sharing 003: move a page to another tree from the share sheet

**Timing:** Later. (Joe has not given a date. Move this line when he does.)

**Why and when:** on 2026-11-01 Joe wanted a public "Shared" tree and a way to move pages from his todos tree into it while keeping them linked from todos. His usual audiences are public, private and work (MAI, a group-owned tree), but trees are their own thing and don't map one-to-one onto audiences. He wants moving and sharing combined in the share sheet: the sheet names the tree a page is in and who has access to that tree, and picking another tree moves the page there. Mockup Joe approved: [Story share sheet sketch](https://claude.ai/artifact/2Mcuwup5SH9RHbCKZ7XTDV) (version 5).

## Status

- **Effort**: M to L
- **Risk**: MEDIUM. A move publishes a page to a new audience, which can't be taken back once someone has read it. The sheet shows the destination's access before anything moves.
- **Depends on**: nothing. People 001 phase 3 (the people picker in the share sheet) is separate and can land before or after.
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

## Open questions for Joe

- **Links to private pages.** When a moved page links to pages people in the destination can't open, should Story leave the links (readers see the title only), offer to move those pages too, or ask each time?
- **Where the moved page goes** in the destination: always the top level, or a folder you pick in the same menu?
- **One-off shares** with a single person: is "New Tree…" enough? (Joe: "something to think about".)
- **The MAI tree:** on the MAI host as a placement, or on Joe's host with the MAI group as administrator?

## Steps

1. **Share sheet layout.** The Tree section and the "Who has access to <tree>" heading on the current sheet, with no move yet. Mac and iPhone.
2. **The tree menu and its preview.** List destinations as above, and load the destination's access when one is picked. Show the subpage and private-link summary.
3. **The move itself.** Steps 1 to 5 of "What a move does" as one action in Story, on placed trees. Both trees publish through their own working trees. If the destination's write fails, nothing is removed from the old tree.
4. **Undo.** Undo moves the pages back and restores the old links, as long as nothing else changed them.
5. **New Tree…** from the menu, onto the home host or a placement.

**Proof:** on the Mac, move a todos page with one subpage and one private link into a public tree. The public URL shows the page, todos shows a link block in the old spot that opens it, other todos pages' links still open it, and the iPhone shows the same after sync. Undo puts it back.
