---
id: d9x485
---
# Arbor technical debt

> **Historical backlog snapshot.** On 2026-08-28 its live items were moved into
> the category indexes and owning Data, Application, and Interface plans linked
> from [`plans/README.md`](../../README.md). This file preserves the previous
> wording and is not an active queue.

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

3. **Remove the temporary pre-Canopy readers.** Version-1 device configuration currently accepts legacy `authority:` as well as canonical `server:`, and Canopy startup recognizes `authority.sqlite3` long enough to checkpoint, verify, back up, and rename it. Remove the YAML alias and legacy database discovery after the hosted account-configuration tree and every active device file have been verified to contain only `server:`, all deployed data roots use `canopy.sqlite3`, and the agreed rollback-retention window for `authority.sqlite3.pre-canopyd` has elapsed. Keep rejection of files containing both placement keys until the legacy reader itself is removed.

### Data 002 migration bridges

1. **Remove the PageID-shaped compatibility bridge.** `pageIDStableKey`,
   `pageIDFromStableKey`, private PageID owner indexes, legacy event/effect
   fixture rejection, and the legacy-fragment candidate temporarily translate
   Markdown `id` into the uniform stable-key slot. Public events, backlinks,
   native references, and mutation effects now carry generic stable keys.
   Delete the remaining representation bridge only after the legacy-fragment
   uniqueness reader has passed its retention window and Markdown identity has
   a provider-owned codec. Keep the owner index behavior behind the generic
   identity rule; do not remove rename healing itself.
2. **Complete
   [Smaller project 003](../../smaller-projects/003-native-offline-collection-file-projection.md).** The
   local daemon's unplaced remote-tree adapter now pages descriptor-derived rows directly and
   the old `remoteChildren` physical cache is deleted. Swift independently
   validates, retains, materializes, and re-encodes rollup descriptors so an
   unrelated offline edit cannot erase them, but `ArborReplica` does not yet
   project those descriptors as ordinary row snapshots and child pages. Data
   006 deliberately leaves the implementation mechanism open; do not parse
   `primaryKey` from source text or create a second Swift-only schema language.
3. **Complete [Postgres 001](../../postgres/001-child-provider.md).** That plan now
   owns removal of Postgres virtual nodes, `external:postgres`, provisional
   offset cursors, and all associated deletion conditions.
4. **Complete [Smaller project 001](../../smaller-projects/001-representation-equivalence.md).** That plan
   now owns the reviewed logical-path rule/converter and the proof that expanded
   Markdown and key-derived rollups preserve refs and ordinary relative links.
5. **Finish bounded exact-source snapshots for file providers.** File-backed
   summary, paging, and stable-key resolution now share a size-bounded cache
   keyed by exact schema/store/Markdown bytes and invalidated after Arbor
   writes. Add filesystem-driven invalidation/metrics and avoid duplicate source
   reads while preserving complete-key-set validation. Do not extend this cache
   to SQLite/Postgres: Data 005 owns their transaction read sessions and
   committed observation cursors.
6. **Finish Data 005's shared SQLite read/observation boundary.** Generic
   SQLite browsing now validates authored `schema.sql`/`relationships.json` and
   samples rows on one read connection and transaction. It still opens that
   boundary independently from the SQLite change broker and still computes
   complete logical table digests. Route browsing, mutation, query, and
   observation through the reviewed provider cursor/session owner, retain the
   last usable schema with an actionable stale diagnostic, and remove the
   whole-table revision stand-in.
7. **Specify lossless SQLite property scalar projection.** The generic adapter
   currently follows existing observer conventions by normalizing booleans and
   representing BLOBs as a tagged base64 object; integers outside JavaScript's
   safe range are conservatively surfaced as strings. Freeze language-neutral
   value fixtures for blobs and 64-bit integers, then share one normalization
   implementation across node properties, query results, mutation validation,
   observation logs, TypeScript, and Swift.
8. **Separate relational names from logical table-child segments.** The
    provisional SQLite and Postgres bridges use a valid ordinary table name as
    both provider identifier and logical child segment, and can collide with a
    physical child of the database directory. The shared provider contract
    must derive or declare a reversible safe segment, diagnose collisions, and
    retain the authored relation name for query and mutation handles. Freeze
    fixtures for spaces, slashes, Unicode, reserved `~row-` prefixes, and a
    same-named physical child before removing the virtual-table bridge.
9. **Remove the whole-table SQLite revision stand-in under Data 005.** The
    generic child adapter currently hashes every logical row plus schema to
    populate table/children revisions. This is not an exact database revision
    and is unbounded. Replace it with schema fingerprint, row CAS revisions,
    provider observation/sensitivity boundaries, and explicit synchronization
    checkpoints only when needed. Vacuuming and SQLite page/WAL bytes are
    placement-private and do not participate in logical synchronization.
10. **Complete
    [Apps 003](../../apps/003-development-compiler-and-editor-tooling.md).**
    It now owns generated source schemas, ordinary-tree activation manifests,
    empty-source typing, imported helpers, computed-locator bounds, and removal
    of the current manual binding/sample-derived fallback seam.
11. **Replace temporary whole-source portable query evaluation.** Ordinary-node
    queries currently page up to 10,000 children before filtering and picking,
    and the SQLite reference driver reads the complete root relation before
    applying the shared predicate so SQLite coercion/collation cannot alter
    portable meaning. Add a manifest-declared finite source bound plus proved
    semantics-preserving provider pushdown/cursors, and reject activation when
    neither can prove bounded execution. Do not turn the emergency ceiling or
    the reference driver's full scan into public query semantics.
12. **Retire the SQLite direct-write receipt bridge deliberately.** Generic row
    writes currently create `__arbor_property_receipts` inside the store so a
    crash after the row commit can replay the same mutation safely. The shared
    provider transaction protocol must define receipt retention/pruning,
    representation-sync behavior, and how copied or replicated stores scope
    caller mutation IDs. Remove the private table only after provider commit
    recovery offers the same crash guarantee.
13. **Finish the file-rollup transaction lifecycle outside managed workspaces.**
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
14. **Remove the legacy mutation-journal effect decoder.** New durable records
    write only `effect.ref`; the reader temporarily upgrades pre-Data-002
    `{ tree, path, pageID }` effects so an interrupted mutation can still be
    recovered after upgrade. Delete this decoder after the supported recovery
    window has elapsed and deployed journal directories have been observed with
    no legacy pending records. Do not restore legacy fields to Wire receipts.

15. **Harden Canopy application-code execution as one boundary.** Canopy will
    execute synchronized `schema.ts` using the current restricted schema
    runtime so Wire rollups can be validated without a second authored schema.
    Treat that as the same future isolation problem as SSR, executable
    documents, queries, and mutations: move compilation/execution behind a
    separately contained worker, freeze runtime/compiler versions and
    deterministic APIs, enforce CPU/memory/output quotas, cache only by exact
    source and runtime version, and add hostile-code and cross-tenant tests.
    Do not invent a schema-only artifact format merely as a security retrofit.
16. **Preserve exact rollup formatting through semantic merge.** Canopy now
    reconciles CSV/JSON/JSONL rows by stable identity and emits a valid canonical
    encoding, so accepted logical data is correct but whitespace, CSV quoting,
    property ordering, and trailing-newline choices may change. Apply updates
    to spans in the authority's current exact source where possible, retain all
    untouched bytes, and use canonical encoding only for changes whose source
    form cannot be retained. Keep logical validation and `modelDigest`
    independent of those formatting choices.

## Filesystem and structural editing

1. **Make structural undo workspace-scoped.** The current undo stack lives in `PageEditor`, so it covers body-view mutations but is lost on navigation and does not include mutations initiated from the sidebar context menu. Move history ownership above individual page editors and store transaction descriptors rather than closures.
2. **Give protocol mutations first-class inverse metadata.** The UI currently derives inverse move, create, import, and trash operations from `MutationReceipt.effects` and the `/Trash` path convention. Have arborsync return a validated inverse token or accept an explicit receipt/transaction undo operation so recovery, conflicts, and future sync causality remain inside the workspace authority.
3. **Preserve exact non-contiguous document-link reorder undo.** A batch of non-contiguous selected links is moved as a contiguous group. Its current inverse restores the group near its former trailing anchor but cannot recreate intervening blocks exactly. Store the complete before/after editor snapshot for this source edit.

4. **Extend bounded-placement conformance to deferred providers.** Data 002 now
   projects local, managed, and native directory children without persisting
   generated links. Reuse the same corpus when remote rollups, SQLite, and
   Postgres gain direct `ChildProvider` implementations, and include a 100k-row
   scale case proving generated placement does not grow authored Markdown
   source; do not add a second placement algorithm at those boundaries.

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

## Verification and test infrastructure

1. **Make the parallel integration suite reliably isolated under load.** The
   first Data 002 closure run saw one Markdown-body fixture read another
   in-file state and one self-sync wait hit its five-second ceiling after 311
   passes. Both tests passed immediately in isolation and all 313 tests passed
   on a complete parallel rerun. Remove mutable process-global fixture coupling,
   give synchronization waits condition-based diagnostic deadlines, and add a
   repeated parallel CI lane so a green gate does not depend on scheduling.
