---
id: pmfd95
---
# Smaller project 005: Arbor web editor follow-up

This list starts after the logical filesystem, source-preserving BlockNote adapter, structural child rows, Hunch-derived visual system, generation-aware autosave/history coordinator, and persistent BlockNote reconciliation tranche. Difficulty is relative to the current web editor.

1. **Hunch-style nav/edit modes and contiguous block selection — Hard.** Add a true block-navigation mode alongside text editing: up/down traversal, Shift-extend, Return to edit, Escape back to block selection, and edge-of-text traversal between blocks. Ordinary blocks and document-link rows must share one visible selection model without confusing source reorder with physical filesystem moves.
2. **Keyboard structural editing and gutter actions — Hard.** Add Tab/Shift-Tab indent/outdent, Option-Up/Down reorder, selection-aware drag handles, and a compact Turn Into / Copy / Move / Delete menu. Preserve heading/toggle descendants and route child-page mutations through the filesystem transaction layer.
3. **Inline Markdown fidelity and rich marks — Hard.** Expand the source-span adapter beyond links and plain text: emphasis, strong, strike, inline code, hard breaks, nested marks, mark-preserving edits, and Cmd-B/I/E/Shift-S/K behavior in both text and block modes. Keep raw fallback for unsupported syntax and prove untouched source remains byte-identical.
4. **Markdown-aware copy/paste and image paste — Medium–Hard.** Preserve block structure and Markdown within Arbor, produce useful HTML/plain-text clipboard flavors for other apps, parse pasted Markdown, and make image paste/upload progress and failures explicit.
5. **Search and picker keyboard behavior and ranking — Medium.** Add robust focus handoff, arrow/return/escape behavior, stale-query suppression, path/title/content ranking, recent-page bias, and clear empty/error states.
6. **Mentions, page creation, and moving blocks into pages — Hard.** Add `@` page completion and create-on-select, then a recovery-safe transaction that extracts selected blocks into a new or existing page while inserting a durable child-page/link reference. Include Turn Into Page and inlining a child page back into its parent.
7. **Link healing UI, backlinks, and orphan indicators — Medium–Hard.** Surface durable-ID healing instead of making it invisible, show inbound references, distinguish stale paths from missing identities, and provide useful orphan diagnostics without forcing eager rewrites.
8. **Leading-emoji page icons and emoji completion — Medium.** Treat a leading title emoji as the page icon, retain it through rename and navigation, and add keyboard-reliable `:emoji` completion.
9. **Link previews — Medium.** Add compact previews for internal pages and safe external metadata, with cancellation, caching, offline behavior, and no editor-selection disruption.
10. **Persistent hierarchical sidebar, then sidebar drag/drop — Hard.** Replace the contextual flat listing with lazy hierarchy while preserving expansion and selection state across navigation; only then reuse the filesystem mutation API for sidebar moves. Do not fork a second mutation or selection model.
11. **Voice recording and transcript support — Very hard / later.** Add explicit recorder ownership, permissions and interruption handling, incremental transcription, optional transcript polishing, durable media placement, and recovery. This remains independent of the core editor.

## Structural and lifecycle constraints

- Specify copied-subtree identity before presenting folder/project duplication:
  copy remints PageIDs, and links between copied pages must deliberately remap
  to the new subtree or deliberately retain their original targets.
- Own structural undo above individual page editors so sidebar and body-view
  mutations share one workspace transaction history. Prefer authority-validated
  inverse metadata or an explicit receipt/transaction undo operation over UI
  closures derived from `/Trash` conventions.
- Preserve exact undo for non-contiguous document-link reorder by retaining the
  complete relevant before/after source state.
- Define bounded history retention and whether reload/crash recovery exposes
  recent local history; do not leave session-local stacks unbounded.
- Complete pointer capture, touch/pen cancellation, autoscroll, keyboard
  pickup/move/cancel, viewport clamping, and focus restoration before calling
  custom drag handles and context menus accessible.
- Use anchor-and-offset scroll restoration when content above the viewport can
  change. Exact window coordinates across animation frames are only a current
  implementation fallback.

## Smaller Hunch-like wins

- **Page-menu utilities — Small.** Add Copy Markdown, Copy Arbor path, and Reveal in Finder without introducing another action strip.
- **Shortcut discoverability — Small.** Show quiet shortcut hints in the page menu and tooltips for Search, sidebar toggle, Undo, and Redo.
- **Empty-page affordance — Small.** Give an empty first block a restrained “Type `/` for commands” placeholder without synthesizing a title or changing Markdown.
- **Local disclosure memory — Small.** Remember whether Properties is open per page, while keeping its first visit collapsed.
- **Navigation continuity — Medium.** Restore per-page scroll position and the last focused block when moving backward and forward.
- **Resizable desktop sidebar — Medium.** Allow a constrained, locally persisted sidebar width while retaining the 708px centered writing column when collapsed.

Native pinch gestures should **not** be ported to the web editor. Browser and OS zoom/gesture behavior are already the correct ownership boundary.
