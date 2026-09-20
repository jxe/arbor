# Cleanup 002: Retire v1 account and legacy local-state adapters

> **Gate refresh (2026-09-18):** `test:e2e` is currently absent. Use maintained
> gates from [DEVELOPMENT.md](../../DEVELOPMENT.md). Browser acceptance remains
> required where this plan changes browser behavior: establish focused coverage
> for available surfaces, and coordinate restored editor E2E with
> [Web 025](../canopy-web/025-arbor-web.md) (formerly Web 023). Do not claim
> browser verification from a passing build alone.

> **Drift check:** reconcile this plan against Migration 003, the current
> canopyd schema stamp, every Overstory data home, account bootstrap routes, native
> client methods, person-profile identity work, and the v1/v2 policy branches
> before changing code. The
> original 2026-08-28 audit named data-home relocation, CLI checkout migration,
> and `system/roots` diagnostics; those three paths are already gone and must
> not be recreated as part of this cleanup.

## Status

- **Priority:** P2
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** Migration 003's rollback observation window ending on or
  after 2026-09-17; all supported canopyd, Mac, and iPhone state being proven
  v2/current; removal of the retained rollback backups by Joe; and explicit
  approval to close the v1 compatibility window
- **Progress:** READY — the read-only receipt below passed on 2026-09-20;
  the remaining gates are Joe's backup removal and the iPhone check. See
  "Coupling found on 2026-09-20" before executing: the phases cannot be
  committed independently as written.
- **Written against:** `2c81ef5`, 2026-09-04; receipt against `1b1710d6`

## Receipt, 2026-09-20 (read-only)

Live canopyd could not be queried from the agent session, so the check used
the newest Railway backup, `.backups/railway/20260919T155020Z/migrated`:

- `trees.policy`: `account-config-v2` ×1, `ordinary` ×4, no `account-config-v1`.
- `accounts`: 1. `meta.schema_version`: 14.
- Every cached `profile:*` member list is object-shaped; no string members.
- Default Mac home: stamp 5, `accounts/tr_boseki5agb24ysc6cxakwcq57i`,
  `placements.yaml`, no root `account.yaml`/`trees.yaml`/`devices/`, no
  `.state/system/community.md`, no `.state/device.json`.
- Workspace registry: 109 object-valued records, all with `stateID`, `rootID`
  and `path`; 106 `rt_` and 3 `tr_` identities.
- Not checked: the current iPhone build, and whether the Migration 003
  backups have aged out (Joe). Phase 1's private-state move and its tests
  were already removed on 2026-09-19; the registry shape readers remain.

## Coupling found on 2026-09-20

`canopyd.ensureAccountConfigTrees` (`packages/canopyd/src/canopy.ts`) creates an
`account-config-v1` configuration tree at startup for any account that lacks
one. `serveCanopy({ accounts: [...] })` relies on it, and eleven test files
plus `tools/hcloud-sync-lab.ts` seed their canopyd that way and then read the
result with `readAccountConfigGraph`/`snapshotAccountConfig` and install it
locally as the singleton layout through `saveCurrentDeviceID` and
`CommunityConfigStore`. Removing the local adapter alone (Phase 2) therefore
breaks `self-sync`, `server`, and `protocol/conformance`, and removing the
canopyd policy alone (Phase 3) breaks the seeding path those same suites use.

Execute instead as one change with this order, verifying at each step:

1. Make `ensureAccountConfigTrees` emit a v2 graph (`snapshotAccountConfigV2`
   with `canonical` URLs and `administrator` devices) and insert
   `account-config-v2`. Existing v2 tests still pass; v1-reading fixtures fail.
2. Convert the fixtures to v2: `self-sync`, `server`, `protocol/conformance`,
   `canopy/update-host`, `merge/tool` (drop its v1 case), and the hcloud lab
   script. Local installation uses `accounts/<cfg>/` + `placements.yaml` +
   `CanopyAccountStore`, as `cli-sync.test.ts` already does via
   `LocalAccountService.claimCanopyAccount`.
3. Then delete: `packages/canopyd/src/account-policy.ts`,
   `packages/canopyd-merge/src/account.ts`, the `AnyAccountConfigGraph`/`v2Graph`
   branches in `canopy.ts`, `account-config-v1` in `model.ts`,
   `merge/src/{index,contract,summary}.ts`, `docs/merge-tool.md` wording.
4. Then the local adapter: `packages/protocol/src/config/account-config.ts` (keep
   nothing; `/v1/status` drops `deviceID`, which only fixtures set),
   `loadLegacySingletonTreeRegistry` and the `plural` flag in `trees.ts` and
   `tree-manager.ts`, `CommunityConfigStore` and `communityCredentialName` in
   `server-config.ts`, the `communityConfig` dep in `ports.ts`,
   `account-bootstrap.ts`, `account-wire.ts`, `server.ts`,
   `sync-connections.ts`, `account-service.ts`, and `local-accounts.ts`.
5. Finally the registry readers: `StoredWorkspaceRegistry` becomes
   object-only, `rootIDForInitialPath` goes, and the remaining private-state
   tests assert the current shape.

## Why this remains a cleanup

Migration 003 completed the persistent canopyd, default Mac home, and iPhone
cutover from the singleton v1 account graph to plural v2 accounts on
2026-09-03. The current product layout is now `accounts/<ConfigurationTreeID>/`
plus local `placements.yaml`, and new browser account claims use a complete
account locator.

Runtime code still accepts and creates the former model alongside v2:

- `packages/protocol/src/config/account-config.ts` parses and watches root-level
  `account.yaml`, `trees.yaml`, and `devices/`;
- `packages/arborsync/src/state/trees.ts` retains the complete singleton tree-registry
  adapter and its private community record;
- `packages/protocol/src/config/server-config.ts` retains `CommunityConfigStore` and an
  opportunistic legacy credential-reference migration;
- `packages/client/src/account-bootstrap.ts` still depends on the singleton
  community record for compatibility paths, although public claiming now uses
  the plural-account bootstrap and the old Swift claim convenience is gone;
- `packages/canopyd/src/account-policy.ts` and branches in `canopy.ts` continue
  to validate, authorize, merge, create, and serve `account-config-v1` trees;
- tests, E2E setup, protocol fixtures, and the hcloud lab still construct v1
  account graphs even though production state has migrated.

Separately, `packages/protocol/src/config/private-state.ts` still moves seven old
root-level private entries beneath `.state` on every startup and accepts the
old string-valued or missing-`rootID` workspace registry shapes. These are
one-time alpha readers, not durable product formats.

The deletion should remove several hundred lines and, more importantly, leave
one account/configuration model and one local-state shape. It must not alter
authored trees, current account identities, existing workspace `rootID`s, or
rollback data before the retention window closes.

## Evidence already established

Migration 003 records that canopyd schema 5, the default Mac state/layout 4,
and the deliberately-last live iPhone pairing and re-placement check passed on
2026-09-03. Its canopyd archive, restored copies, local-home backup, reports,
and manifests are deliberately retained for two weeks.

A read-only check on 2026-09-04 found the default Mac home has:

- private-state stamp `4`;
- two plural account checkout directories and `placements.yaml`;
- no root-level v1 account files, legacy private entries, singleton community
  record, or singleton device record;
- 109 object-valued workspace registry records, all with a `rootID`, including
  107 retained `rt_` identities and two generated `tr_` identities.

That local result is necessary but not sufficient. In particular, the `rt_`
values are durable identities that survived the shape migration; this cleanup
must accept them as current records and must never remint them merely to remove
the old string/missing-field readers.

## Execution sequence

### 0. Prove the compatibility window can close

After the observation window, collect one read-only private receipt covering:

1. The live canopyd schema matches the current deployed code (record the exact stamp;
   do not require or restore Migration 003's historical schema 5), contains no tree whose policy is
   `account-config-v1`, and every account points to a decodable v2 configuration
   tree.
2. Every active local Overstory data home has the current private-state stamp,
   plural `accounts/`, valid `placements.yaml`, no root-level v1 account graph,
   no legacy private entries, and no singleton community/device record.
3. Every workspace registry value is an object with `stateID`, `rootID`, and
   `path`. Record counts by `rootID` prefix without changing the values.
4. The current iPhone build still opens, lists the migrated account, and can
   synchronize one reversible edit. No supported old build needs the v1 claim,
   pairing, configuration, or Overstory policy.
5. Joe confirms the Migration 003 rollback artifacts have aged out and removes
   the retained backups. An agent must not delete those backups.

Store only safe counts, stamps, target names, timestamps, and pass/fail results
under `~/.arbor/.state/migration/v1-compatibility-cutoff-<timestamp>/receipt.json`.
Do not store credentials, credential digests, authored content, or full private
configuration sources.

Stop and ask Joe before source changes if any target is inaccessible, any v1
state remains, an old client must still work, or rollback retention is extended.

### 1. Require the current private-state shape

- Remove `LEGACY_PRIVATE_ENTRIES` and `migratePrivateState`; startup creates and
  versions `.state` directly.
- Change `StoredWorkspaceRegistry` to object-valued records only. Remove the
  string-value and missing-`rootID` upgrades while retaining canonical-path and
  device/inode refresh behavior.
- Remove `rootIDForInitialPath` and the unreferenced `privateRootID` helper once
  no production or migration caller remains.
- Preserve every existing `rt_` or `tr_` `rootID` byte-for-byte. This is a
  reader cutoff, not an identity migration.
- Replace migration tests with current-shape, malformed-state, and identity-
  preservation tests. A malformed old registry must fail clearly; it must not
  be silently normalized or overwritten.

Commit this phase independently after focused store and workspace tests pass.

### 2. Remove the local singleton account adapter

- Delete the v1 account/device/tree parser and watcher in
  `packages/protocol/src/config/account-config.ts` and remove its barrel exports.
- Delete `loadLegacySingletonTreeRegistry`, its fallback, the `plural: false`
  projection, and the optional singleton `configuration` result. Keep only the
  plural account and local-placement projection.
- Remove `CommunityConfigStore`, the singleton credential path, and its
  opportunistic credential-reference migration after the audit proves no
  record or credential still depends on it. Keep `CanopyAccountStore`.
- Remove the remaining singleton bootstrap dependencies. Keep the complete
  account-locator bootstrap as the sole claim path, preserving its current
  self-certifying person-profile identity, restart-safe credential, snapshot,
  and workspace-binding behavior.
- Make account listing, pairing, forgetting, synchronization, and system-tree
  presentation configuration-TreeID-aware without singleton fallbacks.

Commit this phase independently. Do not mix it with canopyd policy deletion: a
failed local-adapter change must remain easy to revert and diagnose.

### 3. Remove canopyd's v1 account policy

- Delete `packages/canopyd/src/account-policy.ts` and use the v2 graph directly
  instead of `AnyAccountConfigGraph`, `v2Graph`, and paired v1/v2 branches.
- Remove the v1 claim/create path, v1 pairing behavior, v1 activation rule,
  v1 authorization/merge branches, and `account-config-v1` from the model.
- Make schema-5 startup fail with an explicit migration-required diagnostic if
  an `account-config-v1` row is encountered. Never reinterpret, mutate, or
  delete such a row in normal startup.
- Convert E2E, hcloud, protocol, self-sync, update-host, and community-hosting
  fixtures to v2. Preserve their existing behavioral assertions; do not delete
  synchronization, authorization, exact-retry, or conflict coverage merely
  because its setup formerly used v1.

Commit this phase independently after the live-copy verification below.

### 4. Close the migration and documentation

- Update `docs/local-system.md` from a pending account-layout cutover to the
  completed v2-only layout.
- Keep the plural-account bootstrap documented as the sole account-claim
  endpoint and remove any remaining singleton claim examples.
- After Joe confirms the retained rollback data is gone, delete
  `migrations/003-multi-canopy-accounts/`; its durable outcome remains in
  Interface 005 and `plans/_done/outcomes.md`.
- Replace links from durable historical outcomes to the deleted migration
  directory with a past-tense summary or the retained Interface 005 record;
  closure must not knowingly leave broken documentation links.
- Search for stale `legacy`, `singleton`, `account-config-v1`, root-level
  account graph, and Migration 003 instructions. Keep only historical wording
  that is explicitly past tense and still useful.
- Record the cutoff receipt and verification evidence in `status.md`, then delete
  this plan and update the cleanup index.

## Verification

Use Migration 003's retained rehearsal evidence rather than retargeting its
schema-5 fixture to the current build, then run the focused compatibility
suites while each phase still exists:

```sh
bun test tests/unit/private-state.test.ts tests/unit/trees.test.ts
bun test tests/unit/canopyd/account-policy-v2.test.ts
bun test tests/integration/canopyd/update-host.test.ts tests/integration/canopyd/community-hosting.test.ts tests/integration/self-sync.test.ts
bun run typecheck
bun run test:protocol
bun test
bun run build
swift test --package-path canopy-swift/Packages/ArborSyncClient
swift test --package-path canopy-swift/Packages/Overstory
xcodebuild build -workspace canopy-swift/Canopy.local.xcworkspace -scheme Canopy -destination 'platform=macOS' -derivedDataPath /tmp/arbor-v1-cutoff-macos CODE_SIGNING_ALLOWED=NO
xcodebuild build-for-testing -workspace canopy-swift/Canopy.local.xcworkspace -scheme Canopy -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/arbor-v1-cutoff-ios CODE_SIGNING_ALLOWED=NO
git diff --check
```

Build macOS and iOS sequentially. Before committing the canopyd deletion, serve
a restored copy of the post-Migration-003 data with the candidate build and run
the existing migration verification tool against it. The copy must remain
at its recorded current schema and every account, tree, access rule, device, root, and placement
reported by the safe receipt must agree.

Final searches:

```sh
rg -n 'account-config-v1|CommunityConfigStore|loadAccountConfiguration|loadLegacySingletonTreeRegistry|claimLegacyProfileBootstrap' packages native tests tools docs
rg -n 'LEGACY_PRIVATE_ENTRIES|migratePrivateState|rootIDForInitialPath|privateRootID|Record<string, string \\| WorkspaceRegistryRecord>' packages tests
```

Both searches must have no production compatibility caller. Historical plans
may retain past-tense evidence; active docs and fixtures must describe v2 only.

## Done criteria

- [ ] The cutoff receipt covers the live canopyd, every active data home, the
  current iPhone, workspace-registry shapes, and client compatibility.
- [ ] Joe has confirmed and performed removal of Migration 003 rollback data.
- [ ] Startup reads only the current `.state` and object-valued registry shape
  while preserving every existing workspace `rootID`.
- [ ] Local Arbor Sync reads only plural account checkouts and local
  `placements.yaml`; it has no singleton record, credential, claim, or watcher.
- [ ] canopyd accepts, authorizes, merges, and serves only v2 account graphs and
  diagnoses an unexpected v1 policy without mutating it.
- [ ] Browser, CLI, native, E2E, hcloud, and protocol fixtures use the v2 account
  surface without losing behavioral coverage.
- [ ] Migration 003's repository artifact is deleted only after its backups
      age out; durable outcome evidence remains.
- [ ] Focused tests, full TypeScript tests/build/E2E, Swift packages, both native
  platform builds, live-copy verification, and `git diff --check` pass.

## STOP conditions

- The observation or backup-retention window has not ended.
- Any live canopyd tree still uses `account-config-v1` or any active local home
  still has a singleton/mixed layout.
- A supported Mac, iPhone, CLI, browser, or automation still calls the v1 route
  or expects the v1 graph.
- A workspace registry lacks a complete record, or execution proposes replacing
  an existing `rt_` identity with a new `tr_` identity.
- Removing a compatibility reader would require rewriting authored content or
  deleting private state rather than rejecting an unsupported old shape.
- The restored post-migration copy cannot open and verify under the candidate
  v2-only build.
- Rollback data would be deleted by an agent or before Joe confirms expiry.
