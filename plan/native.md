# TreeHopper native plan
*Canonical product and architecture plan for the new Swift browser. Detailed executor handoffs live in [`advisor-plans/`](../advisor-plans/README.md); implemented platform-neutral evidence lives in [`history.md`](history.md).*

## Status

- Arbor's exact-source and provider-owned complete-directory foundation is implemented.
- The matching local Quagmire/Hunch boundary is the remaining half of Plan 000 and must land in `/Users/joe/src/hunch` before publication.
- Quagmire's first public release is therefore the intended neutral `0.1.0`; there is no public Hunch-specific 0.1 followed by an immediate corrective 0.2.
- The new app, working name **TreeHopper**, has not been scaffolded. The name and reverse-DNS identifiers remain an explicit founding decision before signed builds or persisted app identity.

Execution order:

1. [000 — Arbor and Quagmire foundations](../advisor-plans/000-finalize-arbor-and-quagmire-foundations.md) (Arbor complete; Hunch/Quagmire pending)
2. [001 — publish Quagmire 0.1](../advisor-plans/001-publish-quagmire.md)
3. [002 — found TreeHopper native](../advisor-plans/002-found-treehopper-native.md)
4. [003 — bridge Quagmire to Arbor](../advisor-plans/003-bridge-quagmire-to-arbor.md)
5. [004 — Arbor cloud durability](../advisor-plans/004-build-arbor-cloud-durability.md)
6. [005 — native parity and migration](../advisor-plans/005-complete-native-parity-and-migration.md)

## Product boundary

TreeHopper is a new, parallel Swift browser, not a renamed Hunch target. It reuses Quagmire as its editor and carries forward Hunch's good native interactions, durability expectations, and platform integrations without inheriting Hunch's flat page graph, bundle identity, URL-keyed navigation, or Clamshell-specific storage model.

The browser is node-first because an Arbor location may be a Markdown document, a bodyless directory, a directory document, a collection, a database, an ordinary file, a diagnostic surface, or a historical/read-only view. “Node-first” means navigation and provider APIs resolve that heterogeneous node before deciding whether an editor session exists; it does not mean the UI should foreground storage nodes over documents.

Working package/product names:

- app/display/scheme: `TreeHopper`;
- app module: `TreeHopperApp`;
- local application package: `TreeHopperKit`;
- private Quagmire host target: `TreeHopperQuagmire`;
- existing transport package: `ArborClient`;
- external editor package: `Quagmire`.

Do not reuse Hunch bundle IDs, app groups, defaults, caches, or iCloud containers. Keep reverse-DNS identifiers and entitlements in build settings, not source constants.

## Architecture

```text
TreeHopperApp
  ├─ BrowserTabController       history, location, sidebar, chrome, commands
  ├─ WorkspaceSurface          document / collection / file / diagnostics
  ├─ TreeHopperKit
  │    ├─ WorkspaceReference / WorkspaceNode
  │    ├─ WorkspaceCoordinator + document leases
  │    ├─ ArbordWorkspaceProvider ─ ArborClient ─ arbord (macOS)
  │    └─ ArborCloudWorkspaceProvider (iOS / deliberate direct mode)
  └─ TreeHopperQuagmire
       ├─ Markdown codec + private source ledger
       ├─ EditorHost implementation
       └─ Quagmire
```

Keep exactly two concrete persistence providers. Do not build a backend plugin framework.

On macOS, arbord is the sole first-party writer for an arbord-backed subtree. On iOS, or in a deliberate arbord-less mode, the Swift cloud provider is the first-party writer. Never let both author the same macOS subtree, and never layer symmetric Arbor wire replication over the same mutable iCloud subtree.

### Browser and references

Each tab owns independent navigation history, selection, scroll position, inspector state, and presentation. A shared `WorkspaceCoordinator` owns one ordered document session/write stream per durable `(tree, PageID)`, falling back to `(tree, path)` only when no ID exists. Several tabs may lease that session without creating competing persistence queues.

`WorkspaceReference` is the native equivalent of REST `NodeRef`: explicit tree scope plus a logical path, or a durable opaque PageID with path hint. A physical file URL is optional provider metadata, never navigation identity. Rename/move updates the visible path without remounting a PageID-backed editor or losing its authored undo state.

Home is a starred/default starting location, not a reachability boundary. Back, Forward, Parent, breadcrumbs, Open Location, search, and sidebar navigation traverse the resolved Arbor hierarchy and retain provenance across tree boundaries.

### Provider and session contracts

The provider owns node resolution, children, search, collections, files, structural mutations, assets, recovery, and observation. It opens a document session only for a Markdown-capable surface.

The session owns:

- the current resolved reference;
- arbord/provider `document.source` and `contentRevision`;
- one live Quagmire `Document`;
- the private source ledger and semantic baseline;
- synchronous admission of authored editor generations;
- ordered exact-source writes, conflict/resync, external replacement, `flush`, and close.

Quagmire's commit callback is synchronous. Before it returns, the generation must already be admitted to the session queue so an immediately following `flush` cannot falsely report quiescence. `flush` awaits every admitted generation. Clean external snapshots replace the same live `Document` as a system change without authored undo; conflicts never silently overwrite either side.

## Implemented Arbor document contract

Arbor's authored content primitive is:

```text
writeMarkdown { ref, baseContentRevision, source }
```

`source` is exact complete Markdown including frontmatter. Parsed blocks/frontmatter are provider-derived read conveniences, never client-authored wire truth. Arbord parses source internally for validation, indexing, search, backlinks, recovery, rendering, hosted Markdown/HTML, and subsequent reads. Ordinary stored Markdown persists accepted bytes exactly.

Every physical directory has one provider-owned operational Markdown document:

1. the first eligible standalone link resolving to each immediate physical child represents that child at its authored location;
2. inline links do not qualify, and later standalone duplicates remain ordinary links;
3. the provider appends ordinary links for unmatched children in unsigned UTF-8 canonical-path order;
4. reads do not materialize a body; the first authored write persists the accepted complete source;
5. the directory content revision covers exact stored bytes plus canonical immediate-child descriptors.

The current provider contract omits collection records, including physical Markdown row files and virtual/query-backed rows, from that About/index document. This exception and the exact removal path are recorded in [`technical-debt.md`](technical-debt.md); native code must not independently cement a different rule.

Link order, nesting, label, and deletion are content edits. Physical create, move, rename, copy, Trash, and restore are structural operations. There is no synthetic-row mutation boundary, managed manifest, block anchor, or second index-ordering API.

## Quagmire 0.1 boundary

Quagmire and Hunch change together while the package is still local. The first public package must provide:

- one neutral `documentLink` row with an authored attributed label and opaque host-defined reference;
- ephemeral host presentation for target title/icon, present/missing/unavailable state, and the row's fixed supported actions;
- the existing contextual mention rule: line-leading mention creates `documentLink`; inline mention creates an inline link;
- H1–H6 representation without clamping, while creation menus may remain H1–H3;
- one read-only opaque raw/unsupported block so a host can preserve constructs it cannot represent structurally;
- a specified stable `BlockID` lifecycle across edit, move, nesting, undo, split, merge, paste, duplicate, copy, and cross-document operations;
- synchronous commit notification and async flush semantics.

Quagmire remains format-neutral. It must not contain Arbor types, Markdown parsing, a source snapshot, byte ranges, opaque source handles, persisted block annotations, or a generic metadata bag. Stable editor identity is the reusable capability.

Hunch must reproduce every current subpage-row interaction through `documentLink`: navigation, missing state, resolved title/icon, create/convert, orphan prompt, inline-then-Trash, drop move/copy, move-to picker, mentions, link copy/paste, commit, and flush. Preserve duplicate-over-loss ordering: create destination before replacing source; load before inline mutation; durably append destination before removing a moved source; flush the inlined parent before Trash.

## TreeHopper Quagmire host

There is no `ArborDocumentAdapter` or second canonical document model. `TreeHopperQuagmire` is a thin host containing:

- a Markdown-to-Quagmire codec;
- a private source-reuse ledger keyed by stable Quagmire `BlockID`;
- an `EditorHost` implementation over `WorkspaceDocumentSession`;
- reference/action resolution for document links.

The ledger record is host-private and may contain whatever parser-specific source record is useful. Quagmire only guarantees stable IDs. On serialization, the host compares a current semantic block with its baseline: unchanged compatible blocks reuse exact source, while edited/new blocks regenerate in isolation. YAML order/comments/quoting, raw blocks, H4–H6, footnotes, LaTeX, HTML, and unedited delimiters must survive. Whitespace may normalize only inside an edited structured block.

After a successful provider response, the returned exact accepted source and revision become the next base, and the host rebuilds/reconciles its private ledger without creating authored undo.

### Document links, mentions, and actions

Provider search supplies compatible Markdown or directory-document candidates with title, parent path, and provenance for disambiguation.

- Inline mention selection inserts an ordinary canonical Markdown link.
- Line-leading mention selection inserts the one standalone `documentLink` row.
- Tree-local links are relative; cross-tree links use `arbor://`; include the target PageID fragment when available.
- The first standalone link resolving to an immediate Markdown child is eligible for the full child action set when authority permits. Other standalone links retain all actions that make sense for their resolved Markdown target.
- Deleting a link deletes only source. **Move Node to Trash** is a separate provider operation.
- Turn Into Document/Create from Block durably creates/copies the target before replacing/removing the source. A crash may leave a recoverable duplicate, never lose the only copy.
- Inline then Trash writes and flushes the parent first, then trashes the target.
- Cross-document move/copy admits and durably appends the destination before source removal.
- If an action is unavailable for target kind, authority, materialization, or provider capability, omit or visibly interrupt it before its first source mutation.

## Hunch parity and intentional differences

TreeHopper should carry forward Hunch behavior where the Arbor model permits it:

- block editing, selection/reorder, undo/redo, mentions, document conversion, drag/drop, pasteboard, images/assets, emoji/icons, speech/transcription, native menus/commands, search, backlinks, recovery, conflicts, accessibility, and durable flush on navigation/shutdown;
- target-title/icon presentation and every document-link action for Markdown or provider-completed directory Markdown;
- native windows/tabs on macOS and appropriate split/compact navigation on iPad/iPhone.

Intentional interruptions:

- ordinary link deletion never triggers Hunch's orphan-and-trash policy in an Arbor tree;
- actions requiring a Markdown/document target are absent for ordinary files, database rows, and incompatible virtual nodes;
- read-only, historical, unavailable, or cross-authority targets expose only permitted actions;
- non-document surfaces disable editor commands rather than coercing data into a page model.

## iCloud durability

Preserve Hunch-grade semantics, not the exact `.history/*.jsonl` representation. The new private, versioned Arbor cloud journal lives in a reserved sidecar namespace such as `.arbor/icloud/v1/`, is synchronized by iCloud for this provider, and is excluded from ordinary browsing, indexing, publication, Arbor wire objects, assets, and authored snapshots.

Required semantics:

- durable PageID is identity; mutable path is metadata/hint;
- each device writes only its own append-only stream with monotonic counter and deterministic `(counter, deviceID)` order;
- records cover content/add, observe, move/place, Trash/purge, restore, base/result hashes, and enough recoverable content;
- a local authored log record is durable before materialized Markdown;
- fold/replay is idempotent; local indexes/watermarks are rebuildable and stay outside iCloud;
- log-ahead-of-file replays after crash; file-ahead/external edits become observe records and never falsely claim authorship;
- missing live content with an unsuperseded durable add is recoverable regardless of modification-time ordering; timestamps may help classify tombstoned removals but never suppress valid add recovery;
- conflicts preserve both recoverable versions and surface UI instead of last-writer clobber;
- iOS coordinates file access and materialization with `NSFileCoordinator`, `NSFilePresenter`, ubiquitous-item state, and conflict versions rather than treating modification time as synchronization success.

The format must have one language-neutral fixture corpus and two independent folds: Swift for the direct cloud provider and TypeScript/arbord for compatibility, migration, or diagnostics. Test placeholders, delayed downloads, offline concurrent edits, clock skew, log/file crash boundaries, rename, move, Trash, restore, purge versus external edit, and deterministic convergence.

Legacy Hunch `.history/` is read only by an importer/recovery tool. After cutover, TreeHopper writes only the new format. Inventory and back up first; preserve PageIDs, links, assets, Trash, and home; verify before switching; never let Hunch and TreeHopper coauthor the same folder.

## Release gates

The detailed gates are in the numbered plans. The final native release requires, at minimum:

- Quagmire package verification and remote SwiftPM resource/API consumption;
- standalone `ArborClient` and `TreeHopperKit` tests;
- exact-source/complete-directory cross-language fixtures;
- sequential macOS and iOS 27 builds/tests;
- simultaneous web/native editing through arbord without source churn, missed event gaps, false quiescence, or silent overwrite;
- two-device/offline cloud convergence and crash/recovery fixtures in Swift and TypeScript;
- an actual Hunch-workspace dry run followed by a separately authorized cutover;
- manual accessibility, keyboard, pointer, drag/drop, menus, transcription, conflict, and recovery smoke on exact release artifacts.

STOP rather than improvise if the signed helper/security-scoped bookmark model cannot give arbord required access, if a provider cannot produce a bounded gap-free child snapshot for complete source, if Quagmire identity remints during an in-place edit, if either writer cannot satisfy log-before-file, or if both providers could author the same subtree.
