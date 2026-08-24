# Plan 018: Port Hunch's native strengths

> **Executor instructions**: Port accepted behavior behind Arbor owners; do not copy Hunch storage, identity, caches, URLs, diagnostics, or flat navigation. Build and verify one capability cluster at a time, running macOS/iOS commands sequentially.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- native plan/native /Users/joe/src/hunch/App/Sources /Users/joe/src/hunch/App/Tests /Users/joe/src/quagmire`

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: MED
- **Depends on**: Plan 017
- **Category**: product/parity
- **Planned at**: Arbor `dc34126`, Hunch `a1e8379`, Quagmire `4049fd4`, 2026-08-23
- **Reconciled at**: Arbor `0fb1d32`, Hunch `a1e8379`, Quagmire `4049fd4`, 2026-08-24
- **Progress**: UI shell cluster in progress; live parity matrix at [`hunch-parity.md`](hunch-parity.md)

## Why this matters

Joe selected native Arbor as a Hunch replacement, not merely a protocol demo. The cutover should preserve the native interactions and capture/recovery strengths that make Hunch useful while adopting Arbor's node-first browser and server-assisted sync.

## Parity authority

Create a checked-in matrix with:

```text
Capability | Hunch behavior | Arbor behavior | Owner
Status | Automated gate | Manual exact-artifact gate | Deliberate difference
```

Every current Hunch README feature must be implemented, deliberately different for a concrete Arbor reason, or explicitly deferred with Joe's approval. “Same as Hunch” is not a specification.

## Capability clusters

1. **Capture**: voice recording, interrupted-recording recovery, transcription, Siri/shortcut entry where applicable, and optional on-device transcript polishing through a host block action.
2. **Editing feel**: selection/nav mode, keyboard navigation, drag/reorder, indent/outdent, pinch insertion/open behavior, toggles, pasteboard, emoji completion/frequency, icon editing, feedback, scrolling/focus.
3. **Content integrations**: image/Markdown paste and drag, assets, external link previews in Arbor's own cache, internal link decoration/actions.
4. **Native shell**: menus/shortcuts, banners, context menus, iPhone/iPad navigation, tabs/windows, command enablement, accessibility and VoiceOver.
5. **Safety presentation**: recording/persistence/sync/history/recovery/conflict state without exposing journals, credentials, host paths, or raw protocol records.

## Scope

**In scope**: ArborApp integrations/resources/tests and narrow ArborKit/ArborQuagmire hooks required by the named behavior.

**Out of scope**: Hunch/Quagmire source changes, Clamshell/iCloud, app bundle/default/cache reuse, mutable collections, scripts/agents, full community/access admin, real data conversion.

## Steps

1. Inventory live Hunch source/tests and create the parity matrix with owners/gates before porting.
2. Port each capability cluster behind provider/session abstractions; use Arbor names and app-private support paths.
3. Preserve known Hunch durability boundaries: destination-before-source, final-generation drain, no-speech recording cleanup, safe externally rewritten document replacement, and exact built-artifact testing. Preserve its recovery bias as a server-merge product invariant—uncertain Markdown placement may duplicate near context but must not omit an added line—without porting Clamshell journals or block hashes.
4. Add focused unit/app/UI tests per cluster; avoid copying tests that assert Clamshell implementation rather than user behavior.
5. Run manual exact-artifact matrix on macOS and existing iOS 27 simulator/device, recording what was and was not verified.

## Verification

```sh
/Users/joe/src/quagmire/scripts/verify.sh
swift test --package-path native/Packages/ArborKit
swift test --package-path native/Packages/ArborReplica
swift test --package-path native/Packages/ArborQuagmire
bun run typecheck
bun test
bun run test:protocol
```

Run sequential macOS/iOS 27 Xcode tests/builds plus exact-artifact manual checks for voice, keyboard, touch/pointer, menus, assets, links, offline sync, history, conflict, and recovery.

## Done criteria

- [ ] Every current Hunch capability has a reviewed parity disposition.
- [ ] Accepted daily-use capabilities pass automated/manual gates.
- [ ] Arbor contains no Hunch persistence identity or Clamshell ownership.
- [ ] Node-first navigation and non-document surfaces remain intact.
- [ ] Hunch still builds and works independently against its original workspace.

## STOP conditions

- A meaningful capability would be dropped without Joe's approval.
- Porting requires reusing Hunch bundle IDs/default keys/bookmarks/cache roots/writer IDs.
- A test launches an installed stale app instead of the exact build artifact.
- A capability would weaken provider/session/sync durability.

## Maintenance note

Hunch remains Quagmire's first production host and a regression oracle. Arbor parity does not require identical storage, hierarchy, or chrome.
