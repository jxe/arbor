# Plan 012: Found the native Arbor shell

> **Executor instructions**: Scaffold the product and UI-independent contracts over a deterministic fake provider. Do not add real persistence, networking, Quagmire, voice, or Hunch code. Generate the Xcode project from YAML and run macOS/iOS commands sequentially.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- native plan/native/README.md docs spec/client.md package.json`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plan 006
- **Category**: direction/architecture
- **Planned at**: Arbor `dc34126`, 2026-08-23
- **Reconciled at**: clean Arbor `0c53964`, 2026-08-24
- **Completed**: 2026-08-24

## Why this matters

The app must be node-first before an editor or storage engine can pull it toward Hunch's flat page model. A fake-provider foundation fixes identity, tab/session ownership, heterogeneous surfaces, and product persistence keys without coupling them to wire or filesystem implementation.

## Starting state at reconciliation

- `native/Packages/ArborClient` was Foundation-only and targeted iOS/macOS 26 as a reusable library; no app project or ArborKit existed.
- Current native plans reserve a new app rather than renaming Hunch.
- The accepted identity is display/product/scheme `Arbor`, module `ArborApp`, bundle `org.nxhx.Arbor`, iOS/macOS 27.
- Authority sync, arbord integration, device pairing, and the Railway migration are complete. They do not change this milestone's fake-provider boundary.
- XcodeGen 2.45.4 and the specified iOS 27 simulator `C76DE979-27D7-4BE5-AD11-3FC223402AB9` are available.

## Target packages and interfaces

- `ArborApp`: SwiftUI scenes, commands, browser chrome, platform presentation.
- `ArborKit`: `WorkspaceReference`, `WorkspaceNode`, `WorkspaceSurface`, `WorkspaceProvider`, optional `WorkspaceDocumentSession`, `WorkspaceCoordinator`, `BrowserTabController`.
- `WorkspaceReference` carries tree scope plus logical path, or PageID plus path hint. Physical URL is optional provider metadata only.
- `WorkspaceCoordinator` owns one canonical session/write stream per `(tree, PageID)`, with path fallback only when identity is absent. Tabs lease it while retaining independent history/selection/scroll/inspector state.

## Scope

**In scope**: `native/project.yml`, generated `native/Arbor.xcodeproj`, app shell/resources, ArborKit package/tests, deterministic fake provider, docs status.

**Out of scope**: ArborClient integration, wire, local disk storage, sync, Quagmire/editor, Hunch feature ports, signing/release.

## Steps

1. Create generated-project configuration and product identity. Keep bundle/entitlement values in build settings, not source constants.
2. Define small Sendable/actor-safe ArborKit contracts for resolution, children, search, backlinks, files, structural actions, assets, history/recovery, document admission/flush/conflict/close.
3. Implement tab/navigation models: Home preference, back/forward, parent, breadcrumbs/open-location, contextual sidebar, provenance, command enablement.
4. Build surfaces for Markdown-capable node, bodyless directory, ordinary file, collection, placeholder, diagnostic, and historical read-only state.
5. Build a deterministic in-memory provider exercising all node/surface/authority/materialization cases; do not create a generic backend plugin registry.
6. Add app smoke tests and package lifecycle tests.

## Verification

```sh
xcodegen generate --spec native/project.yml --project native
swift test --package-path native/Packages/ArborKit
xcodebuild build -project native/Arbor.xcodeproj -scheme Arbor -destination 'platform=macOS' -derivedDataPath /tmp/arbor-foundation-macos CODE_SIGNING_ALLOWED=NO
xcodebuild build-for-testing -project native/Arbor.xcodeproj -scheme Arbor -destination 'platform=iOS Simulator,id=C76DE979-27D7-4BE5-AD11-3FC223402AB9' -derivedDataPath /tmp/arbor-foundation-ios CODE_SIGNING_ALLOWED=NO
git diff --check
```

Expected: sequential commands exit 0; no deprecated or Hunch persisted identity; ArborKit tests deterministically cover duplicate leases, rename-by-PageID, independent tab state, and non-document commands.

Completed evidence: XcodeGen 2.45.4 generated `native/Arbor.xcodeproj`; all six ArborKit tests, both ArborApp smoke tests, the macOS build, and the specified iOS 27 build-for-testing passed sequentially on 2026-08-24. The app owns only the accepted Arbor identity, and the deterministic provider remains isolated from persistence, transport, and editor implementations.

## STOP conditions

- A file URL becomes navigation/session identity.
- `BrowserTabController` must own persistence.
- ArborKit would need SwiftUI, Quagmire, ArborClient, or a concrete backend dependency.
- The existing iOS 27 simulator is unavailable; report rather than create/use another simulator silently.

## Maintenance note

Keep ArborKit small and behavior-oriented. Plans 013–016 supply concrete transport/storage/editor packages behind these contracts.
