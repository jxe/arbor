---
id: d9x485
---
# Arbor technical debt

This file tracks implementation debt and incomplete invariants, not product features. Product-facing editor work belongs in `editor-todo.md`.

## REST protocol and reference clients

### Confirmed v0.8 conformance gaps

These are implementation violations of the aspirational specification. They are recorded here rather than weakening the public contract.

1. **Keep access-link secrets out of loopback URLs and visit records.** Remote link browsing currently allows the raw secret to enter a local URL and durable visit metadata instead of keeping it out of band and sending `X-Arbor-Access` only to the wire host.
2. **Reject mixed `removeTreePlacement` batches before durable intent.** The operation can pass early system-domain discrimination in a mixed batch and reach intent recording before later rejection.
3. **Harden Swift projection and malformed-batch validation.** The Swift client can permit projected synthetic rows across the mutation boundary and accepts malformed system-operation batches that the REST contract rejects.
4. **Retain explicit tree scope in projected children and Swift search.** Some projected child references and Swift search results fall back to path-only identity, becoming ambiguous across mounted boundaries.
5. **Accept opaque `PageID`s.** Reference clients still treat the legacy six-character lowercase convention as the complete grammar in some paths.
6. **Implement one-pass percent decoding and deterministic UTF-8 wire ordering.** URL handling must decode only at the external boundary, and directory-object ordering must compare UTF-8 bytes rather than `localeCompare`.
7. **Expose the v0.8 `system:` shape.** The reference system tree does not yet expose `system:connections` and some records predate the consolidated tree-level profile/access shape.

### Other REST and client debt

1. **Specify copied-subtree identity and link semantics.** Copy correctly remints page IDs while move preserves them, but recursive copy does not yet define whether page-ID links between copied pages should be remapped to the new subtree or continue pointing at the originals. Make that choice normative and test duplicate-page and nested-directory copies before presenting copy as project/folder duplication.
2. **Stop eagerly draining children when large directories need incremental presentation.** The TypeScript client's `node()` and observed-node view currently drain all fixed-size child pages to preserve TreeHopper's existing UI. Keep the fixed protocol page size, but introduce incremental or virtualized directory presentation before large trees make every navigation fetch the entire listing.
3. **Share runtime protocol decoding only when another boundary needs it.** Arbord's handwritten validators are becoming substantial, particularly for recursive Markdown block values. If the CLI or another trusted client needs runtime decoding, colocate pure decoders with the browser-safe protocol types in `@arbor/core`; do not introduce schema generation or a general validation framework solely to remove repetition.

4. **Split the wire `NodeSnapshot` from the hydrated client view.** The snapshot carries a top-level `path` duplicating `ref.path`, and an ergonomic `children?` field the wire never sends (clients populate it during hydration). Define the wire type minimally and let each client own its hydrated wrapper, so the REST fixtures describe exactly what crosses the boundary.
5. **Unify the node-kind vocabulary.** `NodeKind` says `postgres` where `ProtocolNodeKind` says `database`, and `/v1/children` currently leaks raw fs kinds. Normalize to the protocol vocabulary at the arbord boundary (planned as part of the projection work) and collapse the two enums if nothing still needs the distinction.
## Filesystem and structural editing

1. **Make structural undo workspace-scoped.** The current undo stack lives in `PageEditor`, so it covers body-view mutations but is lost on navigation and does not include mutations initiated from the sidebar context menu. Move history ownership above individual page editors and store transaction descriptors rather than closures.
2. **Give protocol mutations first-class inverse metadata.** The UI currently derives inverse move, create, import, and trash operations from `MutationReceipt.effects` and the `/Trash` path convention. Have arbord return a validated inverse token or accept an explicit receipt/transaction undo operation so recovery, conflicts, and future sync causality remain inside the workspace authority.
3. **Specify nested structural-row placement.** The shared row planner supports insertion before a nested BlockNote block, but the intended relationship between filesystem children and nested document blocks is not yet documented or exhaustively tested.
4. **Preserve exact non-contiguous reorder undo.** A batch of non-contiguous selected rows is moved as a contiguous group. Its current inverse restores the group near its former trailing anchor but cannot recreate intervening rows exactly. Either record an exact structural-row layout or add an exact-order mutation.
5. **Exercise row placement under crash recovery.** Add fault injection around a `beforeBlockId` move between prose blocks and prove recovery preserves both the physical tree and the complete mixed prose/child-row order.

6. **Rework the editor's optimistic move preview off `transformStructuralRows`.** `PageEditor.runOptimisticMove` still previews anchored placement by running the shared row transform over the visible blocks. Under the manifest model the preview could instead reorder the projection directly (visible blocks + manifest), letting `transformStructuralRows` become private to the filesystem layer. Behavior is correct today; this is an altitude cleanup.

## Autosave, conflicts, and history

1. **Make unload draining explicit.** The editor coordinator still starts a best-effort save during cleanup. Add an application-level drain/navigation contract and a `beforeunload` policy for outstanding generations rather than relying on an unawaited component cleanup.
2. **Unify frontmatter conflict semantics.** Block bodies use a three-way merge, while frontmatter is still represented as a patch applied to the external revision. Add per-key conflict detection and explicit deletion/change resolution.
3. **Bound and persist history deliberately.** The coordinator's in-memory undo and redo stacks are currently unbounded and page-session-local. Set retention limits and decide whether reload/crash recovery should expose recent local history.
4. **Test stale async sequences deterministically.** Extend the clock-controlled coordinator suite for edit → autosave → external rewrite → local edit → merge, undo during an in-flight save, failed structural undo, retry after error, and navigation during a pending generation.
5. **Reconcile changed server documents minimally.** Arbor now keeps one BlockNote editor instance per page and applies server snapshots through a non-history BlockNote transaction. If large external rewrites become disruptive, replace the current whole-document `replaceBlocks` step with an ID-aware minimal patch that preserves the cursor across surviving blocks.

## Browser interaction and UI

1. **Harden the custom pointer drag lifecycle.** Capture the pointer explicitly, handle touch and pen input, support autoscroll, and verify that the reused BlockNote drop cursor clears correctly when the floating side menu retargets, disappears, or the drag is cancelled.
2. **Clarify keyboard accessibility for the native handle.** The reused BlockNote handle can select on click and drag with a pointer, but it needs a keyboard path for picking up, moving, and cancelling managed rows without invoking ordinary BlockNote block movement.
3. **Clamp and focus-manage context menus.** Sidebar menus should stay inside the viewport, restore focus to their invoking row, expose arrow-key navigation, and avoid relying on document-level pointer dismissal alone.
4. **Make same-page scroll restoration anchor-based.** Transaction and autosave refreshes currently restore the exact window coordinates across the next two animation frames. If directory bodies become virtualized or external edits substantially change content above the viewport, preserve the first visible block and its viewport offset instead.
5. **Turn the live browser routine into a small developer smoke harness.** Keep injected probes for DOM/state/network invariants and reserve hands-on browser control for hover, focus, pointer drag, and feel. Do not grow synthetic Playwright scripts that imitate those tactile checks.
