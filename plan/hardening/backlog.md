---
id: d9x485
---
# Arbor technical debt

This file tracks implementation debt and incomplete invariants, not product features. Product-facing editor work belongs in `editor-todo.md`.

## REST protocol and reference clients

### Confirmed v0.8 conformance gaps

These are implementation violations of the aspirational specification. They are recorded here rather than weakening the public contract.

1. **Keep access-link secrets out of local navigation state.** Remote link browsing currently allows the raw secret to enter a local URL and durable visit metadata instead of keeping it out of band. Canopy and its public bootstrap now use the normative `Arbor-Access-Link` header, but the local browser handoff still needs a non-URL secret channel.
2. **Reject mixed `removeTreePlacement` batches before durable intent.** The operation can pass early system-domain discrimination in a mixed batch and reach intent recording before later rejection.
3. **Implement one-pass percent decoding.** URL handling must decode only at the external boundary. Deterministic UTF-8 directory-object ordering replaced locale-sensitive ordering during Plan 013.
4. **Expose the v0.8 `system:` shape.** The reference system tree does not yet expose `system:connections` and some records predate the consolidated tree-level profile/access shape.

### Other REST and client debt

1. **Specify copied-subtree identity and link semantics.** Copy correctly remints page IDs while move preserves them, but recursive copy does not yet define whether page-ID links between copied pages should be remapped to the new subtree or continue pointing at the originals. Make that choice normative and test duplicate-page and nested-directory copies before presenting copy as project/folder duplication.
2. **Share runtime protocol decoding only when another boundary needs it.** Arbor Sync's handwritten validators are becoming substantial, particularly for recursive Markdown block values. If the CLI or another trusted client needs runtime decoding, colocate pure decoders with the browser-safe protocol types in `@arbor/core`; do not introduce schema generation or a general validation framework solely to remove repetition.

3. **Complete the unified node-protocol migration.** [Data 002](../data/002-reconcile-node-data-model.md)
   has removed duplicated snapshot scope, hydrated-only wire fields, the
   collection endpoint, and public physical-kind enums. It still owns store
   unification, resolvable and mutable rollup rows, bounded child placement,
   Wire rollup objects, remote browsing, and provider-neutral queries. Do not
   repair those independently in a way that recreates a parallel ontology.
4. **Remove the temporary pre-Canopy readers.** Version-1 device configuration currently accepts legacy `authority:` as well as canonical `server:`, and Canopy startup recognizes `authority.sqlite3` long enough to checkpoint, verify, back up, and rename it. Remove the YAML alias and legacy database discovery after the hosted account-configuration tree and every active device file have been verified to contain only `server:`, all deployed data roots use `canopy.sqlite3`, and the agreed rollback-retention window for `authority.sqlite3.pre-canopyd` has elapsed. Keep rejection of files containing both placement keys until the legacy reader itself is removed.

## Filesystem and structural editing

1. **Make structural undo workspace-scoped.** The current undo stack lives in `PageEditor`, so it covers body-view mutations but is lost on navigation and does not include mutations initiated from the sidebar context menu. Move history ownership above individual page editors and store transaction descriptors rather than closures.
2. **Give protocol mutations first-class inverse metadata.** The UI currently derives inverse move, create, import, and trash operations from `MutationReceipt.effects` and the `/Trash` path convention. Have arborsync return a validated inverse token or accept an explicit receipt/transaction undo operation so recovery, conflicts, and future sync causality remain inside the workspace authority.
3. **Preserve exact non-contiguous document-link reorder undo.** A batch of non-contiguous selected links is moved as a contiguous group. Its current inverse restores the group near its former trailing anchor but cannot recreate intervening blocks exactly. Store the complete before/after editor snapshot for this source edit.

4. **Implement bounded child placement uniformly.** The accepted
   `<!-- arbor:children -->` contract in the directory-format spec replaces the
   collection-aware exclusion and literal unmatched-child expansion. Data 002
   owns deletion of `directoryDocumentOptions`, `includeDirectoryChild`, and
   remote collection filtering, plus one conformance corpus across filesystem,
   rollup, SQLite, Postgres, native, and remote providers. Do not leave the old
   exception active in any provider after that migration.

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
