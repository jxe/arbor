# Small work and verification

Tasks too small for a plan of their own, and the install, deploy, hand-check and soak
gates left by finished work. Nothing here authorizes installing, restarting Joe's apps,
changing live data or deleting backups. When an item is done, record its revision, date
and evidence in [status](../status.md) and delete it here.

## Small work

### Show declined folders in the Mac app

Formerly Native 012. Story Sync keeps a folder's declined paths unpublished while the rest
syncs and serves `GET /v1/declined`, `POST /v1/declined/restore` and
`POST /v1/declined/resend` ([API](../docs/implementing-sync-services/story-sync-api.md#4-identity-account-bootstrap-and-declined-changes),
[declined folder changes](../docs/implementing-editors/declined-folder-changes.md));
`story declined` is the reference client. The Mac app reads none of it.

- [ ] Decode `declined` on daemon trees (`LocalStorySyncTreePresentation`) and list each
  placed folder that has it in Sync Status: name, path, declined paths, the host's reason,
  and the guide's sentence (kept in the folder, not published; the rest keeps syncing;
  making them match the host releases them).
- [ ] Add `restoreDeclined(tree:)` and `resendDeclined(tree:)` beside `discardHeld`; offer
  "Restore Host Version…" (confirmation names the paths and says edits there are lost) and
  "Send Again"; refresh after either.
- [ ] Keep `sync: "conflict"` with the existing discard. Reword
  `editProfileConfigurationFile`'s check, which names a review that no longer exists, to use
  `declined` and point at Sync Status. Keep `conflicted: true` (accepted alternatives)
  visually distinct.
- [ ] Verify with a `StoryAppTests` case on the bundled daemon (make a declined change as
  `tests/integration/self-sync.test.ts` does, see it listed, restore it), then by hand on
  Joe's Mac with his go-ahead.

### Teach external agents to work in placed folders

Formerly CLI 004. Agents edit placed folders with their own tools; `story status [<locator>]
--json` already reports readiness and resolves locators. No new read/mutation commands, no
MCP server, no new story-sync routes.

- [ ] Check whether `story status --json` shows that a local edit reached Canopy; if not,
  add `story status --wait [--timeout <s>]` (exit 0 when every in-scope tree is up to date,
  non-zero with the condition if one is held).
- [ ] Write one short skill for Claude Code and Codex from one source: check `story status`
  first; resolve a locator before assuming its tree or writability; edit only the placed
  folder; keep frontmatter `id:` values and links; wait for publication and report changed
  paths; treat a held tree as a stop.
- [ ] From outside the checkout, have both agents do a research task over two placed trees
  and one edit, wait for publication and report the changed locator; revise the skill.

### Schedule the object collector

Formerly overstoryd 017; the first live run is recorded in
[status](../status.md#known-gaps). A bound on `document_versions`, which holds most retained
bytes, is part of [overstoryd 007](history/007-document-history-routes-and-restore.md).

- [ ] Schedule the `railway ssh` collection command
  ([deployment](../packages/overstoryd/deploy/README.md#collecting-unreferenced-objects))
  daily or weekly from Joe's machine, keeping each report. Joe's go-ahead.

### Search excerpts are inert

Formerly Security 001, whose vulnerable daemon code is deleted. Web 025 builds its text
index with excerpts as marked ranges.

- [ ] Confirm the native app's search renders excerpts as text with highlighted ranges,
  never as markup.

### Smaller candidates

- **`story untrack`.** Ignore rules never untrack an already-published path; today the
  recipe is move out, sync the deletion, move back. One command could publish the deletion
  and leave the bytes. The bytes stay in accepted history, so a leaked secret still needs
  rotating.
- **Ignored paths in the Mac app's publish view.** Mark which paths the ignore rules keep
  out and which ignored paths are still tracked.
- **Sidebar creations as `addEntry`.** The sidebar's `createMarkdown`/`createDirectory`
  still publish snapshots; emit `addEntry` from `retainStructure` for them too.

## Native release and hands-on review

- [ ] Install the tested rejected-update retirement, broader operation capture and
  accepted-choice review when Joe can quit both apps. Verify the exact revision and
  destination server support first. Quagmire 0.8.0 is already pinned.
- [ ] Verify opening existing state, automatic publication, cross-device propagation and
  restart without losing drafts, pending requests or newer editor work. Do not overwrite
  active source journals with an older snapshot-only build.
- [ ] macOS/iPhone hands-on: layout, typing, focus, selection, scrolling, keyboard routing,
  VoiceOver, large text and installed review-draft recovery.

## Native 011 Mac gates

The client folds, route removals and shared account service were made on Linux without a
Swift toolchain ([status](../status.md#native-011-account-service--2026-09-25)); none has run.

- [ ] Regenerate `swift/Story.xcodeproj` with `xcodegen generate --spec swift/project.yml --project swift`
  and commit it if it differs from the hand-edited project.
- [ ] Build the `Canopy` scheme for macOS and iOS.
- [ ] Run `swift/scripts/test-story-editor-local.sh` and `swift package resolve` for
  `StoryEditor` after dropping its unused `StorySyncClient` dependency; commit
  `Package.resolved` only if SwiftPM rewrites it.
- [ ] `bun run test:protocol` on a Mac (including `StoryAppTests/StorySyncClientTests`,
  `LoopbackServicesTests` and `ProviderContractTests`), then `swift/scripts/hosted-smoke.ts`.
- [ ] From the Mac app against a disposable host, create a pairing offer and pair a second
  device with it.
- [ ] Run the two new `StoryAppTests` cases for `HostAccountService` (account lookups
  through a fake service; the iPhone store's unsupported capabilities).
- [ ] Mac onboarding through `StorySyncAccountService` against a disposable data home and
  host: create an identity, back it up, recover it, adopt a legacy keychain identity, claim
  an account, cancel and resume a claim, pair from another device's code and resume an
  interrupted pairing, choose a tree; the account panel's actions likewise. Check
  `GET /v1/accounts` shows the identity, account and credential in the data home, not the
  keychain.
- [ ] iPhone through `KeychainAccountService`: pair from the Mac's QR code, list accounts,
  Place a Tree and Sync & Accounts panels, a People profile and avatar, Disconnect and Pair
  Again; no keychain entry moves.

## Overstory identifier rename Mac gates

The 2026-09-24 rename ([status](../status.md#overstory-identifiers-and-ui-copy--2026-09-24))
touched 31 Swift files without a Swift toolchain.

- [ ] Regenerate the Xcode project and build the `Canopy` scheme for macOS and iOS.
- [ ] Run every Swift package suite (`swift/scripts/test-story-editor-local.sh` for
  `StoryEditor`) and `bun run test:protocol` on a Mac.
- [ ] Install the Mac app and check the renamed copy: Make This an Overstory Tree, Canopy is
  up to date, and the camera, microphone and speech permission prompts.

## Collection schema Mac gates

Declarative collection schemas ([status](../status.md#declarative-collection-schemas--2026-09-24))
changed `ProtocolObjects.swift`, `OverstoryTests.swift` and `UpdateCoordinatorTests.swift`
without a Swift toolchain.

- [ ] `swift test --package-path swift/Packages/Overstory` and
  `swift test --package-path swift/Packages/OverstoryWorkingTree`, then `bun run test:protocol`
  on a Mac; fix compile errors without changing the contract.

## Ignore policy Mac gate

Filesystem 005 ([status](../status.md#ignored-filesystem-content-filesystem-005--2026-09-25))
changed `LocalFolderPreview.swift` and `IgnorePolicyTests.swift`, which import Apple-only
modules and did not compile on Linux.

- [ ] `swift test --package-path swift/Packages/OverstoryWorkingTree --filter "IgnorePolicyTests|LocalFolderPreviewTests"`
  passes on a Mac.
- [ ] Restart the installed Story Sync on this build and confirm each placed folder returns
  to idle without publishing a change.

## Server refinements

Owner: [overstoryd 014](merge/014-merge-handles-many-cases.md).

- [ ] Rehearse, deploy and verify independent source-range inspection and the Markdown
  transfer/list-insertion refinements (deployed with `5ef1fe20`, not hand-verified). Record
  the revision and packaged worker together.
- [ ] Deploy the transfer extensions (Markdown list items, table rows and contextual links;
  same-anchor ordering; keyed JSON/YAML members; TS/JS function moves) with the sidecar.
  First run `bun test tests/unit/overstoryd-merge tests/integration/overstoryd-merge` and
  `bun test tests/integration/overstoryd/source-acceptance.test.ts` on that revision.
- [ ] Then verify by hand in both arrival orders on disposable trees: a list item moved
  between lists beside an edit to another item; a table row copied beside a cell edit; a
  paragraph with a relative link moved within one directory (merges) and into another
  (reviews); a paragraph moved to where another device appended one; a JSON member moved
  beside an edit to its value; a TS function moved beside a literal edit to it. Record each
  result and that the replayed history check still passes.
- [ ] Deploy the fast-path acceptance of basis moves (`arrangeSources`, exact-basis moves
  and anchors on carried material) before installing a Native build that publishes block
  moves or Move to Document. No client emits a new transfer form before its server step is
  recorded.

## Placement hosts

What remains of Security 007 ([status](../status.md#trees-on-other-hosts--2026-09-28)).
A live second overstoryd is Joe's decision.

- [ ] Once a live placement host exists, try by hand the iPhone opening a tree there
  (Place a Tree lists the account's other hosts). The iPhone pairs only with an HTTPS host.
- Making a folder into a tree from the Mac app, onto any host, is
  [Filesystem 024](filesystem/024-disk-editors-for-non-tree-folders.md).

## Observation and soak closeout

Dated evidence closes these; elapsed time alone does not.

- [ ] **Native 022:** record completion of the ordinary-use working-tree soak (before
  Web 025).
- [ ] **Story Sync 001:** record the raw-byte protocol soak, including ordinary use on both
  platforms.
- [ ] **Clients 001:** ordinary use of the one update machine on Mac, iPhone and the daemon;
  record continued automatic Mac publication through edits, merges, offline work and
  reconnect without Sync Now. If a stall recurs, capture the machine phase and preparation
  error before retrying. Phone foreground refresh is expected.
- [ ] **Declined folder paths (Filesystem 011):** after Story Sync restarts on it, record one
  real rejection (a `LinkPreviews/` directory in the account checkout is easiest), that
  other edits still publish, `story declined` lists the path, and `story declined --restore`
  removes it.
- [ ] **Hetzner sync lab:** run `packages/overstoryd/deploy/hcloud-sync-lab` against the
  update-machine daemon. Its runner was rewritten on 2026-09-27 and typechecks but has not
  run since.

## Manual recipes

**Editor recovery.** Rebuild the app and use a disposable page: edit offline, reconnect
without Sync Now, and verify host and peer convergence. Quit while offline with unpublished
edits and verify the reopened page shows them from the change log, then that they publish.
Preserve real user text before testing process interruption.

**Automatic publication.** If publication stalls, capture the machine phase and the actual
preparation error before any manual retry; the two historical stalls were a no-work pass
that left `preparing: true` with no task, and a preparation failure raised outside the
submission error handler. A fix never clears a pending request, rewrites its digest,
discards a saved head or alters protocol semantics.

**Resource policy soak.** Exercise Canopy consent and revocation and configuration
conflict resolution on the isolated production copy, including queued configuration writes.
Keep the schema 13 migration backups until this soak closes. Required before enabling a
real application ([Apps 005](apps/005-source-resolution-and-sidecar.md)).
