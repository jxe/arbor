# Cleanup 002: Retire v1 account and legacy local-state adapters

> **Drift check:** reconcile this plan against Migration 003, the current
> Canopy schema stamp, every Arbor data home, account bootstrap routes, native
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
  after 2026-09-17; all supported Canopy, Mac, and iPhone state being proven
  v2/current; removal of the retained rollback backups by Joe; and explicit
  approval to close the v1 compatibility window
- **Progress:** WAITING — audit now, but do not remove compatibility code or
  migration artifacts before the cutoff gates pass
- **Written against:** `2c81ef5`, 2026-09-04

## Why this remains a cleanup

Migration 003 completed the persistent Canopy, default Mac home, and iPhone
cutover from the singleton v1 account graph to plural v2 accounts on
2026-09-03. The current product layout is now `accounts/<ConfigurationTreeID>/`
plus local `placements.yaml`, and new browser account claims use a complete
account locator.

Runtime code still accepts and creates the former model alongside v2:

- `packages/stores/src/account-config.ts` parses and watches root-level
  `account.yaml`, `trees.yaml`, and `devices/`;
- `packages/stores/src/trees.ts` retains the complete singleton tree-registry
  adapter and its private community record;
- `packages/stores/src/server-config.ts` retains `CommunityConfigStore` and an
  opportunistic legacy credential-reference migration;
- `packages/arborsync/src/account-bootstrap.ts` can still create a v1 graph,
  and `/v1/bootstrap/claims` plus the Swift client still expose that path;
- `packages/canopy/src/account-policy.ts` and branches in `canopy.ts` continue
  to validate, authorize, merge, create, and serve `account-config-v1` trees;
- tests, E2E setup, protocol fixtures, and the hcloud lab still construct v1
  account graphs even though production state has migrated.

Separately, `packages/stores/src/private-state.ts` still moves seven old
root-level private entries beneath `.state` on every startup and accepts the
old string-valued or missing-`rootID` workspace registry shapes. These are
one-time alpha readers, not durable product formats.

The deletion should remove several hundred lines and, more importantly, leave
one account/configuration model and one local-state shape. It must not alter
authored trees, current account identities, existing workspace `rootID`s, or
rollback data before the retention window closes.

## Evidence already established

Migration 003 records that Canopy schema 5, the default Mac state/layout 4,
and the deliberately-last live iPhone pairing and re-placement check passed on
2026-09-03. Its Canopy archive, restored copies, local-home backup, reports,
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

1. The live Canopy is at schema 5, contains no tree whose policy is
   `account-config-v1`, and every account points to a decodable v2 configuration
   tree.
2. Every active local Arbor data home has the current private-state stamp,
   plural `accounts/`, valid `placements.yaml`, no root-level v1 account graph,
   no legacy private entries, and no singleton community/device record.
3. Every workspace registry value is an object with `stateID`, `rootID`, and
   `path`. Record counts by `rootID` prefix without changing the values.
4. The current iPhone build still opens, lists the migrated account, and can
   synchronize one reversible edit. No supported old build needs the v1 claim,
   pairing, configuration, or Wire policy.
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
  `packages/stores/src/account-config.ts` and remove its barrel exports.
- Delete `loadLegacySingletonTreeRegistry`, its fallback, the `plural: false`
  projection, and the optional singleton `configuration` result. Keep only the
  plural account and local-placement projection.
- Remove `CommunityConfigStore`, the singleton credential path, and its
  opportunistic credential-reference migration after the audit proves no
  record or credential still depends on it. Keep `CanopyAccountStore`.
- Delete the v1 claim writer and pending-bootstrap shape. Make the complete
  account-locator bootstrap the sole claim path, preserving the current
  self-certifying person-profile identity and workspace-binding contract.
- Remove `/v1/bootstrap/claims`, the `layout` switch, and the unused Swift
  `claimProfile` convenience. Keep `/v1/bootstrap/accounts` with its current
  restart-safe credential and snapshot behavior.
- Make account listing, pairing, forgetting, synchronization, and system-tree
  presentation configuration-TreeID-aware without singleton fallbacks.

Commit this phase independently. Do not mix it with Canopy policy deletion: a
failed local-adapter change must remain easy to revert and diagnose.

### 3. Remove Canopy's v1 account policy

- Delete `packages/canopy/src/account-policy.ts` and use the v2 graph directly
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
- Document `/v1/bootstrap/accounts` as the sole account claim bootstrap and
  remove the old claims route from `docs/arborsync-api.md` and client examples.
- After Joe confirms the retained rollback data is gone, delete
  `migrations/003-multi-canopy-accounts/`; its durable outcome remains in
  `plans/_done/interfaces/005-multi-canopy-connections.md` and
  `plans/_done/outcomes.md`.
- Replace links from durable historical outcomes to the deleted migration
  directory with a past-tense summary or the retained Interface 005 record;
  closure must not knowingly leave broken documentation links.
- Search for stale `legacy`, `singleton`, `account-config-v1`, root-level
  account graph, and Migration 003 instructions. Keep only historical wording
  that is explicitly past tense and still useful.
- Record the cutoff receipt and verification evidence, then move this plan to
  `_done/cleanups/` and update the cleanup index.

## Verification

Run the migration's own fixture before deleting its directory, then the focused
compatibility suites while each phase still exists:

```sh
bun test migrations/003-multi-canopy-accounts
bun test tests/unit/private-state.test.ts tests/unit/trees.test.ts
bun test tests/unit/canopy/account-policy-v2.test.ts
bun test tests/integration/canopy/update-host.test.ts tests/integration/canopy/community-hosting.test.ts tests/integration/self-sync.test.ts
bun run typecheck
bun run test:protocol
bun test
bun run build
bun run test:e2e
swift test --package-path native/Packages/ArborClient
swift test --package-path native/Packages/ArborWire
xcodebuild build -project native/Arbor.xcodeproj -scheme Arbor -destination 'platform=macOS' -derivedDataPath /tmp/arbor-v1-cutoff-macos CODE_SIGNING_ALLOWED=NO
xcodebuild build-for-testing -project native/Arbor.xcodeproj -scheme Arbor -destination 'platform=iOS Simulator,id=C76DE979-27D7-4BE5-AD11-3FC223402AB9' -derivedDataPath /tmp/arbor-v1-cutoff-ios CODE_SIGNING_ALLOWED=NO
git diff --check
```

Build macOS and iOS sequentially. Before committing the Canopy deletion, serve
a restored copy of the post-Migration-003 data with the candidate build and run
the existing migration verification tool against it. The copy must remain
schema 5 and every account, tree, access rule, device, root, and placement
reported by the safe receipt must agree.

Final searches:

```sh
rg -n 'account-config-v1|CommunityConfigStore|loadAccountConfiguration|loadLegacySingletonTreeRegistry|claimLegacyProfileBootstrap|/v1/bootstrap/claims' packages native tests tools docs
rg -n 'LEGACY_PRIVATE_ENTRIES|migratePrivateState|rootIDForInitialPath|privateRootID|Record<string, string \\| WorkspaceRegistryRecord>' packages tests
```

Both searches must have no production compatibility caller. Historical plans
may retain past-tense evidence; active docs and fixtures must describe v2 only.

## Done criteria

- [ ] The cutoff receipt covers the live Canopy, every active data home, the
  current iPhone, workspace-registry shapes, and client compatibility.
- [ ] Joe has confirmed and performed removal of Migration 003 rollback data.
- [ ] Startup reads only the current `.state` and object-valued registry shape
  while preserving every existing workspace `rootID`.
- [ ] Local Arbor Sync reads only plural account checkouts and local
  `placements.yaml`; it has no singleton record, credential, claim, or watcher.
- [ ] Canopy accepts, authorizes, merges, and serves only v2 account graphs and
  diagnoses an unexpected v1 policy without mutating it.
- [ ] Browser, CLI, native, E2E, hcloud, and protocol fixtures use the v2 account
  surface without losing behavioral coverage.
- [ ] Migration 003's repository artifact is deleted only after its backups
  age out; durable outcome evidence remains.
- [ ] Focused tests, full TypeScript tests/build/E2E, Swift packages, both native
  platform builds, live-copy verification, and `git diff --check` pass.

## STOP conditions

- The observation or backup-retention window has not ended.
- Any live Canopy tree still uses `account-config-v1` or any active local home
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
