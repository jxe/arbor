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
- **Reconciled at**: Arbor `f00aa87`, Hunch `d13087b`, Quagmire `af61f9a` / `0.2.0`, 2026-08-25; image work planned at Arbor `a3a9ffd`, 2026-08-25
- **Progress**: Shell, Move To, typography/editing feedback, native editor commands, safety presentation, and the QuagmireExtras `0.2.0` adoption are implemented. Arbor now uses shared voice/recovery, external-link preview, and transcript-polishing mechanisms behind Arbor-owned PageID/provider/support-directory adapters. Automated gates pass. Async image paste/render through Arbor providers, its Quagmire `0.3.0` release, the hands-on checklist below, and the older partial parity rows remain. Live parity matrix at [`hunch-parity.md`](hunch-parity.md)

## Why this matters

Joe selected native Arbor as a Hunch replacement, not merely a protocol demo. The cutover should preserve the native interactions and voice/recovery strengths that make Hunch useful while adopting Arbor's node-first browser and server-assisted sync.

## Reconciled QuagmireExtras boundary

- Quagmire `0.2.0` adds the separately imported `QuagmireExtras` product. Hunch `d13087b` proves exact remote consumption on macOS and iOS 27, including 345 macOS tests, 19 iOS UI tests, and built-app shortcut metadata for `QuagmireExtras.StartVoiceRecordingIntent`.
- Native Arbor now consumes exact remote Quagmire `0.2.0` and imports the separate `QuagmireExtras` product. ArborQuagmire's source ledger, BlockIDs, guarded admissions, and no-op byte fidelity remain covered by the unchanged and expanded bridge suite.
- Reuse `LinkPreviewService`, `VoiceRecordingSession<PageID>`, `VoiceRecordingButton`, `VoiceRecordingLaunchRequest`, `StartVoiceRecordingIntent`, `TranscriptPolishingActions`, and their shared recovery/transformation policies. Do not copy their Hunch-era implementations into Arbor.
- Arbor still owns all product decisions: its own support/cache roots, current/Home destination policy, provider-backed transcript delivery, permissions and error surfaces, toolbar/menu placement, and literal shortcut phrases.
- Keep a tiny `AppShortcutsProvider` in the Arbor application target. Xcode does not extract a provider or shortcut metadata abstracted behind the Swift package; the local provider must instantiate the packaged intent with literal phrases, title, image, and color.

## Planned Quagmire 0.3 image boundary

- Rev Quagmire core, not `QuagmireExtras`, because paste/drop ordering, undo grouping, and image-view loading are editor mechanics shared by Hunch and Arbor. Keep Arbor provider types, `TreeID`, networking, and the `/Assets` convention out of Quagmire.
- Replace the synchronous image host hooks with document-scoped asynchronous persistence and loading. The intended shape is `saveImages(_:in:) async -> [String]` plus `imageResource(for:in:) async -> EditorImageResource?`, where a resource can be local file-backed for Hunch or in-memory data for Arbor.
- Share Quagmire's format/orientation/media-type normalization and partial-failure policy. Hosts own durable storage, canonical Markdown sources, permission/read-only checks, support paths, and error presentation.
- Quagmire must durably save every successful image before inserting its Markdown block. It handles the key/paste event immediately, serializes concurrent imports to preserve user order, and inserts the resulting blocks in one undoable `Document.transaction`. If the original anchor disappears while awaiting storage, use the existing identity-based placement fallback rather than a stale index.
- Async rendering must have explicit loading and missing states. A task keyed by the current source must not allow an old request to replace a newer source, and navigation or editor reuse must not turn a completed load into the wrong block's presentation.
- Arbor's host resolves the active document to its tree, safely resolves or creates that tree's root `Assets` directory, stores through `WorkspaceProvider`, and returns provider-authored logical Markdown sources. It never exposes a physical path, temporary URL, or optimistic link to Quagmire.
- Extend the provider contract with a stored-asset result containing the durable `WorkspaceReference` and canonical Markdown source, plus a provider-neutral ordinary-file byte read. Implement both contracts for the in-memory, arbord, and replica providers. Prefer a small tree-scoped arbord byte route over reconstructing physical paths or depending on browser `Referer` behavior.
- Make explicit Import Asset use the same destination and naming helper as editor paste/drop. A successful asset write followed by a failed document admission may leave a safe orphan for later cleanup; a document must never commit a link to bytes that were not saved.
- Prove the API against local Quagmire checkouts in both Hunch and Arbor before publishing. Hunch adapts its existing atomic `Assets` writes and local URL resolution; Arbor adapts provider storage and reads. Only then tag Quagmire `0.3.0`, replace both local overrides with exact remote `0.3.0`, regenerate Arbor's project, and commit each consumer adoption separately.
- This host-neutral lifecycle change does not contradict Plan 021. It introduces no Arbor revisions, wire hashes, storage metadata, or patch lineage into Quagmire; the resulting Markdown insertion still flows through ArborQuagmire's ordinary guarded admission and immediate-patch optimization.

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

**In scope**: the implemented exact remote Quagmire `0.2.0`/`QuagmireExtras` adoption; a coordinated Quagmire core `0.3.0` async-image revision proven in Hunch and Arbor before tagging; ArborApp integrations/resources/tests; and narrow ArborClient, ArborKit, provider, arbord, and ArborQuagmire hooks required by the named behavior.

**Out of scope**: unrelated Hunch/Quagmire source changes, moving image storage policy into Quagmire, Clamshell/iCloud redesign, app bundle/default/cache reuse, mutable collections, scripts/agents, full community/access admin, real data conversion, remote-image downloading, image editing, thumbnail pipelines, and orphan-asset garbage collection.

## Steps

1. Update `native/Packages/ArborQuagmire/Package.swift` and `native/project.yml` to exact remote Quagmire `0.2.0`, add only the required `QuagmireExtras` products, regenerate the tracked Xcode project, and prove the existing codec/ledger/editor gates before behavior changes. Leave no path, branch, or revision override.
2. Build voice around `VoiceRecordingSession<PageID>`. Toolbar recording uses the current writable document's durable `PageID`; shortcut/Action Button recording uses Home's `PageID`. Persist the destination before audio starts, store pending audio/metadata under an Arbor-owned root such as `Application Support/Arbor/Pending Voice Recordings`, add Arbor-specific microphone and speech-recognition usage descriptions, and deliver recovery/finished transcripts through `WorkspaceCoordinator`/`WorkspaceProvider`, never a raw path or direct filesystem write. Active-editor insertion may remain an optimized presentation path only when it targets that same PageID.
3. Preserve the shared recording failure policy: no audio, no transcribable speech, and empty transcripts are discarded; cancellation, speech-service failures, and provider/delivery failures preserve the pending recording for retry. Background/interruption recovery must remain visible without exposing support paths.
4. Install `TranscriptPolishingActions.actions()` through `ArborEditorHost` and use the shared conservative transformation policy. Quagmire's block-action stale-result guard and Arbor's normal admitted provider write remain the only application path; polishing must never mutate a read-only/historical surface or bypass sync durability.
5. Replace `LinkPreviewsUnsupported` with an injected `LinkPreviewService` rooted under Arbor's own application support/cache identity, such as `Application Support/Arbor/LinkPreviews`. Metadata and icons are derived cache state, never authored tree content or wire objects; stale fetch results must not replace a newer URL.
6. Add the Arbor app-target `AppShortcutsProvider` with literal Arbor phrases/title/image/color around `StartVoiceRecordingIntent`, then inspect the exact built app's `Metadata.appintents/extract.actionsdata` to prove both the packaged intent and local provider were emitted.
7. Rev Quagmire's image host contract and editor paths locally. Cover navigation-mode paste, active-text paste, drag/drop, multi-image ordering, persistence-before-insertion, one-step undo/redo, partial failure, anchor removal while awaiting storage, and stale async rendering. Run Quagmire's public API and behavior suites before changing either consumer.
8. Adapt Hunch to the local Quagmire checkout using its existing atomic Clamshell `Assets` write and local file resolver. Add regression coverage for exact bytes, reopen, recovery, multi-image order, and storage failure; do not change Hunch workspace identity or storage policy.
9. Add provider-authored asset results and provider-neutral file reads to ArborKit. Implement them for in-memory, replica, and arbord providers, adding a tree-scoped REST v1 byte route and matching ArborClient operation if the existing logical route cannot satisfy native authenticated reads without presentation-only request context.
10. Add one Arbor asset-location helper that resolves or creates root `/Assets` within the document's tree, tolerates a concurrent already-exists result by resolving again, and refuses read-only or mismatched-tree destinations. Route both explicit Import Asset and `ArborEditorHost` image paste/drop through it.
11. Implement Arbor's async image host adapter. Convert Quagmire paste data to `WorkspaceAsset`, return only provider-authored Markdown sources after successful durable stores, resolve relative sources within the same tree, read through the provider, and return data-backed image resources without direct `FileManager`, physical paths, or temporary placeholders.
12. Prove Hunch and Arbor against the same local Quagmire revision, then tag Quagmire `0.3.0`. Replace local overrides with exact remote `0.3.0`, regenerate Arbor's tracked Xcode project, and re-run both consumers before committing their dependency adoptions separately.
13. Finish the remaining editing/content clusters behind provider/session abstractions. Preserve destination-before-source, final-generation drain, safe externally rewritten document replacement, and exact built-artifact testing. Preserve Hunch's recovery bias as a server-merge product invariant—uncertain Markdown placement may duplicate near context but must not omit an added line—without porting Clamshell journals or block hashes. Add focused Quagmire/QuagmireExtras/ArborQuagmire/app/UI tests per cluster; avoid tests that assert Hunch or Clamshell implementation rather than user behavior. Run the manual exact-artifact matrix on macOS and the existing iOS 27 simulator/device, recording what was and was not verified.

## Implementation evidence

- Both Arbor dependency graphs resolve `https://github.com/jxe/quagmire.git` at exact `0.2.0` / `af61f9ad922e4d39de16383ef64f21dd92294ff2`; there is no path, branch, or revision override.
- `ArborEditorHost` delegates external previews and transcript polishing to `QuagmireExtras`. Cache state lives under Arbor's application-support identity and remains derived state.
- `VoiceRecordingSession<PageID>` owns recording/recovery policy. Toolbar voice targets the current writable document; the App Intent targets writable Home; delivery resolves the recorded PageID through the provider-backed editor coordinator.
- Active and inactive PageID transcript delivery, Arbor-owned support roots, bridge delegation, exact source preservation, and destination failure are automated tests.
- The exact macOS and iOS 27 simulator artifacts contain `QuagmireExtras.StartVoiceRecordingIntent`, Arbor's app-target `ArborAppShortcuts` provider, and the literal Arbor phrases.
- Quagmire verification, all native package suites, Arbor's signed macOS tests, Arbor's iOS 27 simulator tests, the full 229-test Bun suite, typecheck, protocol conformance, Hunch's 345 macOS tests, and Hunch's iOS 27 simulator build pass.

## Hands-on verification checklist

Use the exact newly built Arbor artifacts. These checks replace Computer Use; report any failed item with the platform and page involved.

### Images and assets

- [ ] Paste one image while editing text and one while navigating blocks; confirm each appears once, at the intended position, and survives reopening.
- [ ] Paste several images together and confirm their visual and Markdown order matches the pasteboard order.
- [ ] Drag images from Finder and a browser into the editor on macOS, then repeat an available Photos/files paste or drag on iOS 27.
- [ ] Undo and redo one multi-image import; confirm the Markdown blocks act as one edit while the already durable assets remain safe.
- [ ] Move or rename the containing page, relaunch, and confirm its logical asset references still render. Reopen a previously synchronized Arbor image while offline.
- [ ] Import the same image twice and confirm the provider's documented collision/content-addressing behavior creates no silent overwrite.
- [ ] Try paste/drop on a read-only, historical, ordinary-file, or conflict surface and confirm it cannot mutate the tree.
- [ ] If convenient, interrupt or force one asset-store failure and confirm no broken image block is inserted, successful siblings retain order, and the error exposes no host path.
- [ ] Use explicit Import Asset and editor paste in the same tree; confirm both place bytes under the same root `Assets` policy and render through the provider.
- [ ] Open the same image-backed page in two windows/tabs and confirm a delayed load or source edit never displays the prior image in the wrong block.

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
swift test --package-path native/Packages/ArborClient
swift test --package-path native/Packages/ArborKit
swift test --package-path native/Packages/ArborReplica
swift test --package-path native/Packages/ArborQuagmire
bun run typecheck
bun test
bun run test:protocol
```

Run sequential macOS/iOS 27 Xcode tests/builds plus exact-artifact manual checks for voice, keyboard, touch/pointer, menus, assets, links, offline sync, history, conflict, and recovery.

For the image revision, run Hunch and Arbor against the same local Quagmire checkout first; no tag may be created while either consumer still needs an API workaround. After release, inspect Swift package resolution and the built artifacts: Hunch, ArborQuagmire, and ArborApp must resolve exact remote `0.3.0` with no local override. The iOS app metadata must still name `QuagmireExtras.StartVoiceRecordingIntent` plus the Arbor app-target shortcut provider and literal phrases. Rerun Hunch's macOS tests and iOS 27 build as the regression oracle after both exact-`0.3.0` adoptions.

## Done criteria

- [ ] Every current Hunch capability has a reviewed parity disposition.
- [x] Arbor consumes exact remote Quagmire/QuagmireExtras `0.2.0`; existing source-preservation and editor identity gates remain unchanged.
- [x] Voice recording, recovery, link previews, and transcript polishing reuse QuagmireExtras rather than local copies.
- [ ] Quagmire `0.3.0` supplies async persistence-before-insertion and async resource loading without Arbor storage or wire concepts.
- [ ] Hunch and Arbor independently pass image paste/drop/render regressions against the same revision before the `0.3.0` tag, then consume that exact remote tag.
- [ ] Arbor stores pasted/imported assets under the tree's root `Assets` policy and renders them through provider reads on macOS, iOS, reopen, and offline paths.
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
- Quagmire inserts an image block before its bytes are durably stored, or gains Arbor provider, path, identity, or wire concepts.
- Arbor image rendering requires a physical path, browser-only referrer state, or direct filesystem access outside the provider.
- Quagmire `0.3.0` would be tagged before both Hunch and Arbor pass against the identical local revision.
- Recording delivery requires a raw path/direct filesystem write or cannot retain a complete retryable recording after provider failure.
- Xcode omits the packaged intent or Arbor app-target shortcuts from the exact built artifact.

## Maintenance note

Hunch remains Quagmire's first production host and a regression oracle. Arbor parity does not require identical storage, hierarchy, or chrome.
