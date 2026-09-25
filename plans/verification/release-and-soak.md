# Remaining release and verification work

This checklist owns unfinished operational and manual gates transferred from mostly completed
plans. It does not authorize installation, restarting Joe's apps, production changes, deleting
backups or closing compatibility windows. Preserve live editors and recovery evidence.
Source implementation status is distinct from installed/deployed behavior.

## Native release and hands-on review

Owners: Native [008](../soon/008-complete-native-move-copy-undo-capture.md) for operation capture and Native
[010](../swift/010-inline-choice-context.md) for review behavior.

- [ ] Install the tested rejected-update retirement, broader operation capture and accepted-choice
  review when Joe can quit both apps. Verify the exact selected revision and destination server
  support first. Quagmire 0.8.0 is already pinned; do not repeat that dependency release.
- [ ] Verify opening existing state, automatic publication, cross-device propagation and restart
  without losing drafts, pending requests or newer editor work. Do not overwrite active source
  journals with an older snapshot-only build.
- [ ] Complete 010's macOS/iPhone hands-on gate: layout, typing, focus, selection, scrolling,
  keyboard routing, VoiceOver, large text and installed review-draft recovery.

Evidence: the source cutover, capture, and review checkpoints are in git history (`docs/native-source-cutover.md`, `docs/source-admission-queue.md`, `docs/native-conflict-review.md`); their surviving facts are in [the local system](../../docs/architecture/arborsync/data-home.md), [editor sources](../../docs/implementing-editors/editor-source.md), and [Native 010](../swift/010-inline-choice-context.md).
Passing builds and automated tests do not establish interactive acceptance.

## Native 011 Mac gates

Native 011 is closed in source (see [status](../../status.md#native-011-account-service--2026-09-25)
and [the folds](../../status.md#native-011-daemon-client-folds--2026-09-24)); these gates are what
remains of it. The client folds, route removals and the shared account service were made on Linux
without a Swift toolchain; none of these has run.

- [ ] Regenerate `swift/Canopy.xcodeproj` with `xcodegen generate --spec swift/project.yml --project swift`
  and commit it if it differs from the hand-edited project.
- [ ] Build the `Canopy` scheme for macOS and for iOS (the iOS build proves nothing outside
  `#if os(macOS)` still needs the folded daemon client).
- [ ] Run `swift/scripts/test-canopy-editor-local.sh` and `swift package resolve` for
  `CanopyEditor` after dropping its unused `ArborSyncClient` dependency; commit
  `Package.resolved` only if SwiftPM rewrites it (Quagmire stays at the pinned release).
- [ ] `bun run test:protocol` on a Mac, including the new `xcodebuild` run of
  `CanopyAppTests/ArborSyncClientTests` and `LoopbackServicesTests` against the live daemon
  and `ProviderContractTests` inside `CanopyWorkingTree`; then `swift/scripts/hosted-smoke.ts`.
- [ ] From the Mac app against a disposable host, create a pairing offer (now made on the host
  with the account credential) and pair a second device with it.
- [ ] Build both platforms with the new `swift/CanopyApp/CanopyAccountService.swift` (protocol and
  the iPhone's `KeychainAccountService`) and `swift/CanopyApp/ArborSync/ArborSyncAccountService.swift`
  (the Mac's data-home implementation; both were added to the hand-edited project), and run the
  two new `CanopyAppTests` cases (account lookups through a fake service; the iPhone store's
  unsupported capabilities).
- [ ] Mac onboarding through `ArborSyncAccountService`, against a disposable data home and host:
  create an identity, back it up, recover it from the backup, adopt a legacy keychain identity,
  claim a fresh account, cancel and resume a pending claim, pair this Mac from another device's
  code and resume an interrupted pairing, then choose a tree. The account panel's back-up,
  recover and pairing-offer actions work the same way. Check with the daemon's
  `GET /v1/accounts` that the identity, account and credential are in the data home, not the
  app's keychain.
- [ ] iPhone through `KeychainAccountService`: pair from the Mac's QR code (confirmation code
  shown), list accounts in the launch view, Place a Tree and Sync & Accounts panels, open a
  People profile and its avatar, and Disconnect and Pair Again; no keychain entry moves.

## Overstory identifier rename Mac gates

The 2026-09-24 identifier and UI-copy rename (see
[status](../../status.md#overstory-identifiers-and-ui-copy--2026-09-24)) renamed every Swift
`Wire*`, host-meaning `Canopy*` and app/editor `Arbor*` type and 31 Swift files without a Swift
toolchain; none of these has run.

- [ ] Regenerate `swift/Canopy.xcodeproj` with xcodegen (the renamed `CanopyApp/*.swift`
  references were hand-edited) and build the `Canopy` scheme for macOS and iOS.
- [ ] Run every Swift package suite (`swift/scripts/test-canopy-editor-local.sh` for
  `CanopyEditor`) and `bun run test:protocol` on a Mac.
- [ ] Install the Mac app and check the renamed copy: Make This an Overstory Tree, Canopy is up
  to date, and the camera, microphone and speech permission prompts.

## Collection schema Mac gates

Declarative collection schemas (Apps 007; see
[status](../../status.md#declarative-collection-schemas--2026-09-24)) changed these Swift files
without a Swift toolchain; none of them has compiled. There is nothing to convert: no
collections existed before `schema.cddl`, so no inventory or cutover remains.

- `swift/Packages/Overstory/Sources/Overstory/ProtocolObjects.swift`: descriptor version 1
  requires `schemaSource` `schema.cddl`.
- `swift/Packages/Overstory/Tests/OverstoryTests/OverstoryTests.swift`: eight shared invalid
  object vectors.
- `swift/Packages/CanopyWorkingTree/Tests/CanopyWorkingTreeTests/UpdateCoordinatorTests.swift`:
  the collection-file descriptor round trip uses `schema.cddl`.

- [ ] `swift test --package-path swift/Packages/Overstory` and
  `swift test --package-path swift/Packages/CanopyWorkingTree`, then `bun run test:protocol`
  on a Mac; fix any compile error in place without changing the contract.

## Server refinements

Owner: canopyd [014](../soon/014-merge-moved-text.md). Deployed with `5ef1fe20` (2026-09-22); hand verification not yet recorded.

- [ ] Rehearse, deploy and verify independent source-range inspection and the subsequent Markdown
  transfer/list-insertion refinements. Record the exact revision and packaged worker together.
  Preserve existing whole-file policy and format-required coupling.
- [ ] Record server readiness before enabling any newly captured client operation forms.
- [ ] Deploy the transfer extensions (Markdown list items, table rows and contextual links;
  same-anchor ordering; keyed JSON/YAML members; TS/JS function declaration moves) with
  the sidecar, and record the revision. They are implemented and tested, not deployed.
  Before deploying, run `bun test tests/unit/canopyd-merge tests/integration/canopyd-merge`
  and `bun test tests/integration/canopyd/source-acceptance.test.ts` on that revision.
- [ ] After deploying, verify by hand in both arrival orders on disposable trees, never
  live data: a list item moved between lists beside an edit to another item; a table
  row copied beside a cell edit; a paragraph with a relative link moved within one
  directory (merges) and into another directory (reviews); a paragraph moved to where
  another device appended one (one result, both kept); a JSON member moved between
  objects beside an edit to its value; a TS function moved beside a literal edit to it.
  Record each result, and that the replayed history check still passes.
- [ ] Record that no client emits a new transfer form before the step above is recorded.

The schema-12 merge-authority cutover (migration 010, deleted after cutover; see git history) is complete;
these later refinements are not another request to repeat that migration.

## Observation and soak closeout

These gates remain unconfirmed by this cleanup. Dated evidence is required to close them;
elapsed calendar time alone is insufficient.

- [ ] **Native 022:** record completion of the original ordinary-use working-tree soak before
  starting Web 025. The working-tree switch and subsequent Mac/iPhone source-mode installation
  are already live. Do not repeat the old re-place or rollout instructions.
- [ ] **Arbor Sync 001:** record the remaining raw-byte protocol soak, including ordinary use on
  both platforms. Migration 005 (migration 005, deleted after cutover; see git history) already
  records matching rehearsals, unchanged authored bytes, both upgrades and round-trip edits.
  No history reset is requested.
- [ ] **Clients 001 soak:** ordinary use of the one update machine on Mac, iPhone and the
  daemon. It absorbs the Reliability 012 observation, whose publication path Clients 001
  replaced: record continued automatic Mac publication through subsequent edits, merges,
  offline work and reconnect without Sync Now. Installation, cross-device publication and
  restart already have evidence. If a stall recurs, capture the machine phase and
  preparation error before retrying; see the automatic-publication recipe below. Phone
  foreground refresh is expected, not a background-sync defect.
- [ ] **Clients 001 / Hetzner sync lab:** run `packages/canopyd/deploy/hcloud-sync-lab` against
  the update-machine daemon. Its binary scenario now expects Canopy to accept both versions as an
  unresolved alternative instead of a daemon conflict; it has not run since that rewrite.

Historical plans: Native 022 (completed plan, deleted; see git history),
Arbor Sync 001 (completed plan, deleted; see git history),
Reliability 012 (completed plan, deleted; see git history; its soak is now part of the
Clients 001 soak).
The deleted progress investigation (git history: `docs/native-sync-progress.md`) preserved the reproduced failures
without claiming to prove the original incident's exact cause.

## Compatibility windows remain separate

[Cleanup 001](../cleanups/001-pageid-stable-key-cutoff.md) retains its own data audit,
operator decision and backup conditions. A date passing does not close that window.
Cleanup 002 closed on 2026-09-21; its evidence is in [status](../../status.md#v1-account-and-local-state-cutoff--2026-09-21).

When a gate passes, record exact revision/date/evidence in its owning checkpoint, then remove
that completed checkbox here. Do not keep finished release steps as an evergreen executor plan.

## Manual recipes retained from the deleted checkpoints

**Editor recovery.** Rebuild the app and use a disposable page: edit offline,
reconnect without Sync Now, and verify host and peer convergence. Quit the app
while offline with unpublished edits and verify the reopened page shows them
from the change log, then that they publish. Preserve real user text before
intentionally testing process interruption.

**Automatic publication.** Verify ordinary automatic Mac edit publication and
subsequent edits after a merge or reconnect without Sync Now. If publication
stalls again, capture the machine phase and the actual preparation error
before any manual retry; the two historical stalls were a no-work pass that
left `preparing: true` with no task, and a preparation failure raised outside
the submission error handler. The fix must never clear a pending request,
rewrite its digest, discard a saved head, or alter protocol semantics.

**Resource policy soak.** Exercise Canopy consent and revocation and
configuration conflict resolution on the isolated production copy, including
queued configuration writes. Keep the schema 13 migration backups until this
soak closes.
