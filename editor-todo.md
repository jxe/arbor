# Arbor editor follow-up

This list starts after the logical filesystem, body-row selection, drag/drop, inline create/rename, and soft-delete tranche. Difficulty is relative to the current web editor.

1. **Inline Markdown fidelity and rich marks — Hard.** Expand the source-span adapter beyond links and plain text: emphasis, strong, strike, inline code, hard breaks, nested marks, and mark-preserving edits. Keep raw fallback for unsupported syntax and prove that untouched source remains byte-identical.
2. **Keyboard block navigation and structural editing — Hard.** Add predictable up/down traversal, keyboard multi-selection, indent/outdent, and keyboard reorder. Managed child rows must join the visible selection model without leaking BlockNote's ordinary block-drag semantics into filesystem moves.
3. **Markdown-aware copy/paste and image paste — Medium–Hard.** Preserve block structure and Markdown when copying within Arbor, produce useful HTML/plain-text clipboard flavors for other apps, parse pasted Markdown, and make image paste/upload progress and failures explicit.
4. **Search and picker keyboard behavior and ranking — Medium.** Add robust focus handoff, arrow/return/escape behavior, stale-query suppression, path/title/content ranking, recent-page bias, and clear empty/error states.
5. **Mentions, page creation, and moving blocks into pages — Hard.** Implement page completion and create-on-select, then a transaction that extracts selected blocks into a new or existing page while inserting a durable child-page/link reference and preserving recovery history.
6. **Link healing UI, backlinks, and orphan indicators — Medium–Hard.** Surface durable-ID healing instead of making it invisible, show inbound references, distinguish stale paths from missing identities, and provide useful orphan diagnostics without forcing eager rewrites.
7. **Leading-emoji page icons and emoji completion — Medium.** Treat a leading title emoji as the page icon, retain it through rename and navigation, and add `:emoji` completion with reliable popover focus and keyboard selection.
8. **Link previews — Medium.** Add compact previews for internal pages and safe external metadata, with cancellation, caching, offline behavior, and no editor-selection disruption.
9. **Persistent hierarchical sidebar, then sidebar drag/drop — Hard.** Preserve expansion and selection state across navigation, scale lazy disclosure to large trees, and only then reuse the filesystem mutation API for sidebar moves. Do not fork a second mutation or selection model.
10. **Voice recording and transcript support — Very hard / later.** Add explicit recorder ownership, permission and interruption handling, incremental transcription, durable media placement, and recovery. This is independent of the core editor and should remain late.

Native pinch gestures should **not** be ported to the web editor. Browser and OS zoom/gesture behavior is already the correct ownership boundary.
