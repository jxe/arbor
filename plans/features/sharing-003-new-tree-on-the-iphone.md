# Sharing 003: New Tree… on the iPhone

**Timing:** Now. What's left of moving pages between trees from the share sheet, which is
built on the Mac and the iPhone ([status](../../status.md#move-a-page-to-another-tree--2026-11-01)).
The Mac's share sheet offers New Tree… at the end of its tree menu; the iPhone's doesn't yet.

**Why and when:** on 2026-11-01 Joe wanted a public "Shared" tree and a way to move pages from
his todos tree into it while keeping them linked from todos, with moving and sharing combined
in the share sheet. New Tree… is how a page gets a new audience, including one person. Mockup
Joe approved: [Story share sheet sketch](https://claude.ai/artifact/2Mcuwup5SH9RHbCKZ7XTDV)
(version 5).

## Status

- **Effort**: S to M
- **Risk**: LOW. A new tree is empty until a page moves into it, and the move's preview already
  shows the destination's access.
- **Depends on**: nothing.

## New Tree… on the iPhone

Declaring a tree needs the profile key or an administrator device
(`TreeConfigurationClient.declareAndMount`); a paired iPhone without the key can't
(`StoryRootView.swift` says New Tree… is Mac-only for now). Show New Tree… only where the
iPhone is an administrator, and place the new tree on the iPhone only (no folder). Then the
sheet previews moving the page into it, as on the Mac.

**Proof:** on an administrator iPhone, New Tree… with "Everyone can view", move a page into it,
and the tree's public URL shows the page; the Mac sees the new tree after sync.

## Open questions for Joe

- **One-off shares** with a single person: is New Tree… enough? (Joe: "something to think about".)
- **The MAI tree:** on the MAI host as a placement, or on Joe's host with the MAI group as
  administrator?
- **Undo:** the old pages go to the old tree's Trash, but Undo doesn't bring them back. Worth
  building, or is Trash enough?
