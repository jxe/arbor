# Usability 001: Name-based sharing, directory, and avatars

## Context

Sharing a tree in Canopy today means typing `~handle` or a full profile URL into a bare text field ([ArborRootView.swift:2482](../../swift/CanopyApp/ArborRootView.swift)). Access rows show an SF symbol and a `~handle` scraped from the locator ([AccountConfigurationYAML.swift:331](../../swift/Packages/OverstoryClient/Sources/OverstoryClient/AccountConfigurationYAML.swift)). Profile trees carry only `type` and `members` in their root frontmatter ([spec/04 §1](../../spec/04-accounts-and-devices.md)); there is no name or avatar field, no Swift parser for profile facts, no image loading in the app, and no server route that lists people. `plans/catalog.md:117` marks this as NEEDS DESIGN.

Goal: in the share pane, type a name, see matching people with avatars, pick one. Plus a "People" directory view. Joe decided:

- **Cache home:** new canopyd `GET /.arbor/directory` + a JSON cache on the native client.
- **Field names (atproto-style):** `displayName`, `avatar` (relative path to an image file inside the profile tree), `description`.
- **Reachable people:** members of the community tree, members of any readable `type: group` tree, and profiles already appearing as subjects in the caller's own access rules.

## Structural invariants

1. **Identity is the profile TreeID.** `displayName`/`avatar`/`description`/`handle` are presentation only. Nothing in `access.ts` or update acceptance reads them; malformed values are dropped, never rejected.
2. **Profile facts stay keyed by immutable root hash** in the `meta` table (`profile:<root>`). Old rows are lazily re-parsed; no migration.
3. **The directory never widens read access.** Identity fields (`profile`, `handle`, `locator`) come only from things the caller can already read. Card fields (`displayName`, `avatar`, `description`) appear only when `canopy.canRead(caller, profileTree)`. Avatar bytes go through the existing object route, which already enforces `isReadableObject` ([host.ts:700](../../packages/canopyd/src/host.ts)).
4. **The native directory is a derived cache.** `Directory.json` and `Avatars/` may be deleted at any time. Sharing still submits a TreeID through the existing `setShareAccess`; the picker only chooses which one.
5. **Raw input still works.** `~handle`, URL, or `tr_…` fall through to existing `resolveLocalProfile` / `resolveProfile`.

## Phase 1 — Profile schema, canopyd directory endpoint, TS wire, CLI

Shippable alone; old clients ignore the new fields.

**Spec** `spec/04-accounts-and-devices.md` §1: add the three fields with rules. `displayName` trimmed, 1–80 scalars, no line breaks. `avatar` a relative path inside the tree (no leading `/`, no `.`/`..`, extension in `png jpg jpeg gif webp`), so avatar visibility equals the profile tree's read access. `description` ≤ 500 scalars. Apply to person and group. Add a short "Directory" paragraph in `spec/05-access-control.md` §4 and `docs/canopy/design.md` next to "Profile control".

**Parser** [profile.ts](../../packages/canopyd/src/profile.ts): extend `RootProfileFacts` with `version: 2`, `displayName?`, `description?`, `avatar?: { path, hash }`. Resolve the avatar path to an object hash at parse time by walking child directories with `decodeWireDirectory`; omit on any failure. Export the validators so the CLI reuses them. Keep member-key strictness.

**Cache and card** [canopy.ts](../../packages/canopyd/src/canopy.ts): leave `rootProfile()` (2554) synchronous and unchanged for authorization callers. Add async `profileCard(root)` that returns the meta row if `version === 2`, else re-parses via `rootProfileFacts` and upserts (same statement as `cacheRootProfile`). Add `handleForProfile(profileTree)` (accounts table) and `readableGroupTrees(account)` (active, `rootProfileType === "group"`, `canRead`). `profileSource()` (137) gains optional `displayName`; community bootstrap (277) passes `config.name`.

**Builder** new `packages/canopyd/src/directory.ts`:
```ts
type DirectorySource = "community" | `group:${TreeID}` | "access";
interface DirectoryEntry { profile; kind: "person"|"group"|"unknown"; handle?; locator?; displayName?; description?; avatar?: {tree,path,hash}; sources: DirectorySource[] }
buildDirectory(canopy, account, origin): Promise<DirectoryEntry[]>
```
Steps: community members → each readable group tree (as its own `group` entry plus its members) → profile subjects of `accessEntries` on trees where `tree.accountID === account.id` → merge by `profile`, drop the caller's own profile, fill `handle` from accounts, `locator` via existing `arborLocator(descriptor(...))` when hosted here, card via `profileCard` only when `canRead`. Sort case-insensitively by `displayName ?? handle ?? locator ?? profile`.

**Route** [host.ts](../../packages/canopyd/src/host.ts) beside `/.arbor/trees` (358): `GET /.arbor/directory`, `requireAccount` (execution tokens rejected), envelope `{ snapshot, observedThrough }` so the Swift `WireSnapshotEnvelope` decodes it.

**TS wire**: `RemoteDirectoryEntry` in `packages/protocol` protocol types beside `AccessEntry`; `WireClient.directory()` in [client.ts](../../packages/protocol/src/transport.ts) beside `access()`. Add a fixture under `tests/fixtures/canopy/` and reference it from the protocol conformance test.

**CLI** [index.ts](../../packages/cli/src/index.ts) + [profile-identity.ts](../../packages/arborsync/src/state/profile-identity.ts): `arbor me create --name`, and new `arbor me set [--name] [--avatar <relative path>] [--description]` rewriting `_index.md` frontmatter while preserving body and unknown keys; `--avatar` checks the file exists. Document in `docs/arborsync/cli.md`.

**Tests**: unit `tests/unit/canopyd/profile-facts.test.ts` (accepted fields, oversize dropped, `../x.png` dropped, missing file dropped, nested path resolved, URL dropped). Integration `tests/integration/canopyd/directory.test.ts` modeled on `community-hosting.test.ts`: unhosted member is `kind: unknown` with handle; hosted public profile yields card + fetchable avatar hash; private profile yields identity only; readable group contributes `group:` source and its own entry; unreadable group absent; access-only profile has `sources: ["access"]`; self excluded; unauthenticated and execution token → 401.

**Plan file**: add `plans/swift/011-name-based-sharing-and-avatars.md` in the 010 format (Status, Outcome and ownership, "Before implementation inspect", phased checklists) and replace catalog row 117 with a link.

## Phase 2 — Native store, avatars, share-panel autocomplete

**Swift wire** [WireModels.swift](../../swift/Packages/Overstory/Sources/Overstory/WireModels.swift): `WireDirectoryEntry` (Identifiable by `profile`; call the description field `summary` via CodingKeys) and `WireDirectoryAvatar`. `ArborWireClient.directory()` beside `access(tree:)` (274); avatar bytes via existing `object(tree:hash:)` (114). `NativeAccountService` gets `directory()` and `object(tree:hash:)` pass-throughs for iOS.

**Pure model** new `swift/Packages/OverstoryClient/Sources/OverstoryClient/Directory.swift`: `DirectoryPerson { origin, entry, title, subtitle, initials }` and `DirectoryMatcher.matches(query, in:)` using case- and diacritic-insensitive folding over displayName, handle, locator, profile; `~` prefix stripped. Merge rule across origins: keep the richer card, union sources.

**Store** new `swift/ArborApp/ArborDirectory.swift` following `VisitedTreeStore` ([ArborVisits.swift:33](../../swift/CanopyApp/ArborVisits.swift)): `DirectoryStore` actor over `Directory.json` (`{version, origins: [origin: {fetchedAt, entries}]}`), plus `AvatarCache` actor over `Avatars/<hash>` (fetch via origin Overstory client, reject > 2 MB, downsample to 128 pt in memory). Add both paths to `ArborSupportDirectories`. `ArborWorkspaceState.directory: [DirectoryPerson]` and `refreshDirectory(force:)` per account origin (Mac: arborsync overview accounts via `wireClient(origin:overview:)`; iOS: native placements via `NativeAccountService`), errors per origin logged, debounced 60 s; hooked after the overview refresh so the foreground scenePhase hook covers it.

**AvatarView**: circle, `Image(nsImage:)`/`Image(uiImage:)`, initials on a tint chosen from the TreeID hash, SF symbol fallback when no person (keeps Everyone/link rows as today).

**Share panel** [ArborRootView.swift:2479](../../swift/CanopyApp/ArborRootView.swift): replace the TextField with `ArborPeoplePicker(query:people:excluding:onPick:)` structured like `ArborSearchPalette` ([ArborDailyDriverViews.swift:277](../../swift/CanopyApp/ArborDailyDriverViews.swift)): up to 8 rows with avatar, title, subtitle (handle · host), group badge; arrow/Return keys. No directory match but raw tokens → one "Add <raw>" row using existing `addProfiles`. Pick → `addProfiles([profile])` (bare TreeID is accepted by both resolvers). `accessIcon(for:)` (2588) → `AvatarView`; `label`/`detail` prefer the directory person, with `NativeTreeAccessEntry.displayName` as fallback so `presentedAccessEntries` and its tests are untouched. Keep the picker access-agnostic so group management can reuse it later.

**Tests**: `OverstoryClientTests/DirectoryTests.swift` (matcher, merge, initials); Overstory decode test on the shared fixture; `CanopyAppTests` store round-trip in a temp dir and avatar path sanitization.

## Phase 3 — People view and editing your own profile

**View** new `swift/ArborApp/ArborDirectoryView.swift`: searchable list, sections People / Groups, rows with avatar + title + subtitle + source chips, Refresh toolbar button, "Open profile" (disabled with "Not hosted" when no locator). Homes: macOS `MacManagementTab.people` in the segmented picker ([ArborRootView.swift:1690](../../swift/CanopyApp/ArborRootView.swift)) reusing the existing `openProfile` closure, plus a "People…" command in `ArborWindowCommands`/`ArborApp.swift`; iOS a "People" row in the account panel pushing the view.

**Own profile**: "Edit name & photo…" beside "Open profile" in `MacArborSyncAccountPanel` opening the profile root `_index.md` in the normal editor; users add frontmatter and drop the image file in. Document in `docs/canopy/design.md`. A dedicated two-field sheet is deferred unless the editor already exposes frontmatter editing.

**Docs**: finish the `docs/canopy/design.md` Directory section (People tab, refresh, cache locations); update the plan file status and `status.md`.

## Verification

- Phase 1: `bun run typecheck`; `bun test tests/unit/canopyd/profile-facts.test.ts tests/integration/canopyd/directory.test.ts`; `bun run test` (known parallel flakes, rerun singly); `git diff --check`.
- Phase 2/3: `swift test --package-path swift/Packages/OverstoryClient`, `swift test --package-path swift/Packages/Overstory`, `xcodebuild test -workspace swift/Canopy.local.xcworkspace -scheme Canopy -destination 'platform=macOS'` plus an iOS simulator destination. Never build CanopyEditor standalone.
- End to end: two accounts on a disposable canopyd; `arbor me set --name --avatar`; open Share on Mac and iOS, type part of the name, confirm avatar row and pick; confirm the access row shows name + avatar; delete `Directory.json` and `Avatars/`, confirm cold rebuild; confirm a private profile shows handle only.
