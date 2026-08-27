# Plan 005: Complete native parity, import Hunch safely, and qualify release

> **Final status: REJECTED — superseded by Plans 017–019.** Parity and the one live-workspace cutover are separate milestones. Preserve this file as historical evidence; do not execute it.

> **Executor instructions**: Treat Hunch as a behavior/reference product and its
> workspace as immutable input until a dry-run import passes every count and
> recovery check. This plan does not authorize in-place conversion or concurrent
> Hunch/TreeHopper authorship. Run platform builds sequentially and visually test
> the exact built TreeHopper artifact.
>
> **Drift checks (run first)**:
>
> ```sh
> git diff --stat 84fc705..HEAD -- native plan/native/README.md plan/records/history.md \
>   README.md docs/client.md packages tests spec
> git -C /Users/joe/src/hunch diff --stat 4c35f37..HEAD -- \
>   App/Sources App/Tests App/UITests project.yml README.md
> ```
>
> Stop if Plans 003 or 004 are not DONE, if TreeHopper can still lose an admitted
> generation, or if the live Hunch source/migration format no longer matches the
> inventory assumptions below.

## Status

- **Priority**: P2
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 003 and 004
- **Category**: migration
- **Planned at**: Arbor `84fc705`, Hunch `4c35f37`, 2026-08-18
- **Reconciled**: 2026-08-19 after foundation completion and plan consolidation

## Why this matters

TreeHopper should inherit the parts of Hunch that make native editing pleasant
and safe, without inheriting its flat-page ontology or product identity. A real
workspace import is the final proof that IDs, links, assets, Trash, and recovery
survive the transition. Deferring that proof until after feature work protects
the user's data and keeps parity decisions grounded in a stable Arbor provider,
not copied Hunch implementation details.

## Current state

- Hunch's visible feature inventory is documented in
  `/Users/joe/src/hunch/README.md:15-105`: native block editing, mentions,
  subpage rows, search, recovery, images, voice, multi-window navigation, and
  iCloud conflict/recovery behavior.
- Quagmire owns selection, edit/nav modes, inline marks, autotransforms,
  drag/reorder, gestures, emoji completion, undo, and optional host actions.
  TreeHopper should consume these rather than reimplement them.
- Hunch application code owns voice/transcription, link previews, page/search
  pickers, icons, banners, recovery UI, bookmarks, caches, menus, and Clamshell.
  Port behavior selectively behind Arbor-named provider/shell types.
- The `Hunch parity and intentional differences` section of `plan/native/README.md`
  defines parity as the same authored Arbor behavior through platform-native
  controls, not pixel identity, and already records the deliberate interruptions.
- The `Release gates` section of `plan/native/README.md` is the canonical acceptance
  inventory for the new TreeHopper app, remote Quagmire, Arbor cloud journal,
  Hunch dry run, and exact-artifact manual qualification.
- Hunch Markdown uses durable `clamshell-id` frontmatter and page-ID fragments;
  `.clamshell.json` stores Home; `Assets`, `Trash`, and `.history` carry related
  data (`App/Sources/Clamshell/README.md:16-47`).
- The flat Hunch link graph is not physical Arbor hierarchy. Import must not turn
  every page link into a directory move.

## Feature priority

| Tier | Capabilities | Reason |
|---|---|---|
| 1 — daily driver | open/create/edit, browser navigation, search, links/mentions, images/assets, Trash/restore, Recover, sync/conflict state, lifecycle drain | required before real-data import |
| 2 — Hunch strengths | voice recording/transcription, host block actions, emoji/icons, Markdown paste, link previews, move/copy/inline workflows, native menus/shortcuts, tabs/windows | high product value after storage safety |
| 3 — whole Arbor | heterogeneous files/collections, provenance, shared-tree boundaries, placements, unavailable nodes, whole-workspace search | required for TreeHopper parity with web |
| Later | scripts/islands, mutable collection UI, sharing/admin, agent surfaces | only after corresponding platform-neutral milestones exist |

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Quagmire | standalone `scripts/verify.sh` | exact consumed version passes |
| Native packages | `swift test --package-path native/Packages/ArborClient && swift test --package-path native/Packages/TreeHopperKit && swift test --package-path native/Packages/ArborCloud` | all pass |
| Protocols | `bun run test:protocol && bun run test:icloud-protocol` | REST complete-directory-Markdown and cloud fixtures pass in both languages |
| Root tests | `bun run typecheck && bun test && bun run build` | each exits 0 |
| macOS native tests | `xcodebuild test -project native/TreeHopper.xcodeproj -scheme TreeHopper -destination 'platform=macOS' -derivedDataPath /tmp/treehopper-release-macos CODE_SIGNING_ALLOWED=NO` | exit 0 |
| iOS native tests | `xcodebuild test -project native/TreeHopper.xcodeproj -scheme TreeHopper -destination 'platform=iOS Simulator,id=C76DE979-27D7-4BE5-AD11-3FC223402AB9' -derivedDataPath /tmp/treehopper-release-ios CODE_SIGNING_ALLOWED=NO` | exit 0 |
| Browser E2E | `bun run test:e2e` | all browser tests pass |
| Performance | `bun run test:performance` | baseline thresholds pass |
| Diff check | `git diff --check` | no output |

Run Xcode tests sequentially. Use a unique temporary derived-data path for every
command. Exact UI filters should be added as TreeHopper suites are created.

## Scope

**In scope**:

- `native/App/`, native package integrations, app resources, menus, tests.
- Provider-backed ports of selected Hunch product features.
- A read-only Hunch inventory/importer and Arbor iCloud v1 history conversion.
- Canonical docs/status updates after verified behavior lands.
- Release qualification on macOS and iOS 27.

**Out of scope**:

- Modifying the original Hunch workspace in place.
- Sharing the Hunch writer ID, defaults, cache, bookmark, bundle ID, or app
  support directory.
- Inferring Arbor folders from Hunch link/subpage relationships.
- Simultaneous Hunch and TreeHopper authorship of the same imported folder.
- New scripts/islands/sharing/agent product behavior not implemented in Arbor core.
- App Store submission or public announcement unless separately requested.

## Git workflow

- Branch: `codex/treehopper-parity-migration`.
- Land parity features in focused commits by capability.
- Keep importer implementation, fixture/dry-run evidence, and any real cutover as
  separate commits/operations. Never commit user workspace contents.
- Do not push or publish a release unless instructed.

## Steps

### Step 1: Freeze an explicit parity matrix

Create a checked-in native parity matrix with columns:

```text
Capability | Hunch behavior | TreeHopper/Arbor behavior | Owner
Status | Automated gate | Manual exact-artifact gate | Deferred reason
```

Classify every feature as Quagmire-owned, provider-owned, browser-shell-owned,
or platform integration. Use Arbor terminology: node, document, reference,
directory index link, physical child, tree, Trash. Do not rename a Hunch
assumption and call it parity.

At minimum include typing/undo, selection/gestures, drag, mentions, internal and
external links, create/move/copy/inline, assets, search, backlinks, recovery,
Trash, sync/conflict UI, source/properties, tabs/windows, voice, icons, paste,
link previews, shortcuts, accessibility, non-document surfaces, placeholders,
and helper/provider lifecycle.

**Verify**: every Tier 1/2 row has a named owner and executable automated or
manual gate; no row says only “same as Hunch.”

### Step 2: Finish the daily-driver browser and editor surfaces

Complete provider-backed create, rename, move, copy, Trash/restore, recovery,
backlinks, Home preference, source/properties, assets/import, and search.

Preserve these Arbor rules:

- navigation stores resolved tree scope plus PageID when available;
- the first eligible standalone link to an immediate physical child owns its
  directory-index placement, while inline/later/non-child links remain ordinary;
- link reorder is Markdown content and never implies a physical move;
- every legacy Hunch subpage interaction on Quagmire's neutral document-link row
  follows Plan 003's action matrix:
  navigation/create/icon/drop/move/inline/post-delete Trash decision are
  provider-backed for both stored and implicit directory Markdown where current
  authority permits, while an ineligible target stops visibly before the
  specified source mutation;
- H4-H6 retain their actual heading levels even though the authoring menu may
  continue offering only H1-H3;
- non-document surfaces never instantiate Quagmire;
- read-only/historical nodes disable mutations honestly;
- external updates replace/merge the same document without authored undo;
- every navigation/close/shutdown boundary flushes admitted generations;
- helper/provider failure becomes visible reconnect/resync state.

**Verify**: all Tier 1 rows pass their automated gates on the in-memory, arbord,
and direct iCloud providers where applicable.

### Step 3: Port Hunch-native strengths behind Arbor owners

Port behavior, not identity or storage code:

- voice recording/transcription and optional transcript-polish block action;
- emoji/icon selection, with page/node icon storage owned by the provider;
- image and Markdown paste through provider assets and Arbor serialization;
- link previews cached under TreeHopper's own Application Support directory;
- native menus, shortcuts, command enablement, banners, and accessibility;
- tab/window behavior over shared PageID coordinators;
- crash-safe move/copy/create/inline workflows from Plan 003.

Do not copy Hunch's `Diag` subsystem, defaults keys, filesystem URLs, page picker
model, cache roots, or Clamshell types. Search/pickers use provider results with
kind/path/tree provenance.

**Verify**: focused TreeHopper UI tests cover drag/reorder, edit scrolling,
keyboard/selection, mention insertion, image paste, voice delivery, menu routing,
and multiple tabs. Manual checks use the exact built artifact.

### Step 4: Build a non-mutating Hunch migration inventory

The importer accepts a Hunch/Clamshell root and produces a report without
writing the source or destination:

- live Markdown count and relative paths;
- every `clamshell-id`, duplicates, missing/invalid IDs;
- internal links/subpage rows and resolved/unresolved targets;
- `.clamshell.json` Home target;
- Assets count, sizes, and missing references;
- Trash pages and original-path collisions;
- `.history` devices, record counts, counterless/corrupt/truncated records;
- recovery blocks by alive/observed/tombstoned state;
- case/Unicode/path collisions under the destination filesystem;
- unsupported Markdown constructs and source-preservation risk.

Do not infer creation/authorship dates from filesystem or archive timestamps.
Do not infer folder containment from page links.

**Verify**: run against synthetic fixtures containing each anomaly. The command
is read-only by construction and a before/after source-tree hash is identical.

### Step 5: Implement copy-based conversion

Import into a new empty Arbor tree, never the Hunch folder. In deterministic
order:

1. Copy live Markdown and preserve every durable page ID. Convert
   `clamshell-id` to canonical `id` only in the destination; retain the original
   source untouched. Abort on duplicates rather than reminting silently.
2. Preserve relative physical paths. Rewrite internal destinations only when the
   inventory proved the target; attach/preserve PageID fragments and canonical
   Arbor relative links. Report unresolved links unchanged.
3. Convert `.clamshell.json` Home into TreeHopper's provider preference/control
   record. Do not copy the Hunch metadata file as active Arbor state.
4. Copy Assets byte-for-byte with hashes and verify every rewritten reference.
5. Import Trash into Arbor's recovery namespace with original location and
   collision metadata.
6. Convert `.history` to Arbor iCloud v1. Preserve each legacy device as a
   distinct imported writer, its causal counters, add/observe/purge authority,
   snapshots, and parent relationships. Re-fingerprint parseable snapshots with
   the Arbor algorithm; retain unparsable legacy source as a quarantined
   recoverable snapshot rather than dropping it.
7. Emit an import manifest with source hash, destination hash, counts, mappings,
   warnings, and tool/version identity. Never include secrets or full user text
   in ordinary logs.

The imported tree gets a new TreeHopper writer ID. It never reuses a Hunch
device/writer ID.

**Verify**: a second dry run produces the same manifest; importing the same
source twice into two empty destinations produces identical authored files and
equivalent recovery state.

### Step 6: Verify the migrated copy before opening it for edits

Compare source inventory to destination:

- live page count/path and ID set;
- resolved internal-link target set and unresolved-link report;
- Home target;
- asset count and byte hashes;
- Trash count/original locations;
- recoverable alive/observed/tombstoned content counts and sample renders;
- no `.clamshell.json` or active `.history` dependency in the destination;
- every directory-backed node canonicalizes to complete Markdown with exactly
  one placement owner per immediate physical child, zero or more ordinary
  duplicate references, no collection rows/virtual tables promoted to child
  links, and no Arbor-specific annotation syntax;
- no Hunch bundle/default/cache/writer identity in TreeHopper state.

Open the destination read-only first. Browse/search every node class and inspect
a representative sample of rich Markdown and recovery entries. Only after the
report is accepted may TreeHopper enable writes in the imported copy.

**Verify**: the import command emits a machine-readable PASS with zero blocking
differences. Warnings require explicit operator acceptance; they are not silently
downgraded.

### Step 7: Run the complete two-provider release matrix

Automated matrix:

- all Quagmire, Swift package, REST, cloud protocol, root, native app, browser
  E2E, and performance gates;
- macOS arbord and iOS direct provider on the same isolated iCloud test tree;
- simultaneous web/native arbord edits to one document;
- duplicate tabs and a final edit immediately before blur/close/termination;
- external edits, conflicts, helper restart, offline/placeholder state;
- cross-document failure injection and recovery import round trips.

Manual exact-artifact matrix:

- launch the app from the current derived build path, not an installed app with
  the same name;
- macOS window/tab/menu/voice/drag/search/recovery flows;
- iPhone and iPad layouts on the installed iOS 27 simulator/device environment;
- real iCloud foreground/background/offline/rename/delete/conflict scenarios;
- source inspection confirming exact no-op/envelope/raw/unchanged-block
  preservation, declared canonicalization only for edited/new/depth-changed
  blocks, complete directory Markdown, and no Arbor-specific managed-link
  annotations;
- Hunch remains independently usable against its original untouched workspace.

**Verify**: record toolchain, artifact paths, device/simulator IDs, suite counts,
known non-blocking limitations, and evidence in `plan/records/history.md` only after all
claimed gates actually pass.

### Step 8: Update canonical product documentation and release state

Reconcile `plan/native/README.md`, `plan/records/history.md`, `README.md`,
`docs/reference-implementation.md`, `docs/client.md`, and relevant specs.
Mark behavior implemented only when its source and gate exist. Keep later
scripts, collections, sharing, and agents visibly dependent on their core
milestones.

Document:

- exact Quagmire version;
- provider selection and single-writer rule;
- Arbor iCloud v1 namespace and exclusion;
- import/backout procedure;
- how to inspect sync/conflict/recovery state;
- how local development uses a Quagmire override and returns to a tag.

**Verify**: internal links resolve, commands match live project paths, and
`git diff --check` is clean.

## Test plan

- Maintain the parity matrix as the coverage index rather than copying all Hunch
  tests blindly.
- Prefer pure provider/session tests for correctness, app-hosted tests for native
  integration, and UI tests only for gestures/focus/menus that require them.
- Add importer fixtures for duplicates, broken links, unknown legacy records,
  counterless records, corrupt tail, Trash collision, missing assets, Unicode
  paths, and unsupported Markdown.
- Add machine-verifiable inventory equivalence plus sampled human source/recovery
  inspection.
- Retain a real iCloud qualification run because local temp-directory tests do
  not cover File Provider behavior.

## Done criteria

- [ ] Every Tier 1 and accepted Tier 2 parity row has passed evidence.
- [ ] TreeHopper uses its own app/bundle/default/cache/log/writer identity.
- [ ] macOS writes through arbord; iOS/direct mode writes through ArborCloud;
      neither competes on macOS.
- [ ] Quagmire is consumed at an exact remote version by Hunch and TreeHopper.
- [ ] The original Hunch workspace remains byte-for-byte untouched by import.
- [ ] The imported copy preserves page IDs, resolved links, Home, assets, Trash,
      and recoverable history, with blocking mismatches at zero.
- [ ] Flat Hunch links did not become inferred physical hierarchy.
- [ ] Arbord and direct-provider directory documents satisfy the same complete
      Markdown, first-link, first-write, duplicate-promotion, and conflict
      fixtures without managed-link annotations.
- [ ] No Hunch writer ID or active legacy sidecar is reused.
- [ ] Full automated and exact-artifact manual matrices pass on macOS/iOS 27.
- [ ] Canonical docs distinguish implemented, planned, and later work accurately.
- [ ] `plan/native/execution.md` marks Plan 005 DONE.

## STOP conditions

- Plans 003/004 are incomplete or any durability/conformance gate is flaky.
- The importer would modify the source Hunch folder or reuse its writer ID.
- A duplicate/missing PageID would be silently reminted.
- A link rewrite cannot prove its target.
- Legacy recovery content cannot be converted or quarantined without loss.
- Directory canonicalization loses, duplicates, or physically moves a child
  because of a Markdown link edit, or private sidecars enter Arbor publication.
- Hunch and TreeHopper would coauthor the same folder.
- A manual test launches an installed/stale artifact instead of the exact build.
- A meaningful feature is cut from the accepted parity tier without Joe's
  explicit approval.

## Maintenance notes

Hunch remains useful after TreeHopper ships: it is Quagmire's first production
host and a regression oracle for native editing. Do not make TreeHopper parity a
requirement that the products converge on the same navigation ontology, storage
format, or visible labels. Future Arbor features should enter native through
provider/surface additions, not by expanding Quagmire into a universal node UI.
