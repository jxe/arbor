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
3. **Implement one-pass percent decoding.** URL handling must decode only at the external boundary. Deterministic UTF-8 directory-object ordering replaced locale-sensitive ordering during Plan 013.
4. **Expose the v0.8 `system:` shape.** The reference system tree does not yet expose `system:connections` and some records predate the consolidated tree-level profile/access shape.

### Other REST and client debt

1. **Specify copied-subtree identity and link semantics.** Copy correctly remints page IDs while move preserves them, but recursive copy does not yet define whether page-ID links between copied pages should be remapped to the new subtree or continue pointing at the originals. Make that choice normative and test duplicate-page and nested-directory copies before presenting copy as project/folder duplication.
2. **Stop eagerly draining children when large directories need incremental presentation.** The TypeScript client's `node()` and observed-node view currently drain all fixed-size child pages to preserve Arbor web's existing UI. Keep the fixed protocol page size, but introduce incremental or virtualized directory presentation before large trees make every navigation fetch the entire listing.
3. **Share runtime protocol decoding only when another boundary needs it.** Arbord's handwritten validators are becoming substantial, particularly for recursive Markdown block values. If the CLI or another trusted client needs runtime decoding, colocate pure decoders with the browser-safe protocol types in `@arbor/core`; do not introduce schema generation or a general validation framework solely to remove repetition.

4. **Split the wire `NodeSnapshot` from the hydrated client view.** The snapshot carries a top-level `path` duplicating `ref.path`, and an ergonomic `children?` field the wire never sends (clients populate it during hydration). Define the wire type minimally and let each client own its hydrated wrapper, so the REST fixtures describe exactly what crosses the boundary.
5. **Unify the node-kind vocabulary.** `NodeKind` says `postgres` where `ProtocolNodeKind` says `database`, and `/v1/children` currently leaks raw fs kinds. Normalize at the arbord boundary and collapse the two enums if nothing still needs the distinction.
## Filesystem and structural editing

1. **Make structural undo workspace-scoped.** The current undo stack lives in `PageEditor`, so it covers body-view mutations but is lost on navigation and does not include mutations initiated from the sidebar context menu. Move history ownership above individual page editors and store transaction descriptors rather than closures.
2. **Give protocol mutations first-class inverse metadata.** The UI currently derives inverse move, create, import, and trash operations from `MutationReceipt.effects` and the `/Trash` path convention. Have arbord return a validated inverse token or accept an explicit receipt/transaction undo operation so recovery, conflicts, and future sync causality remain inside the workspace authority.
3. **Preserve exact non-contiguous document-link reorder undo.** A batch of non-contiguous selected links is moved as a contiguous group. Its current inverse restores the group near its former trailing anchor but cannot recreate intervening blocks exactly. Store the complete before/after editor snapshot for this source edit.

4. **Reconsider excluding collection/database rows from complete directory Markdown.** The current contract treats a collection's About/index document separately from its Markdown records and virtual database rows. That keeps potentially huge/query-backed row sets out of `_index.md`, but it adds a collection-aware exception to otherwise uniform directory completion: `Workspace.directoryDocumentOptions` filters Markdown row paths, `WorkspaceFS.read`/`writeMarkdown` accept an `includeDirectoryChild` hook, and remote completion separately recognizes collection marker files. Decide from real Arbor web collection UX whether physical Markdown records, virtual rows, both, or neither should participate.

   A uniform contract does not have to put one literal link per row in source. The preferred bounded design to investigate is one provider-recognized “unplaced children” marker in Markdown. Explicit first standalone links would still claim authored positions; the marker would represent every otherwise-unmentioned immediate child, while arbord pages/streams the remainder from the filesystem or collection store and Arbor web virtualizes it. Promoting a virtual row into authored prose would create one ordinary link; removing that link would return it to the marker. The content revision could combine exact source with a stable child/store generation instead of allocating every row descriptor. This introduces one piece of Arbor-semantic Markdown, but avoids per-link annotations and makes physical and query-backed children obey the same placement rule. If the contract instead requires every row to be a literal ordinary Markdown link, total source/parse/editor cost is necessarily O(row count); transport pagination alone cannot remove it.

   To remove the exception with literal links: delete `directoryDocumentOptions` and the `includeDirectoryChild` plumbing; remove `isCollectionDirectory`/`operationalChildren` filtering in `packages/arbord/src/service.ts`; delete the collection-row exclusion test; remove the exception language from `spec/format.md`, `spec/wire.md`, and `plan/native/README.md`; then require row add/remove/rename to affect the directory content revision and run the same bounded complete-source corpus against file, SQLite, and Postgres collections. To adopt the bounded marker instead, first specify its exact portable syntax, default/absence behavior, ordering, multiple-marker rejection, revision semantics, pagination, edit promotion/demotion, and publication behavior; then replace literal unmatched-child completion for every intended provider in one conformance change. Do not leave local and remote providers—or filesystem and collection directories—with different rules.

## Autosave, conflicts, and history

1. **Make unload draining explicit.** The editor coordinator still starts a best-effort save during cleanup. Add an application-level drain/navigation contract and a `beforeunload` policy for outstanding generations rather than relying on an unawaited component cleanup.
2. **Drain native control text before flushing admitted saves.** Quagmire may still hold the latest typing in `NSTextView` or `UITextView` during its 750 ms checkpoint window. Native Arbor's background, navigation, close, and shutdown paths currently wait only for saves already admitted to `ArborDocumentBinding`, so they can miss that live text and briefly report “Saved locally” too early. Add an explicit active-editor commit-then-flush lifecycle operation and expose checkpoint-pending state to save presentation.
3. **Unify frontmatter conflict semantics.** Block bodies use a three-way merge, while frontmatter is still represented as a patch applied to the external revision. Add per-key conflict detection and explicit deletion/change resolution.
4. **Bound and persist history deliberately.** The coordinator's in-memory undo and redo stacks are currently unbounded and page-session-local. Set retention limits and decide whether reload/crash recovery should expose recent local history.
5. **Test stale async sequences deterministically.** Extend the clock-controlled coordinator suite for edit → autosave → external rewrite → local edit → merge, undo during an in-flight save, failed structural undo, retry after error, and navigation during a pending generation.
6. **Reconcile changed server documents minimally.** Arbor now keeps one BlockNote editor instance per page and applies server snapshots through a non-history BlockNote transaction. If large external rewrites become disruptive, replace the current whole-document `replaceBlocks` step with an ID-aware minimal patch that preserves the cursor across surviving blocks.

## Browser interaction and UI

1. **Harden the custom pointer drag lifecycle.** Capture the pointer explicitly, handle touch and pen input, support autoscroll, and verify that the reused BlockNote drop cursor clears correctly when the floating side menu retargets, disappears, or the drag is cancelled.
2. **Clarify keyboard accessibility for the native handle.** The reused BlockNote handle can select on click and drag with a pointer, but it needs a keyboard path for picking up, moving, and cancelling document-link rows without invoking ordinary BlockNote block movement.
3. **Clamp and focus-manage context menus.** Sidebar menus should stay inside the viewport, restore focus to their invoking row, expose arrow-key navigation, and avoid relying on document-level pointer dismissal alone.
4. **Make same-page scroll restoration anchor-based.** Transaction and autosave refreshes currently restore the exact window coordinates across the next two animation frames. If directory bodies become virtualized or external edits substantially change content above the viewport, preserve the first visible block and its viewport offset instead.
5. **Turn the live browser routine into a small developer smoke harness.** Keep injected probes for DOM/state/network invariants and reserve hands-on browser control for hover, focus, pointer drag, and feel. Do not grow synthetic Playwright scripts that imitate those tactile checks.
