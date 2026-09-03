# Plan 002: Freeze identity and found the new TreeHopper app

> **Final status: REJECTED — superseded by Plans 006–019.** The accepted product is Arbor and cross-device sync uses revisioned Arbor wire, not the provider design below. Preserve this file as historical evidence; do not execute it.

> **Executor instructions**: Build a new Arbor product. Do not copy or rename the
> Hunch app target. Keep the first end-to-end slice read-only except for an
> in-memory fake. Run macOS and iOS Xcode commands sequentially. Update this
> plan's row in `plans/native/execution.md` when complete.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat 05bcf35..HEAD -- \
>   README.md plans/native/README.md plans/hardening/technical-debt.md docs/client.md \
>   native docs/client.md spec/02-directory-format.md spec/03-locators.md docs/arbord-api.md \
>   package.json tests/protocol
> ```
>
> Stop if Plan 001 is incomplete, the implemented exact-source foundation is no
> longer present, or the native app/package topology or Swift client protocol
> surface has materially changed from the contracts below.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/native/001-publish-quagmire.md`
- **Category**: direction
- **Planned at**: Arbor `84fc705`, 2026-08-18
- **Reconciled**: 2026-08-19 after foundation completion

## Why this matters

The canonical `plans/native/README.md` now describes a parallel native TreeHopper whose
primary object is an Arbor node and whose editor is only one possible surface.
Freezing identity, provider ownership, and session lifetime before editor
persistence prevents Hunch defaults, file URLs, flat-page assumptions, or a
second storage authority from becoming the new app's foundation.

## Current state

- `README.md` defines Arbor's document topology and names TreeHopper as the
  web/native browser, while explicitly calling all product names provisional.
- `plans/native/README.md` contains the correct high-level split: browser
  tab, heterogeneous surface, provider, optional document session, arbord on
  macOS, and direct file/iCloud storage on iOS.
- `plans/native/README.md` requires synchronous generation admission, ordered
  writes, flush of every admitted generation, clean external replacement, and
  explicit conflicts. Preserve these invariants.
- `native/Packages/ArborClient/Package.swift:1-17` is a Foundation-only Swift 6
  package targeting iOS/macOS 26. It already builds and passes its protocol
  fixtures.
- The implemented foundation removed the Swift client projection surface.
  `NodeSnapshot.document.source` is authoritative complete provider-owned
  Markdown; writes use exact `source` plus `baseContentRevision`; logical URLs
  accept opaque non-empty PageID fragments. Treat these as verified inputs, not
  work for this plan.
- `docs/client.md:6-30` says arbord is the macOS authority, clients retain full
  resolved tree/path/PageID provenance, untouched Markdown is byte-preserved,
  and snapshot observation must not have a gap.
- Hunch's bundle IDs, target names, defaults, Application Support directories,
  logging subsystem, and bookmarks are Hunch-specific. None are reusable
  persistence identity.

## Target architecture

```text
TreeHopperApp
  SwiftUI windows/tabs, commands, browser chrome, platform integrations
        │
        ▼
TreeHopperKit
  WorkspaceReference / WorkspaceNode / WorkspaceSurface
  BrowserTabController / WorkspaceCoordinator
  WorkspaceProvider / WorkspaceDocumentSession
        │
        ├── ArbordWorkspaceProvider ── ArborClient ── arbord (macOS)
        └── ArborCloudWorkspaceProvider (iOS/direct mode; Plan 004)

TreeHopperQuagmire (Plan 003)
  private Markdown codec/source ledger, references, thin EditorHost
        │
        ▼
Quagmire (remote package)
```

`WorkspaceCoordinator` owns one canonical document/session and ordered write
stream per `(tree scope, PageID)`; use a canonical path fallback only while a
node genuinely lacks durable identity. Tabs own independent history, selection,
scroll, and inspector state through lightweight leases. `BrowserTabController`
never owns persistence.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Swift client | `swift test --package-path native/Packages/ArborClient` | 10 tests pass; live-server test may skip when no URL is set |
| Protocol conformance | `bun run test:protocol` | 8 fixture tests and 10 live Swift tests pass |
| Generate native project | `xcodegen generate --spec native/project.yml --project native` | exit 0; tracked project matches YAML |
| Kit tests | `swift test --package-path native/Packages/TreeHopperKit` | all tests pass |
| macOS build | `xcodebuild build -project native/TreeHopper.xcodeproj -scheme TreeHopper -destination 'platform=macOS' -derivedDataPath /tmp/treehopper-foundation-macos CODE_SIGNING_ALLOWED=NO` | exit 0 |
| iOS build | `xcodebuild build-for-testing -project native/TreeHopper.xcodeproj -scheme TreeHopper -destination 'platform=iOS Simulator,id=C76DE979-27D7-4BE5-AD11-3FC223402AB9' -derivedDataPath /tmp/treehopper-foundation-ios CODE_SIGNING_ALLOWED=NO` | exit 0 on the existing iOS 27 simulator |
| Root checks | `bun run typecheck && bun test && bun run build` | each exits 0 |
| Diff check | `git diff --check` | no output |

Do not run the two Xcode builds in parallel.

## Scope

**In scope**:

- `plans/native/README.md`, plus references in `README.md` and
  `docs/reference-implementation.md` needed to reflect the new-app direction.
- `native/project.yml`, generated `native/TreeHopper.xcodeproj`, `native/App/`.
- `native/Packages/TreeHopperKit/`.
- Read-only `ArborClient` consumption needed by the new provider; protocol,
  projection, and exact-source redesign are out of scope.
- A supervised, read-only arbord connection on macOS.

**Out of scope**:

- Quagmire source changes, Markdown serialization, authored editor mutations,
  iCloud journaling, Hunch import, voice, and full product parity.
- Direct macOS reads of workspace truth beside arbord.
- General provider/plugin discovery or universal capability negotiation.
- Production packaging, App Store signing, or a final icon.

## Git workflow

- Branch: `codex/treehopper-native-foundation` unless the operator specifies
  another branch.
- Prefer one commit for Swift-client conformance and one for the app foundation.
- Match the repo's short imperative commit style.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Freeze names and confirm the canonical native plan

Use this working identity unless Joe changes it before execution:

| Surface | Working value |
|---|---|
| Product/display/scheme | `TreeHopper` |
| App module | `TreeHopperApp` |
| Shared package | `TreeHopperKit` |
| Editor adapter target | `TreeHopperQuagmire` |
| Transport package | `ArborClient` (unchanged) |
| Bundle ID | `org.nxhx.Arbor.TreeHopper` |
| Unit/UI test IDs | bundle ID + `.unittests` / `.uitests` |
| App Support root | `Application Support/Arbor/TreeHopper` |
| Logger subsystem | app bundle ID |
| URL scheme | `arbor` |
| App deployment target | iOS 27 / macOS 27 |

Keep Quagmire's own minimum platforms unchanged. Keep bundle IDs, defaults keys,
app-support paths, and future container identifiers in build/configuration code,
not scattered string literals.

Confirm `plans/native/README.md` continues to say:

- TreeHopper is a new app in this repository, not a Hunch cutover.
- Hunch remains a behavior oracle and Quagmire integration client.
- The direct iCloud provider uses a new Arbor journal from Plan 004.
- Hunch migration is an explicit import/copy operation, not shared live state.
- Implemented, planned, and later sections remain visibly distinct.

**Verify**:

```sh
rg -n 'Hunch integration track|change Hunch|rename Hunch' plans/native/README.md
rg -n 'TreeHopperApp|TreeHopperKit|new app|parallel' plans/native/README.md
```

Expected: the first search has no active-plan matches; the second identifies the
new product boundary and topology.

### Step 2: Scaffold the new app and package graph

Create `native/project.yml` as the source of truth and a tracked generated
project. Create a multiplatform app target, macOS unit tests, and iOS UI/test
targets using the names above. Depend on the exact remote Quagmire 0.1.0 from
Plan 001 and the local `ArborClient` package.

Create `TreeHopperKit` with only the shared types needed now:

- `WorkspaceReference` and `ResolvedWorkspaceReference` retaining tree, path,
  PageID, access/provenance, and historical/read-only state;
- `WorkspaceNode`, `NodeSummary`, and `WorkspaceSurface` for document,
  directory, collection, ordinary file, placeholder, and diagnostics;
- `WorkspaceProvider`, optional `WorkspaceDocumentSession`, and provider events;
- `WorkspaceCoordinator` and tab leases;
- an `InMemoryWorkspaceProvider` used by tests and previews.

Do not make `openDocument` the universal read primitive. Under the implemented
provider contract, every directory-backed node exposes a complete directory
document even without a stored body. A directory-backed collection may
therefore expose a separate About/index document session while its grid remains
the primary collection surface; its rows and virtual tables do not enter that document. An ordinary
file, virtual database container, or collection row has no document session
merely because it is browsable.

**Verify**: generate the project, run `TreeHopperKit` tests, and build both
platform targets. Expected: the app displays a fixture tree from the in-memory
provider without filesystem or network access.

### Step 3: Prove session and tab ownership before persistence

Implement fake/in-memory session behavior with:

- synchronous admission of an incrementing generation;
- ordered async completion;
- `flush` awaiting every admitted generation;
- one canonical document stream shared by duplicate tabs;
- independent tab history/selection/scroll presentation;
- PageID-keyed identity surviving path rename;
- external replacement of the same model without authored undo;
- terminal provider drain.

Model tests after Hunch's `PageCoordinatorTests`: immediate enqueue/flush race,
coalescing with retained intent, duplicate editor/transient leases, drain after
an unawaited final edit, and an external update racing a local generation.

**Verify**: `swift test --package-path native/Packages/TreeHopperKit` passes all
new lifecycle tests deterministically without sleeps.

### Step 4: Build the node browser shell over the fake provider

Implement one active `WorkspaceSurface` per tab; back, forward, parent, Home as
a preference, breadcrumbs/open-location, contextual sidebar, search, and
focused command routing. Disable editor commands on non-document surfaces.

The shell must show nested directories, bodyless folders, Markdown nodes,
ordinary files, collections, placeholders, and diagnostics. The visible path is
not identity. Rename/move events update chrome without replacing the tab or its
document lease.

**Verify**: unit tests cover independent tab histories, duplicate tab leases,
rename without remount, Home not constraining reachability, and command
enablement by surface. Both platform builds pass.

### Step 5: Prove a read-only arbord-backed macOS slice

Package/supervise one arbord process with readiness, version reporting,
restart/resync, bounded safe logs, and clean shutdown. Prove whether the
sandboxed app's security-scoped workspace bookmark remains valid for the child
process. If not, stop and design a signed XPC/helper boundary; never restore
direct workspace reads in the app.

Implement read-only node, children, search, collection, ordinary-file metadata,
placeholder, diagnostics, events, and resync through `ArborClient`. Preserve the
snapshot/observation handoff: events invalidate; confirmed reads supply state.

**Verify**: browse a representative nested fixture through arbord, restart the
helper, and confirm the same resolved location/document returns without any
direct app filesystem read. Run protocol, kit, macOS, and root gates.

## Test plan

- Extend shared protocol fixtures for opaque PageIDs and retained tree scope.
- Add pure `TreeHopperKit` tests for resolution, surface selection, tab history,
  shared coordination, rename identity, synchronous admission, flush, and drain.
- Add an arbord process harness using a temporary fixture root; no real user tree.
- Add one app-level smoke test that opens document, folder, file, collection,
  placeholder, and diagnostic fixture nodes.

## Done criteria

- [ ] Canonical docs describe a new parallel TreeHopper app.
- [ ] Product, package, module, bundle, cache/defaults, and logging identities
      contain no accidental Hunch identity.
- [ ] Swift/TypeScript agree on opaque PageIDs and retained tree scope; no new
      native API revives the removed client-side projection.
- [ ] Swift exposes authoritative exact source and source-plus-base-revision
      writes; no native authored mutation accepts parsed blocks.
- [ ] The generated project builds sequentially for macOS and iOS 27.
- [ ] The in-memory browser handles every baseline node surface.
- [ ] Duplicate tabs share one coordination stream but keep independent UI state.
- [ ] A read-only macOS tree is browsed solely through supervised arbord.
- [ ] Helper restart/resync is visible and recoverable.
- [ ] Root, Swift, Xcode, and diff gates pass.
- [ ] `plans/native/execution.md` marks Plan 002 DONE.

## STOP conditions

- Joe rejects the working TreeHopper name or identifier prefix before they are
  persisted in signed builds.
- Plan 001 is incomplete or the published 0.1.0 differs from the proven local
  Quagmire/Hunch foundation.
- Quagmire 0.1.0 is not remotely resolvable with resources.
- A correct read-only arbord slice requires the app to read workspace truth
  directly.
- Bookmark access cannot be proven for the helper; stop for an XPC/helper design.
- Any provider API assumes every node is a Markdown document.
- A session is keyed only by path when a PageID is available.

## Maintenance notes

Keep `TreeHopperKit` small. `TreeHopperQuagmire` is a separate target in Plan
003 because source mapping and editor interaction should not leak into browser
or provider protocols. Plan 004 adds the only second provider; that concrete
need, not speculative extensibility, justifies the shared provider interface.
