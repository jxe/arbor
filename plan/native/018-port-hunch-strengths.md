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
- **Reconciled at**: Arbor `f00aa87`, Hunch `d13087b`, Quagmire `af61f9a` / `0.2.0`, 2026-08-25
- **Progress**: Shell, Move To, typography/editing feedback, native editor commands, safety presentation, and the QuagmireExtras `0.2.0` adoption are implemented. Arbor now uses shared voice/recovery, external-link preview, and transcript-polishing mechanisms behind Arbor-owned PageID/provider/support-directory adapters. Automated gates pass; the hands-on checklist below and the older partial parity rows remain. Live parity matrix at [`hunch-parity.md`](hunch-parity.md)

## Why this matters

Joe selected native Arbor as a Hunch replacement, not merely a protocol demo. The cutover should preserve the native interactions and voice/recovery strengths that make Hunch useful while adopting Arbor's node-first browser and server-assisted sync.

## Reconciled QuagmireExtras boundary

- Quagmire `0.2.0` adds the separately imported `QuagmireExtras` product. Hunch `d13087b` proves exact remote consumption on macOS and iOS 27, including 345 macOS tests, 19 iOS UI tests, and built-app shortcut metadata for `QuagmireExtras.StartVoiceRecordingIntent`.
- Native Arbor now consumes exact remote Quagmire `0.2.0` and imports the separate `QuagmireExtras` product. ArborQuagmire's source ledger, BlockIDs, guarded admissions, and no-op byte fidelity remain covered by the unchanged and expanded bridge suite.
- Reuse `LinkPreviewService`, `VoiceRecordingSession<PageID>`, `VoiceRecordingButton`, `VoiceRecordingLaunchRequest`, `StartVoiceRecordingIntent`, `TranscriptPolishingActions`, and their shared recovery/transformation policies. Do not copy their Hunch-era implementations into Arbor.
- Arbor still owns all product decisions: its own support/cache roots, current/Home destination policy, provider-backed transcript delivery, permissions and error surfaces, toolbar/menu placement, and literal shortcut phrases.
- Keep a tiny `AppShortcutsProvider` in the Arbor application target. Xcode does not extract a provider or shortcut metadata abstracted behind the Swift package; the local provider must instantiate the packaged intent with literal phrases, title, image, and color.

## Parity authority

Create a checked-in matrix with:

```text
Capability | Hunch behavior | Arbor behavior | Owner
Status | Automated gate | Manual exact-artifact gate | Deliberate difference
```

Every current Hunch README feature must be implemented, deliberately different for a concrete Arbor reason, or explicitly deferred with Joe's approval. “Same as Hunch” is not a specification.

## Capability clusters

1. **Voice**: package-backed voice recording, interrupted-recording recovery, transcription, and Siri/shortcut entry with Arbor-owned `PageID` destinations and provider delivery.
2. **Editing feel**: selection/nav mode, keyboard navigation, drag/reorder, indent/outdent, pinch insertion/open behavior, toggles, pasteboard, emoji completion/frequency, icon editing, feedback, scrolling/focus.
3. **Content integrations**: image/Markdown paste and drag, assets, package-backed external link previews using Arbor's own injected cache directory, and internal link decoration/actions.
4. **Native shell**: menus/shortcuts, banners, context menus, iPhone/iPad navigation, tabs/windows, command enablement, accessibility and VoiceOver.
5. **Safety presentation**: recording/persistence/sync/history/recovery/conflict state without exposing journals, credentials, host paths, or raw protocol records.

## Scope

**In scope**: the exact remote Quagmire `0.2.0` bump, `QuagmireExtras` product wiring, ArborApp integrations/resources/tests, and narrow ArborKit/ArborQuagmire hooks required by the named behavior.

**Out of scope**: Hunch/Quagmire source changes, Clamshell/iCloud, app bundle/default/cache reuse, mutable collections, scripts/agents, full community/access admin, real data conversion.

## Steps

1. Update `native/Packages/ArborQuagmire/Package.swift` and `native/project.yml` to exact remote Quagmire `0.2.0`, add only the required `QuagmireExtras` products, regenerate the tracked Xcode project, and prove the existing codec/ledger/editor gates before behavior changes. Leave no path, branch, or revision override.
2. Build voice around `VoiceRecordingSession<PageID>`. Toolbar recording uses the current writable document's durable `PageID`; shortcut/Action Button recording uses Home's `PageID`. Persist the destination before audio starts, store pending audio/metadata under an Arbor-owned root such as `Application Support/Arbor/Pending Voice Recordings`, add Arbor-specific microphone and speech-recognition usage descriptions, and deliver recovery/finished transcripts through `WorkspaceCoordinator`/`WorkspaceProvider`, never a raw path or direct filesystem write. Active-editor insertion may remain an optimized presentation path only when it targets that same PageID.
3. Preserve the shared recording failure policy: no audio, no transcribable speech, and empty transcripts are discarded; cancellation, speech-service failures, and provider/delivery failures preserve the pending recording for retry. Background/interruption recovery must remain visible without exposing support paths.
4. Install `TranscriptPolishingActions.actions()` through `ArborEditorHost` and use the shared conservative transformation policy. Quagmire's block-action stale-result guard and Arbor's normal admitted provider write remain the only application path; polishing must never mutate a read-only/historical surface or bypass sync durability.
5. Replace `LinkPreviewsUnsupported` with an injected `LinkPreviewService` rooted under Arbor's own application support/cache identity, such as `Application Support/Arbor/LinkPreviews`. Metadata and icons are derived cache state, never authored tree content or wire objects; stale fetch results must not replace a newer URL.
6. Add the Arbor app-target `AppShortcutsProvider` with literal Arbor phrases/title/image/color around `StartVoiceRecordingIntent`, then inspect the exact built app's `Metadata.appintents/extract.actionsdata` to prove both the packaged intent and local provider were emitted.
7. Finish the remaining editing/content clusters behind provider/session abstractions. Preserve destination-before-source, final-generation drain, safe externally rewritten document replacement, and exact built-artifact testing. Preserve Hunch's recovery bias as a server-merge product invariant—uncertain Markdown placement may duplicate near context but must not omit an added line—without porting Clamshell journals or block hashes.
8. Add focused QuagmireExtras/ArborQuagmire/app/UI tests per cluster; avoid copying tests that assert Hunch or Clamshell implementation rather than user behavior. Run the manual exact-artifact matrix on macOS and the existing iOS 27 simulator/device, recording what was and was not verified.

## Implementation evidence

- Both Arbor dependency graphs resolve `https://github.com/jxe/quagmire.git` at exact `0.2.0` / `af61f9ad922e4d39de16383ef64f21dd92294ff2`; there is no path, branch, or revision override.
- `ArborEditorHost` delegates external previews and transcript polishing to `QuagmireExtras`. Cache state lives under Arbor's application-support identity and remains derived state.
- `VoiceRecordingSession<PageID>` owns recording/recovery policy. Toolbar voice targets the current writable document; the App Intent targets writable Home; delivery resolves the recorded PageID through the provider-backed editor coordinator.
- Active and inactive PageID transcript delivery, Arbor-owned support roots, bridge delegation, exact source preservation, and destination failure are automated tests.
- The exact macOS and iOS 27 simulator artifacts contain `QuagmireExtras.StartVoiceRecordingIntent`, Arbor's app-target `ArborAppShortcuts` provider, and the literal Arbor phrases.
- Quagmire verification, all native package suites, Arbor's signed macOS tests, Arbor's iOS 27 simulator tests, the full 229-test Bun suite, typecheck, protocol conformance, Hunch's 345 macOS tests, and Hunch's iOS 27 simulator build pass.

## Hands-on verification checklist

Use the exact newly built Arbor artifacts. These checks replace Computer Use; report any failed item with the platform and page involved.

### Voice and recovery

- [ ] On a writable page, tap/click the microphone, grant microphone and speech permissions, speak a short sentence, stop, and confirm a new final paragraph appears on that same page and survives reopening.
- [ ] Start recording on page A, navigate to page B before stopping, and confirm the transcript is delivered to page A rather than the currently visible page.
- [ ] Run the Arbor “Record” shortcut or one literal phrase—“Start recording in Arbor,” “Record audio in Arbor,” or “Start a voice note in Arbor”—and confirm Arbor opens Home and starts recording there.
- [ ] Interrupt a recording by backgrounding or terminating Arbor, relaunch, choose “Transcribe and Add,” and confirm delivery to the original page. Choose “Later” once and confirm the recovery offer returns on a later launch.
- [ ] Try an empty/no-speech recording and confirm no empty paragraph or persistent warning remains.
- [ ] Deny a permission or force a delivery failure if convenient; confirm Arbor explains the failure without displaying a filesystem path, and a retryable recording remains recoverable.

### Links and transcript polishing

- [ ] Paste or type an external `https` URL and confirm its title and favicon appear without changing the Markdown source; reopen offline and confirm cached presentation still appears.
- [ ] Change that link quickly to a different URL and confirm delayed metadata from the old URL never replaces the new link's presentation.
- [ ] Select a spoken-style paragraph containing fillers, false starts, and rough punctuation; run the transcript-polishing block action and confirm it improves casing/punctuation while preserving meaning and block order.
- [ ] Open a read-only, historical, ordinary-file, or conflict surface and confirm transcript polishing and voice insertion cannot mutate it.

### Platform fit and regression

- [ ] On macOS, confirm the mic control, recording/transcribing states, alerts, editor actions, menus, keyboard navigation, and external-link presentation fit the existing Arbor shell.
- [ ] On the existing iOS 27 device/simulator, repeat one toolbar recording and inspect touch focus, scrolling, background recovery, alert layout, and VoiceOver labels for the mic and recovery actions.
- [ ] Recheck an internal link, Back, Move To, offline edit/reconnect, history/recovery, conflict choice, explicit Import Asset, and one non-document node so the Extras adoption has not disturbed Arbor's node-first behavior.
- [ ] Launch the exact Hunch `d13087b` macOS/iOS artifacts against its ordinary workspace and confirm voice, links, and polishing still behave independently of Arbor.

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

Also inspect Swift package resolution and the built artifacts: both ArborQuagmire and ArborApp must resolve the remote `0.2.0` tag with no local override, and the iOS app metadata must name `QuagmireExtras.StartVoiceRecordingIntent` plus the Arbor app-target shortcut provider and literal phrases. Rerun Hunch's exact-`0.2.0` macOS tests and iOS 27 build as the regression oracle after the Arbor adoption.

## Done criteria

- [ ] Every current Hunch capability has a reviewed parity disposition.
- [x] Arbor consumes exact remote Quagmire/QuagmireExtras `0.2.0`; existing source-preservation and editor identity gates remain unchanged.
- [x] Voice recording, recovery, link previews, and transcript polishing reuse QuagmireExtras rather than local copies.
- [x] Recording destinations and transcript writes use durable `PageID` plus provider/session APIs; cache and recovery state use Arbor-owned support roots.
- [x] The exact iOS artifact contains the packaged intent and Arbor's local shortcut metadata.
- [ ] Accepted daily-use capabilities pass automated/manual gates.
- [x] Arbor contains no Hunch persistence identity or Clamshell ownership.
- [x] Node-first navigation and non-document surfaces remain intact.
- [ ] Hunch still builds and works independently against its original workspace.

## STOP conditions

- A meaningful capability would be dropped without Joe's approval.
- Porting requires reusing Hunch bundle IDs/default keys/bookmarks/cache roots/writer IDs.
- A test launches an installed stale app instead of the exact build artifact.
- A capability would weaken provider/session/sync durability.
- Quagmire `0.2.0` changes ArborQuagmire BlockID reconciliation, guarded source admission, or no-op byte fidelity.
- Recording delivery requires a raw path/direct filesystem write or cannot retain a complete retryable recording after provider failure.
- Xcode omits the packaged intent or Arbor app-target shortcuts from the exact built artifact.

## Maintenance note

Hunch remains Quagmire's first production host and a regression oracle. Arbor parity does not require identical storage, hierarchy, or chrome.
