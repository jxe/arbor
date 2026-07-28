# Native build plan
*The Swift/Hunch integration track for TreeHopper native. [plan.md](plan.md) owns arbord, REST v1, and both reference protocol clients—including the UI-independent Swift `ArborClient` package. This file owns the adapter from that client into native workspace/editor behavior, plus migration, Clamshell, iCloud compatibility, and native product surfaces.*

**Base REST/client dependency: Satisfied. Shared projection/URL/parity-read dependency: Satisfied. Native provider/app integration: Planned.**

The Foundation-only Swift package now lives at [`native/Packages/ArborClient`](native/Packages/ArborClient) in this repository and passes the shared fixture/live-server conformance runner. No Hunch source, native app target, `WorkspaceProvider`, or editor-session integration has moved here yet. The reserved future layout is `native/App` with native project configuration beside `native/Packages`.

## Founding architecture

TreeHopper native has one browser shell, an editor surface inside it, and two workspace backends:

```text
TreeHopperNativeShell
    │
    ▼
BrowserTabController              history, location, sidebar, chrome, focused commands
    │
    ├── WorkspaceSurface ──▶ document / collection / file / diagnostics
    │          │
    │          └── document ──▶ EditorView + EditorHost
    │
    ▼
WorkspaceProvider                 resolve, browse, search, mutate, recover, observe
    │
    ├── node / children / collection / perform
    │
    └── openDocument ──▶ WorkspaceDocumentSession
                            projected document, managed rows, revisions,
                            synchronous enqueue, flush, close, events
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

`BrowserTabController`, `EditorHost`, and `WorkspaceProvider` answer different questions:

- **`BrowserTabController`** owns a tab's resolved location, back/forward history, parent/home behavior, current heterogeneous surface, sidebar context, and focused browser commands.
- **`EditorHost`** is narrower than Hunch's current host: it handles editor-to-shell behavior such as document/link activation, compatible-document pickers, pasteboard conventions, transcription, and forwarding editor commits. It is not the browser's navigation or storage owner.
- **`WorkspaceProvider`** handles native access to logical workspace capabilities: node references and canonical paths, heterogeneous node snapshots, listing, search, collections, create/move/copy/trash/restore, assets, recovery, and change observation.
- **`WorkspaceDocumentSession`** is optional for nodes with a Markdown/document surface. It bridges a live native `Editor.Document` and its managed-child manifest to the active durability authority.
- **Swift `ArborClient`** is lower-level protocol plumbing from `plan.md`: REST values, requests, mutation retries, SSE, and resync. It knows nothing about editor documents, windows, or Clamshell.

The session is the essential piece. Hunch's editor commit callback is synchronous: once it returns, a following `flush` must already know that the generation exists. A provider offering only async CRUD would leave a false-quiescence race.

Conceptually:

```swift
@MainActor
protocol WorkspaceProvider: AnyObject {
    func node(_ reference: WorkspaceReference) async throws -> WorkspaceNode
    func children(of reference: WorkspaceReference) async throws -> [NodeSummary]
    func collection(_ reference: WorkspaceReference) async throws -> CollectionSnapshot?

    func openDocument(
        _ reference: WorkspaceReference,
        onEvent: @escaping (WorkspaceDocumentEvent) -> Void
    ) async throws -> (any WorkspaceDocumentSession)?

    func resolve(_ reference: WorkspaceReference) async throws -> Resolution
    func search(_ query: WorkspaceQuery) async throws -> [NodeSummary]
    func perform(_ mutation: WorkspaceMutation) async throws -> MutationReceipt
}

@MainActor
protocol WorkspaceDocumentSession: AnyObject {
    var reference: ResolvedWorkspaceReference { get }
    var contentRevision: ContentRevision { get }
    var directoryRevision: DirectoryRevision? { get }
    var document: Document { get }
    var managedChildren: ManagedChildManifest { get }

    func enqueueEditorOps(_ ops: [EditorOp]) -> Task<Void, Error>
    func flush() async throws
    func close() async throws
}
```

`WorkspaceReference` is the native-facing equivalent of REST `NodeRef`: a `tree` scope plus a logical path or durable document `PageID` with a path hint. `tree` is `"local"` for the plain filesystem, a tracked root's `RootID`, `"system"` for the read-only control scope, or later a shared/visited `TreeID` ([spec/arbord-rest.md](spec/arbord-rest.md) §2). Navigation, history, selection, and drag state retain path and ID when available; the ID wins after a move while the path remains the readable current location. It is not a promise that every ordinary file has a stable `NodeID`.

This node-first split is intentional. Hunch currently treats a Clamshell workspace as one level of Markdown pages; Arbor exposes Markdown documents, bodyless directories, collections, databases, scripts, and ordinary files in one logical hierarchy. `openDocument` cannot be the provider's universal read primitive. The Clamshell provider may initially expose only its page-shaped subset, while the arbord provider returns the full node model.

For a directory document, the session composes the stored body with every hydrated immediate child and retains out-of-band `(BlockID, NodeRef, authored/synthetic, kind, materialization)` metadata. Hunch may render its existing subpage row; it does not need a new user-visible block or Markdown link type. Prose/property edits enqueue content generations. Managed-child reorder, move, rename, copy, trash, and restore enqueue structural mutations with `directoryRevision` and explicit anchors. The session never serializes synthetic child rows as if they were authored Markdown.

The exact Swift spelling may evolve, but the invariants may not:

1. local generation admission is synchronous;
2. writes are ordered;
3. `flush` awaits every admitted generation;
4. a successful arbord acknowledgement is the durable mutation receipt defined by REST v1; a successful Clamshell acknowledgement preserves its equivalent log-before-file guarantee;
5. clean external revisions update the existing `Document` without creating authored undo history;
6. conflicts never silently overwrite either side.

## Reference-implementation boundary

This plan implements exactly two native workspace backends: arbord on macOS and Clamshell on iOS or in deliberate arbord-less mode. It does not need a general backend plugin framework.

The Swift `ArborClient` package is an implemented deliverable of [plan.md](plan.md) at [`native/Packages/ArborClient`](native/Packages/ArborClient). This plan:

- imports that package rather than copying its Codable REST values;
- converts protocol snapshots into `Editor.Document` values;
- owns the local pending-generation queue, projected-document mapping, managed-child intent routing, and document-session lifecycle;
- maps protocol errors/events into native presentation and reconciliation;
- never adds native-only fields or lifecycle endpoints to REST.

Generated Swift SDKs, native capability negotiation, and UI for protocol features that arbord does not yet implement may remain absent indefinitely. When a later core milestone introduces mounts, collections, scripts, sharing, or provenance, add only the native surface needed to demonstrate that feature.

## Ownership after the cutover

```text
TreeHopper native                         arbord
─────────────────                        ──────
Editor.Document and native selection     logical paths and durable document identity
editor transactions and undo             authored intent journal and materialization
window navigation and presentation       CAS, idempotency, mutation ordering
local pending-generation queue           watcher classification and external reconciliation
pickers, prompts, pasteboard              search, recovery, trash, assets
native views and WKWebView islands        mounts, overlays, stores, scripts, sync, sharing
```

On iOS, Clamshell implements the right column for the materialized iCloud workspace. Its existing `PageCoordinator` remains private backend machinery: it owns the canonical `Document`, editor attachments, presenters, ordered generations, reconciliation, and transient closed-page leases. It is not part of the standalone Editor package.

Once provider conformance is complete, Clamshell's application-facing API can shrink without affecting editor functionality. `WorkspaceWindow` should not reach around a provider to call Clamshell; any remaining reach-through identifies a missing capability.

## ArborNote parity contract

Feature parity means that TreeHopper native and ArborNote expose the same authored workspace behavior through arbord; it does not require pixel-identical controls or replacing native interaction patterns.

- **Navigation:** filesystem-wide traversal with tracked roots ([spec/browser.md](spec/browser.md) §1) — the launch or default location is a starting point, never a boundary; contextual directory children, parent/back/forward across root boundaries to `/`, home as a preference, per-root search with the client-merged all-roots scope, canonical logical paths, durable-ID move continuity, and relative/rooted/`arbor://` links.
- **Markdown:** the same frontmatter, source-preserving block model, inline Markdown, links, hard breaks, toggles, footnotes, LaTeX, raw fallback, and explicit source view. Native may use its own controls, typography, selection, and accessibility.
- **Directories:** the same body-plus-all-children projection, managed-child identity, authored placement, synthetic fallback rows, structural drag/reorder/rename/trash behavior, and lazy `_index.md`/ID materialization.
- **Workspace operations:** create, move/place, copy, import, assets, trash/restore, recovery, external-change reconciliation, conflicts, and durable flush before navigation or shutdown.
- **Heterogeneous nodes:** useful file metadata/open/preview and collection surfaces rather than forcing non-Markdown nodes through `Editor.Document`.

Core milestone status still applies. Mounts, overlays, scripts/islands, databases, wire sync, and sharing enter native parity only after their platform-neutral behavior exists. Hunch-only strengths such as speech, native menus, and platform integrations may remain additional native capabilities; they do not define a second storage or link contract.

## Post-flat native shell and document model

The current Hunch shell is rooted in one home page: `WorkspaceWindow.path` is `[URL]`, `NavigationStack` destinations are physical URLs, and each destination mounts an `EditorPage`. The Arbor shell must instead be a browser whose current node may or may not have an editor.

Conceptually, each native window/tab owns:

```swift
struct BrowserTabState {
    var history: WorkspaceHistory
    var location: ResolvedWorkspaceReference
    var surface: WorkspaceSurface
    var sidebarContext: ResolvedWorkspaceReference
}

enum WorkspaceSurface {
    case loading(WorkspaceReference)
    case document(any WorkspaceDocumentSession)
    case collection(CollectionSnapshot)
    case file(FilePresentation)
    case diagnostics([WorkspaceDiagnostic])
}
```

The concrete types may differ, but these changes are required:

- Replace `WorkspaceWindow.path: [URL]`, `navigationDestination(for: URL.self)`, and `Document.url` comparisons with `WorkspaceReference`/resolved-reference state. A physical URL is optional provider metadata, never navigation identity. `location` and `sidebarContext` are scope-qualified: parent and breadcrumb chrome traverse above live roots to the filesystem root, and the boundary crumb carries the root's provenance.
- Key editor lifetime by durable `PageID` when present and fall back to logical path only for path-only nodes. A rename updates the displayed path without remounting the document or losing selection/undo.
- Keep at most one active surface per tab, but do not create an editor session for ordinary files or database rows. A directory's projected Markdown surface is a document session; its children also remain available to the shell.
- Keep one provider-level coordinator/write stream per durable document beneath lightweight tab leases. Two tabs may have independent scroll, selection, inspector, and navigation history, but they must not create competing persistence queues for the same document.
- Closing, replacing, or moving a tab's active document flushes every locally admitted generation. An inactive tab may retain a lease; process termination drains the provider, not just the focused editor.
- Reframe home as a starred/default starting location. Going Home changes location; it does not discard the rest of the tree or define reachability.

### Windows, tabs, and navigation chrome

macOS should retain system windows and tabs: each `WindowGroup`/tab gets independent history and surface state over the shared provider. **Open in New Tab** opens the same resolved reference in a new tab lease; **Duplicate Tab** copies location/history presentation but not editor selection or undo UI state. iPad may use `NavigationSplitView`; iPhone keeps a compact stack plus an overlay directory drawer.

The primary chrome becomes browser-like:

- back and forward, plus a distinct parent-directory action;
- a breadcrumb/location control over canonical extensionless logical paths, editable as an Open Location field;
- a contextual sidebar showing the containing directory for a document and the immediate children for a directory document, with disclosure navigation where useful;
- sidebar toggle, search, create, share/provenance when implemented, and an overflow menu for node operations;
- visible save/conflict/materialization/provenance state without exposing physical filenames as the route;
- properties and source/preview toggles only when the active surface supports them.

Home may remain a pleasant toolbar shortcut. The window title should be the node's display title plus useful provenance, not the selected workspace folder or `.md` filename.

### Menus and command routing

Commands route through focused `BrowserTabState`, `WorkspaceProvider`, and—only when applicable—the focused editor:

- **File:** New Document, New Folder, Open Location, Open in New Tab/Window, Import, Close Tab, and Switch/Add Workspace Root.
- **Go:** Back, Forward, Parent, Home, Search Workspace, and recent locations.
- **View:** Toggle Sidebar, Properties, Source/Preview, diagnostics, and collection/file presentation choices.
- **Organize** (or the node section of File): Rename Node, Move, Copy, Move to Trash, Restore, Make Home, Copy Relative Link, Copy Tree-Rooted Link, and Copy Arbor URL when globally nameable.
- **Edit/Format:** preserve Hunch's focused editor undo, block, transcription, and formatting commands; disable them rather than misroute them when a collection or file surface is focused.

`Reload Pages` becomes **Refresh/Resync**; `Search Pages` becomes **Search Workspace**; `Rename File to Match Title` becomes **Rename Node** with “Use Title as Name” as a Markdown-only convenience. “Add Current Page to…” becomes a link-insertion workflow using `WorkspaceReference` and document IDs. “Move Current Page to Trash” becomes the selected/current-node operation and is disabled at protected roots or on read-only mounts.

Removing an ordinary Markdown link is never the same action as trashing its target. Hunch's current orphan/subpage warning remains only as a legacy Clamshell policy. In an Arbor tree every physical node is already placed: backlinks are useful context, but loss of the final inbound link does not make a node orphaned or offer to delete it. A managed child row exposes an explicit **Move Node to Trash** action.

Search becomes heterogeneous and returns kind, path, title, provenance, and materialization state. `@` mentions, Move Blocks to Document, and link pickers may filter that result set to compatible Markdown documents; move/copy destination pickers filter to writable container nodes.

### Lossless Markdown bridge

Hunch's current `Document` cannot be serialized wholesale into arbord without source loss. Arbor blocks have protocol string IDs plus `source`/`sourceHash`; Hunch block IDs are native UUID values and its Clamshell parser normalizes a narrower document.

`WorkspaceDocumentSession` therefore owns a shadow adapter:

- native `BlockID` ↔ Arbor block ID/source-span/source-hash;
- untouched source bytes and YAML order/comments/quoting;
- raw Markdown/HTML fallback and safe H4–H6 fallback;
- inline and display LaTeX, footnote references/definitions, and every ArborNote-supported inline form;
- projected managed-child metadata kept outside the persisted `BlockKind`;
- explicit normalization only for edited blocks.

The adapter's mapping obligations are concrete, not aspirational:

- **Identity mapping is bidirectional and stable for the life of a session.** The adapter owns a table `nativeBlockID (UUID) ↔ (arborBlockID, sourceSpan, sourceHash)`. Arbor block IDs are minted by the parser from source position; the native UUID is minted once at first mapping and survives edits to *other* blocks. An edit to a block invalidates only that block's `sourceHash` entry; the adapter re-derives its Arbor identity from the write receipt, never by re-parsing the whole document.
- **Unedited blocks round-trip byte-identically.** The serialized document is the original source with only edited blocks' spans replaced. If the adapter cannot prove a block untouched (missing `sourceHash` match), it must treat it as edited — normalization is the safe direction; silent byte churn of untouched spans is a defect.
- **Explicitly lossy cases are enumerated, not open-ended.** Permitted losses: (a) Hunch-native block kinds with no Arbor equivalent serialize through the raw-Markdown fallback and may lose Hunch-only interaction affordances (not bytes); (b) whitespace normalization *within an edited block only*; (c) native-only ephemeral state (selection, collapse state, transcription-in-progress) is never persisted. Everything else — YAML order/comments/quoting, H4–H6, footnotes, LaTeX, raw HTML — must survive unchanged.
- **The mapping is testable in isolation.** The shared Markdown corpus (acceptance bar) exercises the adapter as `parse → map → edit one block → serialize → diff`, asserting the diff touches only the edited span.

The existing `.subpage` row can present authored and managed child rows, distinguished by the session manifest. A new persisted link syntax or general `workspaceChild` block is unnecessary. If the editor needs an internal row role for interaction dispatch, it stays adapter metadata and serializes to ordinary Markdown only when the row is authored.

### Native capabilities that still need provider homes

The cutover must retain the useful Hunch behavior that is not just editing:

- per-root subtree Trash and lost/purged recovery, plus per-document filtering; later workspace composition merges multiple roots;
- home/default-location preference;
- backlinks and link insertion, without using home-graph reachability as the workspace ontology;
- asset reads as well as writes/imports;
- voice recording/transcription delivery, emoji/icon selection, pasteboard behavior, drag/drop, quick actions, accessibility, native undo, banners, and conflict UI;
- iCloud `.history/` compatibility and cloud/materialization status.

Use concrete arbord reads/mutations where the capability is workspace truth; otherwise use provider caches derived only from snapshots and events. Hunch must not regain direct macOS filesystem reads beside arbord. Cross-document Hunch workflows—Move Blocks to Document, Create Document from Block, Inline, then Trash—remain ordered crash-safe multi-step workflows because REST v1 deliberately does not mix several content writes with structural mutations. Preserve the current “a crash may leave a duplicate, never data loss” ordering.

## Dependency on the core plan

This track consumes the implemented REST v1 contract, projection/parity reads, and in-repo Swift `ArborClient` package recorded in [`plan-history.md`](plan-history.md). Those platform-neutral dependencies are satisfied: shared projection fixtures, managed-row manifests, logical relative/`arbor://` resolution, lazy identity materialization, backlinks, subtree recovery/Trash, and safe ordinary-file reads. This plan consumes that layer rather than independently recreating it in Hunch. It does not redefine endpoints, Codable transport values, event fields, mutation receipts, durability semantics, or logical workspace operations here.

Provider extraction and the node-first arbord adapter may begin against the completed client now. The macOS cutover still requires implementing and testing the native provider/session/editor mapping; satisfying transport or projection dependencies does not complete Hunch migration or native integration. Later native mounts, collections, scripts, sharing, and provenance begin only when their corresponding core capability exists.

`ArbordWorkspaceProvider` translates `ArborClient` into `WorkspaceProvider` and `WorkspaceDocumentSession`. REST lifecycle and transport design remain owned by `plan.md`; editor lifecycle remains owned here.

## Delivery order

### A. Extract and prove the boundary

1. Introduce the node-first `WorkspaceProvider` and optional `WorkspaceDocumentSession` beside the current APIs.
2. Wrap `Clamshell.PageSession` without changing its durability behavior.
3. Move `WorkspaceWindow`'s storage calls behind the provider; extract browser navigation/chrome into `BrowserTabController` and leave only editor-specific integration in `EditorHost`. Navigation state uses `WorkspaceReference`, never a physical file URL.
4. Run provider conformance cases against Clamshell: node resolution, open document, enqueue, flush, close, external update, conflict, rename, trash/restore, assets, and recovery.

This is complete when native editor functionality no longer depends on the concrete Clamshell API.

### B. Refactor the native shell while Clamshell still works

1. Replace URL navigation with `WorkspaceReference`, resolved history, and `WorkspaceSurface`.
2. Build the sidebar, breadcrumbs/location field, parent/back/forward, home preference, heterogeneous search result model, tabs, and focused command routing from the post-flat shell section.
3. Let `ClamshellWorkspaceProvider` expose its current flat page set as a deliberately limited node tree. Keep all existing editing, speech, icon, menu, recovery, and iCloud behavior working through the provider.
4. Replace home-graph deletion assumptions in shell UI: removing a link never trashes a target unless the user invokes a node operation.
5. Add native shell/provider tests for independent tab history, shared document coordination, rename without remount, close/replace flush, non-document surfaces, command enablement, and home as a start location rather than a root.

This is complete when Hunch's navigation, tabs, search, and menus no longer require physical URLs or assume every surface is a Markdown editor, while the Clamshell-backed product still behaves as before.

### C. Package arbord and prove a read-only Arbor tree

1. Add the Swift `ArborClient` package delivered by `plan.md` as an app dependency without exposing it to the `Editor` package.
2. Package and supervise one macOS arbord authority with readiness, restart/resync, version reporting, safe logs, and clean shutdown. The first spike must prove that the sandboxed app's security-scoped workspace bookmark remains valid for the bundled child process; if sandbox extension inheritance is unreliable, use a signed XPC/helper boundary rather than restoring direct filesystem access in Hunch.
3. Keep the security-scope lease alive for arbord's lifetime and make helper failure a visible reconnect/restart state. Never allow the helper and Clamshell to author the same macOS subtree simultaneously.
4. Implement `ArbordWorkspaceProvider` read-only first: node resolution, children, search, collections, diagnostics, placeholders, ordinary-file metadata/open/preview, events, and resync.
5. Drive the post-flat shell over a representative nested tree before enabling edits. Verify extensionless logical paths, body-plus-directory identity, large listings, and containment.

This is complete when native TreeHopper can browse the same heterogeneous nested tree as TreeHopper web through arbord, survive helper restart, and never reach around the provider to read workspace content.

### D. Adopt arbord editing on macOS

1. Implement the lossless block/source adapter and a local `ArbordDocumentSession` generation queue over `ArborClient.openNodeView` plus the shared projected-directory helper.
2. Map native block IDs to Arbor source identity, implement raw/footnote/LaTeX/frontmatter parity, and normalize only edited blocks.
3. Route prose/properties to content writes and managed rows to structural mutations with domain-specific receipts, revisions, and anchors.
4. Add assets, recursive import, Trash/restore, per-document and subtree recovery, backlinks, home preference, and asset reads to the provider surface.
5. Remove every remaining macOS `workspace.clamshell`/direct-file reach-through for workspace truth. Keep Clamshell only behind the iOS or deliberate arbord-less provider.
6. Preserve Hunch's multi-document workflow ordering, banners, voice transcription, native selection/undo, menus, and interaction behavior.
7. Ensure shutdown, navigation, tabs, and structural actions drain affected sessions before process exit or mutation.

This is complete when TreeHopper native and web can edit the same open document through arbord, derive the same complete directory projection and managed-child identities, and route the same editor gestures to the same content/structural operations without false quiescence, a missed snapshot/event handoff, source churn, or a clobbered external revision. Protocol fixture and transport correctness remain tested in `plan.md`; this plan tests the provider/session/editor mapping.

### E. Migrate the one Clamshell

The known migration is intentionally concrete: one folder of roughly fifty pages, owned by the user.

1. Make a recoverable backup and produce a dry-run inventory.
2. Preserve every six-character `clamshell-id` as the Arbor `id`. During transition, accept both keys; change the key only through the explicit migration.
3. Preserve every document ID and link fragment exactly. Rewrite local destinations to the new logical relative-path rules only when the resolved target is proven, and canonicalize cross-tree destinations to `arbor://`; rename/move continuity comes from the preserved ID plus lazy path healing, not a rename ledger.
4. Import `.clamshell.json`'s home-page pointer into the workspace preference/control record. Keep the legacy file while iOS Clamshell still consumes it.
5. Preserve or manifest-migrate `Trash/`, `Assets/`, and `.history/`.
6. Verify counts, IDs, links, home page, assets, trashed pages, and Recover results before switching the real folder.

`.clamshell.json` currently contains the home-page pointer (and tolerates obsolete unknown keys); it is not the rename tracker. Rename-proof links are supplied by document IDs in frontmatter plus authoritative ID resolution and lazy destination healing. The flat Clamshell page graph is preserved as content; migration does not infer physical Arbor hierarchy merely because one page links to another.

### F. Expand into the whole workspace

With native and web on one authority:

- browse the whole authorized filesystem and large trees — the implemented filesystem-wide navigation model and tracked roots let the native shell adopt scope-qualified references and unclamped parent/breadcrumb chrome rather than inventing its own boundary;
- make home a preference rather than the boundary of the world;
- add Finder-like traversal, history, Quick Look/open actions, drag/import, and whole-workspace search;
- support complete projected directory documents and ordinary non-Markdown files without coercing the latter into editor documents;
- resolve `notes`, `../roadmap`, and `/rooted` references in the current logical tree, and absolute `arbor://` references through arbord mounts/visits while retaining document IDs across moves;
- add local tree placements and derived `system:` views;
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
- document `PageID`s remain stable across moves;
- page history moves with rename/trash/restore;
- `.history/`, `Trash/`, and `.clamshell.json` are hidden from normal browsing/indexing and excluded from shared-tree publication;
- arbord and Clamshell must agree on watermarks, pending peer state, and the distinction between authored purge and external absence.

### Dual-writer conformance requirements

Two independent implementations (Swift Clamshell on iOS, TypeScript arbord on macOS) authoring one `.history/` protocol is the highest-correctness-risk part of this plan. "Agree" above means, concretely, that arbord must reproduce these Clamshell engine invariants (source of truth: `App/Sources/Clamshell/README.md` in the Hunch repo):

1. **Per-(device, page) append-only logs.** arbord writes only its own `<device-id>.jsonl`; foreign logs are read-only inputs. Device IDs are minted and persisted the same way on both sides.
2. **Log-durable-before-file.** The JSONL append for a generation is durable before the corresponding Markdown write. A crash leaves the log at-or-ahead of the file; reconcile heals on next open.
3. **Record vocabulary and ordering.** `add` / `purge` / `observe` records with identical field semantics (`h`, `p`, `m`, `t`, `c`); per-page Lamport counter `c` monotonic per device; records compare on `(c, deviceID)` lex; legacy counterless records ordered as Clamshell orders them.
4. **Observe-vs-add authority.** `observe` never claims authorship: reconcile-synthesized snapshots (merges, external content) emit `observe`, not `add`; classification picks aliveness from authoritative records only, while `observe` still contributes latest-snapshot content.
5. **The mtime gate.** Insert and remove suppression relative to `.md` mtime exactly as the engine specifies (an add older than an externally newer `.md` does not resurrect; a purge older than `.md` mtime does not remove) — this is the authored-purge vs. external-absence distinction.
6. **Watermark compatibility.** arbord may keep its own watermark fast-path state, but that state is private: it must never change what is written to the shared logs, and a foreign implementation with no watermarks must fold to the same result.
7. **Reconcile idempotence.** `reconcile(intent ∪ toAppend, doc′, mdMtime)` is a fixed point on both implementations.

**Gate:** before delivery stage E (migrating the real Clamshell), there must be a shared JSONL conformance fixture suite — the same pattern as the REST protocol fixtures — with `{initial logs, initial md, operations, expected logs, expected md, expected classification}` cases, executed by both the Swift Clamshell engine and the TypeScript arbord implementation, covering: concurrent adds from two devices, purge racing an external edit, observe-only resurrection candidates, legacy counterless records, tail-append after foreign log growth, and crash replay (log ahead of file). The dual-writer design is not considered specified until this suite exists and both implementations pass it.

Only one first-party writer owns a platform at a time: arbord on macOS, Clamshell on iOS. Foreign iCloud delivery is an observed input to that authority. Arbor wire synchronization may be layered above a single arbord relay, but it must not symmetrically replicate the same subtree between devices that iCloud is already replicating.

## Later native surfaces

These build on the early provider rather than introducing new storage paths.

### `system:` and tree placements

TreeHopper renders readable tree placements, `system:connections`, future shares, and diagnostics as native rows/tables/forms backed by arbord operations. The placement source is the path-keyed `~/.arbor/trees.yaml`; other logical `system:` views need not correspond one-for-one to files. Secrets remain in Keychain and appear only as safe credential references. Invalid source edits retain the last valid configuration and surface diagnostics.

### Search and provenance

Cmd+P searches the visible workspace through arbord and later accepts durable document IDs, `arbor://` names/TreeIDs, and invitation input through the same resolver. Compact per-document states remain:

```text
local · untracked · mounted rw · mounted ro · overlay · visited · pinned · stale · conflicted
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
- macOS arbord launch, bookmark access, readiness, crash/restart/resync, logs, and clean shutdown are app-supervised without a second workspace writer;
- each tab has independent reference-based history and presentation state while duplicate opens share one ordered per-document coordination stream;
- back/forward/parent, breadcrumbs/location, contextual sidebar, home, Search Workspace, and focused menus work for documents, directories, collections, ordinary files, placeholders, and diagnostics;
- a commit admitted immediately before blur/navigation is included in `flush`;
- the Swift `ArborClient` has already passed the REST fixtures and live-server scenarios owned by `plan.md`;
- `ArbordWorkspaceProvider` and `ClamshellWorkspaceProvider` pass the native provider/session cases for node resolution, optional document open, enqueue, flush, close, external update, conflict, rename, trash/restore, assets, and recovery;
- web and native produce the same body-plus-children projection and managed-child manifest from shared fixtures, including a bodyless directory and more than one child page;
- the shared Markdown corpus proves untouched source/frontmatter preservation plus raw fallback, H4–H6 fallback, footnotes, LaTeX, inline formatting, and edited-block-only normalization;
- native relative links keep the same target before and after body materialization, and a stale path plus valid document ID follows a rename/move and heals;
- deleting the last ordinary link never offers to trash an Arbor node; managed-node trash is always an explicit structural action;
- speech/transcription, emoji/icon selection, drag/drop, pasteboard, quick actions, native undo/accessibility, recovery, banners, and conflict presentation still work through provider-backed state;
- an external editor change updates or conflicts without silent loss;
- macOS and iOS exchange deletion intent through sidecars;
- no `.history/` or `Trash/` data leaks into an Arbor shared tree;
- later mounts, overlays, stores, scripts, and sharing require no new editor persistence API.
