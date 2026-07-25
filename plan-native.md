# Native build plan
*The Swift/Hunch integration track for TreeHopper native. [plan.md](plan.md) owns arbord, REST v1, and both reference protocol clients—including the UI-independent Swift `ArborClient` package. This file owns the adapter from that client into native workspace/editor behavior, plus migration, Clamshell, iCloud compatibility, and native product surfaces.*

## Founding architecture

TreeHopper native has one editor integration and two workspace backends:

```text
EditorView
    │
    ▼
EditorHost                         window/UI behavior
    │
    ▼
WorkspaceProvider                 resolve, browse, search, mutate, recover, observe
    │
    └── openPage ──▶ WorkspacePageSession
                         document, content revision, synchronous enqueue, flush, close, events
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
          ArbordWorkspaceProvider   ClamshellWorkspaceProvider
          macOS                     iOS / deliberate arbord-less mode
                    │                   │
                    ▼                   ▼
          Swift ArborClient       Clamshell.PageSession
                    │
                    ▼
                  arbord
```

On macOS, arbord is the sole first-party durability authority. TreeHopper does not write the materialized workspace behind arbord's back and then ask the watcher to infer its intent. On iOS, where Bun arbord does not initially run, Clamshell remains the direct filesystem/iCloud authority.

Materialized files stay canonical in both cases. Finder, git, agents, and external editors may still write them directly; arbord or Clamshell classifies those writes as external observations rather than API-authored intent.

## Why this boundary is sufficient

`EditorHost` and `WorkspaceProvider` answer different questions:

- **`EditorHost`** handles editor-to-window behavior: navigation, move pickers, deletion prompts, pasteboard conventions, link previews, and forwarding editor commits.
- **`WorkspaceProvider`** handles native access to logical workspace capabilities: page-aware references and canonical paths, listing, search, create/move/copy/trash/restore, assets, recovery, and change observation.
- **`WorkspacePageSession`** bridges a live native `Editor.Document` to the active durability authority.
- **Swift `ArborClient`** is lower-level protocol plumbing from `plan.md`: REST values, requests, mutation retries, SSE, and resync. It knows nothing about editor documents, windows, or Clamshell.

The session is the essential piece. Hunch's editor commit callback is synchronous: once it returns, a following `flush` must already know that the generation exists. A provider offering only async CRUD would leave a false-quiescence race.

Conceptually:

```swift
@MainActor
protocol WorkspaceProvider: AnyObject {
    func openPage(
        _ reference: WorkspaceReference,
        onEvent: @escaping (WorkspacePageEvent) -> Void
    ) async throws -> any WorkspacePageSession

    func resolve(_ reference: WorkspaceReference) async throws -> Resolution
    func children(of reference: WorkspaceReference) async throws -> [NodeSummary]
    func search(_ query: WorkspaceQuery) async throws -> [NodeSummary]
    func perform(_ mutation: WorkspaceMutation) async throws -> MutationReceipt
}

@MainActor
protocol WorkspacePageSession: AnyObject {
    var reference: ResolvedWorkspaceReference { get }
    var contentRevision: ContentRevision { get }
    var document: Document { get }

    func enqueueEditorOps(_ ops: [EditorOp]) -> Task<Void, Error>
    func flush() async throws
    func close() async throws
}
```

`WorkspaceReference` is the native-facing equivalent of REST `NodeRef`: a logical path or durable page ID with a path hint. It is not a promise that every file has a stable `NodeID`.

The exact Swift spelling may evolve, but the invariants may not:

1. local generation admission is synchronous;
2. writes are ordered;
3. `flush` awaits every admitted generation;
4. a successful arbord acknowledgement is the durable mutation receipt defined by REST v1; a successful Clamshell acknowledgement preserves its equivalent log-before-file guarantee;
5. clean external revisions update the existing `Document` without creating authored undo history;
6. conflicts never silently overwrite either side.

## Reference-implementation boundary

This plan implements exactly two native workspace backends: arbord on macOS and Clamshell on iOS or in deliberate arbord-less mode. It does not need a general backend plugin framework.

The Swift `ArborClient` package is a deliverable of [plan.md](plan.md), even though its source lives beside Hunch. This plan:

- imports that package rather than copying its Codable REST values;
- converts protocol snapshots into `Editor.Document` values;
- owns the local pending-generation queue and page-session lifecycle;
- maps protocol errors/events into native presentation and reconciliation;
- never adds native-only fields or lifecycle endpoints to REST.

Generated Swift SDKs, native capability negotiation, and UI for protocol features that arbord does not yet implement may remain absent indefinitely. When a later core milestone introduces mounts, collections, scripts, sharing, or provenance, add only the native surface needed to demonstrate that feature.

## Ownership after the cutover

```text
TreeHopper native                         arbord
─────────────────                        ──────
Editor.Document and native selection     logical paths and durable page identity
editor transactions and undo             authored intent journal and materialization
window navigation and presentation       CAS, idempotency, mutation ordering
local pending-generation queue           watcher classification and external reconciliation
pickers, prompts, pasteboard              search, recovery, trash, assets
native views and WKWebView islands        mounts, overlays, stores, scripts, sync, sharing
```

On iOS, Clamshell implements the right column for the materialized iCloud workspace. Its existing `PageCoordinator` remains private backend machinery: it owns the canonical `Document`, editor attachments, presenters, ordered generations, reconciliation, and transient closed-page leases. It is not part of the standalone Editor package.

Once provider conformance is complete, Clamshell's application-facing API can shrink without affecting editor functionality. `WorkspaceWindow` should not reach around a provider to call Clamshell; any remaining reach-through identifies a missing capability.

## Dependency on the core plan

This track consumes both the REST v1 contract and the completed Swift `ArborClient` package from the **arbord REST v1 and reference clients** milestone in [`plan.md`](plan.md). It does not redefine endpoints, Codable transport values, event fields, mutation receipts, durability semantics, or logical workspace operations here.

Provider extraction may begin against Clamshell before REST v1 is complete. The arbord-backed adapter begins against the editing-kernel slice of the Swift client; the macOS cutover gate requires the core plan's page-reference, retry, durability, conflict, and lossless observation behavior to be implemented and tested. Later native mounts, collections, scripts, sharing, and provenance begin only when their corresponding core capability exists.

`ArbordWorkspaceProvider` translates `ArborClient` into `WorkspaceProvider` and `WorkspacePageSession`. REST lifecycle and transport design remain owned by `plan.md`; editor lifecycle remains owned here.

## Delivery order

### A. Extract and prove the boundary

1. Introduce `WorkspaceProvider` and `WorkspacePageSession` beside the current APIs.
2. Wrap `Clamshell.PageSession` without changing its durability behavior.
3. Move `WorkspaceWindow`'s storage calls behind the provider while leaving navigation and other UI behavior in `EditorHost`.
4. Run provider conformance cases against Clamshell: open, enqueue, flush, close, external update, conflict, rename, trash/restore, assets, and recovery.

This is complete when native editor functionality no longer depends on the concrete Clamshell API.

### B. Adopt arbord on macOS

1. Add the Swift `ArborClient` package delivered by `plan.md` as an app dependency without exposing it to the `Editor` package.
2. Implement `ArbordWorkspaceProvider` as the mapping from protocol references/snapshots/errors/events into native workspace values.
3. Implement a local `ArbordPageSession` generation queue over `ArborClient` reads, mutation receipts, and event/resync callbacks.
4. Adopt the protocol in the same slices as the core plan: editing kernel, navigation kernel, then current feature parity.
5. Use arbord for macOS page reads, writes, search, mutations, assets, trash, and recovery.
6. Keep Hunch's error banners and interaction behavior; swap the authority, not the product personality.
7. Ensure shutdown/navigation drains the active provider session before structural mutations or process exit.

This is complete when TreeHopper native and web can edit the same open page through arbord without either client observing false quiescence, missing a snapshot/event handoff, or clobbering an external revision. Protocol fixture and transport correctness remain tested in `plan.md`; this plan tests the provider/session/editor mapping.

### C. Migrate the one Clamshell

The known migration is intentionally concrete: one folder of roughly fifty pages, owned by the user.

1. Make a recoverable backup and produce a dry-run inventory.
2. Preserve every six-character `clamshell-id` as the Arbor `id`. During transition, accept both keys; change the key only through the explicit migration.
3. Preserve link fragments exactly. Rename continuity comes from durable IDs and lazy link healing, not a rename ledger.
4. Import `.clamshell.json`'s home-page pointer into the workspace preference/control record. Keep the legacy file while iOS Clamshell still consumes it.
5. Preserve or manifest-migrate `Trash/`, `Assets/`, and `.history/`.
6. Verify counts, IDs, links, home page, assets, trashed pages, and Recover results before switching the real folder.

`.clamshell.json` currently contains the home-page pointer (and tolerates obsolete unknown keys); it is not the rename tracker. Rename-proof links are supplied by page IDs in frontmatter plus authoritative ID resolution and lazy destination healing.

### D. Expand into the whole workspace

With native and web on one authority:

- browse any user-authorized folder and large tree;
- make home a preference rather than the boundary of the world;
- add Finder-like traversal, history, Quick Look/open actions, drag/import, and whole-workspace search;
- support directories as pages and ordinary non-Markdown files without coercing them into editor documents;
- add local mounts and `system:` records;
- then add overlays, shared-tree provenance, scripts/islands, databases, and sharing UI.

## iCloud and sidecars

iCloud compatibility is an early backend requirement, not a late coordination cleanup.

```text
macOS TreeHopper
      │
      ▼
    arbord ───── log-before-file ─────▶ .history/ + Markdown
                                            │
                                         iCloud
                                            │
iOS TreeHopper                              ▼
      └──── Clamshell ───────────────▶ .history/ + Markdown
```

Use one reconciliation model with two storage profiles:

- **Ordinary Arbor region:** arbord keeps the per-device journal in private workspace state.
- **iCloud region:** arbord reads and writes the Clamshell-compatible `.history/` protocol so iOS receives authored intent, not merely a changed Markdown snapshot.

For the iCloud profile:

- each device writes only its own append-only log;
- the log is durable before its corresponding Markdown write;
- page IDs remain stable across moves;
- page history moves with rename/trash/restore;
- `.history/`, `Trash/`, and `.clamshell.json` are hidden from normal browsing/indexing and excluded from shared-tree publication;
- arbord and Clamshell must agree on watermarks, pending peer state, and the distinction between authored purge and external absence.

Only one first-party writer owns a platform at a time: arbord on macOS, Clamshell on iOS. Foreign iCloud delivery is an observed input to that authority. Arbor wire synchronization may be layered above a single arbord relay, but it must not symmetrically replicate the same subtree between devices that iCloud is already replicating.

## Later native surfaces

These build on the early provider rather than introducing new storage paths.

### `system:` and mounts

TreeHopper renders readable `system:mounts`, `system:connections`, trees, shares, and diagnostics as native rows/tables/forms backed by arbord operations. Secrets remain in Keychain and appear only as safe credential references. Invalid source edits retain the last valid configuration and surface diagnostics.

### Search and provenance

Cmd+P searches the visible workspace through arbord and later accepts `TreeID`, public-name, and invitation input through the same resolver. Compact per-page states remain:

```text
local · mounted rw · mounted ro · overlay · visited · pinned · stale · conflicted
```

Arbord supplies these states; TreeHopper does not infer them from paths.

### Island blocks

A standalone link to a `.tsx` script may render as a locked-down WKWebView leaf block served by arbord. The native editor remains native; query/mutation handlers run through explicit message bridges and consent derived from the compiler manifest. Instantiate islands near the viewport and preserve first-responder arbitration.

### Collections

File-, SQLite-, and Postgres-backed collections use the same native browsing vocabulary. Row mutations go through arbord's store transaction boundary; TreeHopper does not learn SQL or materialize database rows into Markdown editor blocks. Missing credentials become a device-local connection prompt.

### Sharing

“Share this folder…” asks arbord to create a shared-tree boundary while leaving the folder at the same workspace path. Invitation acceptance stores an opaque credential reference and lets the recipient choose a mount path and stricter local access. Revocation, offline, overlay, pin, stale, and conflict states reuse the provider's existing events and provenance.

## Acceptance bar

The early integration is complete when:

- macOS native and web use arbord for authored reads and mutations;
- iOS uses direct Clamshell against the same iCloud materialization;
- the migrated Clamshell retains home, IDs, links, assets, trash, and recovery;
- a commit admitted immediately before blur/navigation is included in `flush`;
- the Swift `ArborClient` has already passed the REST fixtures and live-server scenarios owned by `plan.md`;
- `ArbordWorkspaceProvider` and `ClamshellWorkspaceProvider` pass the native provider/session cases for open, enqueue, flush, close, external update, conflict, rename, trash/restore, assets, and recovery;
- an external editor change updates or conflicts without silent loss;
- macOS and iOS exchange deletion intent through sidecars;
- no `.history/` or `Trash/` data leaks into an Arbor shared tree;
- later mounts, overlays, stores, scripts, and sharing require no new editor persistence API.
