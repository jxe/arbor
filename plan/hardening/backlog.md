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

### Data 002 migration bridges

1. **Remove the PageID-shaped compatibility bridge.** `pageIDStableKey`,
   `pageIDFromStableKey`, private PageID owner indexes, legacy event/effect
   payload fields, and deprecated native source aliases temporarily translate
   Markdown `id` into the uniform stable-key slot. Delete the bridge only after
   events, backlinks, and native callers all
   carry generic stable keys and the legacy-fragment uniqueness reader has
   passed its retention window. Keep the owner index behavior behind the
   generic identity rule; do not remove rename healing itself.
2. **Finish replacing private physical node records.** `CollectionPage`,
   `CollectionSummary`, `CollectionRow`, the `collection`/`postgres` node kinds,
   and duplicated managed/untracked row probes are gone. `TreeNode`/`TreeChild`
   remain only as the expanded-filesystem read model. Remove them as provider
   `describe` and observation land; do not recreate an adapter translation page
   or expose physical records to REST, browser, native, generated-type, or query
   consumers.
3. **Replace remote physical-child caching with Wire rollup projection.** The
   unplaced-tree adapter currently keeps an in-memory `remoteChildren` map and
   retains collection-aware physical child filtering because Wire cannot yet
   resolve rollup rows. Delete both when rollup descriptors, remote row paging,
   bounded marker placement, and schema/model-digest validation are live on
   Canopy; remote results must then match placed and offline providers.
4. **Complete [Data 004](../data/004-postgres-child-provider.md).** That plan now
   owns removal of Postgres virtual nodes, `external:postgres`, provisional
   offset cursors, and all associated deletion conditions.
5. **Complete [Data 003](../data/003-representation-equivalence.md).** That plan
   now owns the reviewed logical-path rule/converter and the proof that expanded
   Markdown and key-derived rollups preserve refs and ordinary relative links.
6. **Cache bounded provider snapshots instead of rebuilding complete views.**
   File-backed summary, paging, and stable-key resolution currently reparse and
   revalidate the complete backing to establish duplicate-key safety. The first
   SQLite node adapter likewise re-introspects and reads every user row for
   describe, page, and resolve. Replace both retrofits with a size-bounded,
   exact-revision-keyed provider snapshot shared by describe/page/resolve, with
   filesystem/database invalidation and no stale schema reuse. Preserve
   full-key-set validation; do not optimize by checking only the returned page.
7. **Join SQLite schema validation, row sampling, and observation at one
   snapshot boundary.** Generic SQLite browsing currently validates authored
   `schema.sql` and `relationships.json` on one read connection, then samples
   rows in a second read transaction. A concurrent schema commit can therefore
   make that pair inconsistent even though each operation is individually
   database-safe. Have `ChildProvider` obtain schema, rows, model digest, and
   observation cursor through the shared SQLite broker/snapshot owner, retain
   the last usable schema with an actionable diagnostic, and invalidate the
   exact snapshot after external WAL commits.
8. **Specify lossless SQLite property scalar projection.** The generic adapter
   currently follows existing observer conventions by normalizing booleans and
   representing BLOBs as a tagged base64 object; integers outside JavaScript's
   safe range are conservatively surfaced as strings. Freeze language-neutral
   value fixtures for blobs and 64-bit integers, then share one normalization
   implementation across node properties, query results, mutation validation,
   observation logs, TypeScript, and Swift.
9. **Separate relational names from logical table-child segments.** The
    provisional SQLite and Postgres bridges use a valid ordinary table name as
    both provider identifier and logical child segment, and can collide with a
    physical child of the database directory. The shared provider contract
    must derive or declare a reversible safe segment, diagnose collisions, and
    retain the authored relation name for query and mutation handles. Freeze
    fixtures for spaces, slashes, Unicode, reserved `~row-` prefixes, and a
    same-named physical child before removing the virtual-table bridge.
10. **Expose exact SQLite representation state separately from its model
    digest.** The generic child revision currently hashes a coherent logical
    row snapshot and schema fingerprint, which is sufficient for stable paging
    but does not identify formatting-equivalent SQLite page/WAL bytes. The Wire
    rollup provider must carry an exact accepted source/object revision and a
    separate scoped model digest so vacuuming, indexes, and representation-only
    changes participate in synchronization without changing logical equality.
11. **Complete
    [Application 003](../applications/003-development-compiler-and-editor-tooling.md).**
    It now owns generated source schemas, ordinary-tree activation manifests,
    empty-source typing, imported helpers, computed-locator bounds, and removal
    of the current manual binding/sample-derived fallback seam.
12. **Replace temporary whole-source portable query evaluation.** Ordinary-node
    queries currently page up to 10,000 children before filtering and picking,
    and the SQLite reference driver reads the complete root relation before
    applying the shared predicate so SQLite coercion/collation cannot alter
    portable meaning. Add a manifest-declared finite source bound plus proved
    semantics-preserving provider pushdown/cursors, and reject activation when
    neither can prove bounded execution. Do not turn the emergency ceiling or
    the reference driver's full scan into public query semantics.
13. **Retire the SQLite direct-write receipt bridge deliberately.** Generic row
    writes currently create `__arbor_property_receipts` inside the store so a
    crash after the row commit can replay the same mutation safely. The shared
    provider transaction protocol must define receipt retention/pruning,
    representation-sync behavior, and how copied or replicated stores scope
    caller mutation IDs. Remove the private table only after provider commit
    recovery offers the same crash guarantee.
14. **Finish the file-rollup transaction lifecycle outside managed workspaces.**
    Exact-source CSV/JSON/JSONL writes now prepare an fsynced sibling file,
    publish it by compare-and-rename, and participate in the managed workspace's
    durable mutation journal. `FilesystemService` still retains completed
    direct-write receipts only in memory, and a process exit before commit can
    leave an unreferenced prepared sibling. Add a scoped durable receipt/journal
    for untracked roots and startup cleanup for positively identified abandoned
    prepare files. Also make the cooperative writer-lock boundary explicit:
    revision checking serializes Arbor writers, but a non-cooperating external
    editor can still replace the source between the last comparison and rename
    on filesystems without conditional rename. Do not weaken exact retry
    identity or delete arbitrary editor-created siblings.
15. **Replace the ordinary-query dependency adapter with the shared live
    sensitivity runtime.** `NodeQueryEngine` now records the resolved parent's
    membership/schema revision and pre-read observation cursor alongside every
    sampled row, so insertions and removals have a gap-free conservative token.
    It is not yet mounted in `RegisteredQueryRuntime` or translated into field,
    schema, access, mount, and provider sensitivities; the SQLite live broker
    still owns a relational dependency shape. Build one provider-neutral live
    broker before serving ordinary-tree handles through Wire `/queries`, then
    remove the temporary complete row-list dependency where a narrower proved
    sensitivity is available.

## Filesystem and structural editing

1. **Make structural undo workspace-scoped.** The current undo stack lives in `PageEditor`, so it covers body-view mutations but is lost on navigation and does not include mutations initiated from the sidebar context menu. Move history ownership above individual page editors and store transaction descriptors rather than closures.
2. **Give protocol mutations first-class inverse metadata.** The UI currently derives inverse move, create, import, and trash operations from `MutationReceipt.effects` and the `/Trash` path convention. Have arborsync return a validated inverse token or accept an explicit receipt/transaction undo operation so recovery, conflicts, and future sync causality remain inside the workspace authority.
3. **Preserve exact non-contiguous document-link reorder undo.** A batch of non-contiguous selected links is moved as a contiguous group. Its current inverse restores the group near its former trailing anchor but cannot recreate intervening blocks exactly. Store the complete before/after editor snapshot for this source edit.

4. **Extend bounded-placement conformance to deferred providers.** Data 002 now
   projects local, managed, and native directory children without persisting
   generated links. Reuse the same corpus when remote rollups, SQLite, and
   Postgres gain direct `ChildProvider` implementations; do not add a second
   placement algorithm at those boundaries.

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
