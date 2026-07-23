# Arbor technical debt

This file tracks implementation debt and incomplete invariants, not product features. Product-facing editor work belongs in `editor-todo.md`.

## Filesystem and structural editing

1. **Make structural undo workspace-scoped.** The current undo stack lives in `PageEditor`, so it covers body-view mutations but is lost on navigation and does not include mutations initiated from the sidebar context menu. Move history ownership above individual page editors and store transaction descriptors rather than closures.
2. **Give transactions first-class inverse metadata.** The UI currently derives inverse move, create, import, and trash operations from `FsMutationResult` and the `/Trash` path convention. Have `WorkspaceFS` return a validated inverse token or expose `undo(transactionId)` so recovery, conflicts, and future sync causality stay inside the filesystem coordinator.
3. **Validate document insertion anchors.** `beforeBlockId` currently falls back to the end when its target is stale or absent. Include the directory-body revision and reject a missing insertion anchor as a structured conflict instead of silently changing placement.
4. **Share the structural-row planner.** `WorkspaceFS.applyRowPlan` is authoritative, while `PageEditor.moveManagedRows` duplicates its ordering rules for immediate optimistic feedback. Extract a pure, tested logical-row transform that both layers consume so rollback previews cannot drift from committed Markdown.
5. **Specify nested structural-row placement.** The row rewriter can insert before a nested BlockNote block, but the intended relationship between filesystem children and nested document blocks is not yet documented or exhaustively tested.
6. **Preserve exact non-contiguous reorder undo.** A batch of non-contiguous selected rows is moved as a contiguous group. Its current inverse restores the group near its former trailing anchor but cannot recreate intervening rows exactly. Either record an exact structural-row layout or add an exact-order mutation.
7. **Exercise row placement under crash recovery.** Add fault injection around a `beforeBlockId` move between prose blocks and prove recovery preserves both the physical tree and the complete mixed prose/child-row order.

## Autosave, conflicts, and history

1. **Extract the editor coordinator.** Generation tracking, autosave scheduling, merge handling, history grouping, filesystem inverses, and UI state currently make `PageEditor.tsx` too stateful. Extract deterministic coordinators with injected clocks and transports.
2. **Make unload draining explicit.** The editor currently starts a best-effort save during cleanup. Add an application-level drain/navigation contract and a `beforeunload` policy for outstanding generations rather than relying on an unawaited component cleanup.
3. **Unify frontmatter conflict semantics.** Block bodies use a three-way merge, while frontmatter is still represented as a patch applied to the external revision. Add per-key conflict detection and explicit deletion/change resolution.
4. **Bound and persist history deliberately.** The in-memory undo and redo stacks are currently unbounded and page-session-local. Set retention limits and decide whether reload/crash recovery should expose recent local history.
5. **Separate authored changes from editor normalization.** Shorthand conversion and BlockNote normalization can produce multiple change callbacks. Coalesce them into one authored generation and one undo checkpoint by invariant rather than only by the debounce window.
6. **Test stale async sequences deterministically.** Add clock-controlled tests for edit → autosave → external rewrite → local edit → merge, undo during an in-flight save, failed structural undo, retry after error, and navigation during a pending generation.

## Browser interaction and UI

1. **Harden the custom pointer drag lifecycle.** Capture the pointer explicitly, handle touch and pen input, support autoscroll, and verify that the reused BlockNote drop cursor clears correctly when the floating side menu retargets, disappears, or the drag is cancelled.
2. **Clarify keyboard accessibility for the native handle.** The reused BlockNote handle can select on click and drag with a pointer, but it needs a keyboard path for picking up, moving, and cancelling managed rows without invoking ordinary BlockNote block movement.
3. **Clamp and focus-manage context menus.** Sidebar menus should stay inside the viewport, restore focus to their invoking row, expose arrow-key navigation, and avoid relying on document-level pointer dismissal alone.
4. **Make same-page scroll restoration anchor-based.** Transaction and autosave refreshes currently restore the exact window coordinates across the next two animation frames. If directory bodies become virtualized or external edits substantially change content above the viewport, preserve the first visible block and its viewport offset instead.
5. **Turn the live browser routine into a small developer smoke harness.** Keep injected probes for DOM/state/network invariants and reserve hands-on browser control for hover, focus, pointer drag, and feel. Do not grow synthetic Playwright scripts that imitate those tactile checks.
