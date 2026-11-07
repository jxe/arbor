# Clients 003: the launch preview as the session, and choosing the way from facts

**Why:** Joe wants it to be easy to build an app like Story on any platform, with three
ways for an app to hold a tree (alongside Story Sync, as a replica, page by page) sharing one
engine (Joe, 2026-11-06). The library, the three ways and the lazy node index are built
([status](../../status.md#clients-003-one-client-library-three-ways-to-hold-a-tree--2026-11-07)).
Two pieces of the design are left.

> **Executor instructions**: Swift changes need Joe's Mac to build (an RC session in a
> separate worktree; app builds are slow, so batch them). Don't push to main without Joe's
> go-ahead: the branch also carries overstoryd routes, and pushing main redeploys the host.

## Status

- **Effort**: S
- **Risk**: LOW-MEDIUM. Launch speed on the Mac.
- **Comes after**: Joe's launch timings with the lazy session ([joe.md](../joe.md#clients-003)).

## Steps

1. **The launch preview becomes the session.** At launch the Mac still scans the placed
   folder into a read-only tree (`LocalFolderPreview`, in
   `restoreLocalWorkspaceIfAvailable`) before Story Sync answers. An Alongside session now
   opens from the descriptor, the root directory and its bodies (read from the folder when
   they match). If Joe's timings show that `tree-open` lands about as soon as
   `launch-preview` does, drop the preview and open the session read-only until the
   coordinator confirms a basis; remove `LocalFolderPreview` and
   `WorkingTree.initializeFromPreview`. If not, keep the preview and say why in status.
2. **Choose the way from facts.** A small policy picks Browse, Replica or Alongside Story
   Sync from whether the tree is placed here with Story Sync running, free disk, tree size
   and whether the caller can write, with a per-tree override. Today `StoryAppModel`
   picks by call site.

## STOP conditions

- Mac launch to first drawn page gets slower than before Clients 003 step 2 and the cause
  isn't clear.
