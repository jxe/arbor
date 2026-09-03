# Interface 003: Native acceptance audit

## Status

- **Priority**: P1
- **Effort**: S–M hands-on verification
- **Risk**: LOW
- **Depends on**: the completed native implementation recorded in
  [`history/native`](../native/README.md)
- **Category**: native acceptance
- **Progress**: DONE — user-confirmed 2026-09-03

## Accepted result

The current macOS and iOS 27 Arbor artifacts passed the remaining hands-on
acceptance audit for images, title-driven rename, recovery/conflicts,
accessibility, and platform fit. This closed the former native Plan 018 without
reopening the accepted Hunch conversion or repeating already accepted voice,
link-preview, transcript-polishing, navigation, menu, and gesture work.

The historical implementation inventory and parity dispositions remain in
[`history/native/hunch-parity.md`](../native/hunch-parity.md). The detailed
artifact identifiers and observations were not added during this documentation
closeout; completion is recorded from the user's direct confirmation.

## Completed acceptance scope

### Images and assets

- [x] Paste images while editing and navigating; preserve placement and reopen behavior.
- [x] Preserve multi-image ordering and treat undo/redo as one import edit.
- [x] Exercise supported macOS and iOS paste/drag/import paths.
- [x] Preserve logical asset references through page moves, relaunch, sync, and offline use.
- [x] Prevent collision overwrite, read-only insertion, broken Markdown, leaked host paths, and stale-image display.
- [x] Keep bytes under the tree-root `Assets` policy without a standalone Import Asset command.

### Title-driven rename

- [x] Exercise acceptance, dismissal, emoji, case-only changes, and collisions on macOS and iOS.
- [x] Preserve PageID, session/navigation state, backlinks, and provider-authored filenames.
- [x] Preserve inbound PageID links and converge through ordinary synchronization.

### Recovery and conflict presentation

- [x] Restore trashed pages and local revisions as new work without rewinding authority history.
- [x] Exercise conflict choice with both sides recoverable and no filesystem-path disclosure.
- [x] Preserve accepted recovery state across relaunch.

### Accessibility and platform fit

- [x] Audit image, rename, recovery, conflict, and error states with VoiceOver on macOS and iOS 27.
- [x] Check reduced motion, keyboard/touch navigation, scrolling, focus, and actionable labels.
- [x] Recheck links, Back, Move To, offline reconnect, and non-document node behavior.

## Historical boundary

- Exact newly built Arbor artifacts, rather than stale installed copies, were
  the intended acceptance boundary.
- Destructive checks used disposable or designated Arbor test content.
- The former Hunch workspace and conversion remained out of scope.
- Implementation evidence remains in [`../native`](../native/README.md); this
  file records closure of the final manual acceptance gate.
