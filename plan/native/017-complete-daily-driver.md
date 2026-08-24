# Plan 017: Complete the native daily-driver core

> **Executor instructions**: Integrate completed providers/editor into ordinary note workflows. Preserve identical document semantics across macOS arbord and iOS replica. Do not port voice/polish/final Hunch parity or convert real data.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- native packages/client packages/arbord spec/client.md docs plan/native tests`

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 015 and 016
- **Category**: product/integration
- **Planned at**: Arbor `dc34126`, 2026-08-23

## Why this matters

Completed components are not yet a daily driver. This milestone joins macOS arbord, iOS replica, ArborKit navigation, and Quagmire into the safe core required before native polish or personal cutover.

## Provider integration

- Implement `ArbordWorkspaceProvider` using the existing Foundation-only ArborClient; macOS never writes an arbord-backed tree directly.
- Use `ReplicaWorkspaceProvider` on iOS; do not add a generic plugin/backend registry.
- Run one provider contract suite against fake, arbord, and replica implementations.

## Daily-driver capability

- Open/create/edit Markdown and complete directory documents.
- Home, sidebar, back/forward/parent/breadcrumb/open-location, search, links/mentions, backlinks.
- Rename/move/copy, document conversion/append/inline, asset/image import, Trash/restore.
- Local Recover, synchronized accepted-root history, restore-as-new-local-change, conflict draft comparison/resolution.
- Source/properties inspection, save/sync/error state, terminal flush.
- Multiple tabs/windows sharing one PageID session but independent presentation.
- Honest read-only/history/ordinary-file/collection/placeholder/diagnostic surfaces.
- Native menus/commands and basic accessibility for every core action.

## Scope

**In scope**: ArborApp surfaces/state, macOS provider/supervision, ArborKit integrations/tests, focused ArborClient consumption changes.

**Out of scope**: voice/transcription/polish, final typography/feedback, link-preview cache, broad community/access admin, mutable collection UI, scripts/agents, real Hunch workspace.

## Steps

1. Implement/supervise arbord with readiness, version, safe logs, restart/resync, shutdown, and security-scoped workspace access. STOP for a signed helper/XPC design if sandbox inheritance fails; never restore direct reads.
2. Finish node/file/search/backlink/history/recovery/action surfaces and provider capability gating.
3. Integrate Quagmire sessions and crash-safe reference actions on both providers.
4. Implement tabs/windows, command routing, lifecycle drains, sync/conflict/history presentation, and accessible status/errors.
5. Add provider-contract and app/UI tests, then manual exact-artifact checks on isolated fixtures.

## Verification

```sh
swift test --package-path native/Packages/ArborClient
swift test --package-path native/Packages/ArborKit
swift test --package-path native/Packages/ArborReplica
swift test --package-path native/Packages/ArborQuagmire
bun run test:protocol
bun run typecheck
bun test
```

Then run sequential macOS/iOS 27 Xcode tests/builds and `git diff --check`. Expected: provider contract passes unchanged on all three providers; a final edit immediately before navigation/termination is locally durable; non-document/read-only surfaces never execute editor mutations.

## Done criteria

- [ ] Core note workflows work on macOS arbord and iOS replica.
- [ ] Web/native simultaneous arbord edits preserve exact source and visible conflicts.
- [ ] Offline native edits synchronize through Plan 015 behavior.
- [ ] Tabs/windows share persistence without sharing presentation state.
- [ ] Every pending/error/conflict/read-only state is honest and actionable.

## STOP conditions

- Platform providers require different authored document semantics.
- macOS sandbox/helper cannot give arbord safe access.
- An editor command can mutate a non-document or historical surface.
- A lifecycle boundary can report completion before admitted local durability.

## Maintenance note

Plan 018 adds native strengths without changing this provider/session/sync foundation. Product polish must not bypass capability checks or persistence ordering.
