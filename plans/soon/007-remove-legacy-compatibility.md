# Cleanup 007: Remove legacy compatibility now that the one install is converted

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** LOW for code; phase 3 renames the Mac data home, so it stops
  Arbor Sync briefly and needs Joe's go-ahead.
- **State:** PLANNED 2026-09-26, after migration 022. Joe's Mac, iPhone and the
  arb.nxhx.org host are the only install, and all three run schema 22 clients.
- **Builds on:** [tree configurations](../../docs/architecture/canopyd/tree-configurations.md)
  and [migration 022](../../packages/canopyd/migrations/022-tree-configurations/README.md).

Every item below exists only to read or convert state that no longer exists.
Each phase first checks the live data or the Mac for that state, so nothing is
removed while something still depends on it.

## Phase 1: What migration 022 added

- **iPhone account rekey.** `rekeyStoredAccounts`
  (`swift/Packages/OverstoryClient/Sources/OverstoryClient/Credentials.swift`)
  and its launch call in `KeychainAccountService.accounts()`
  (`swift/CanopyApp/CanopyAccountService.swift`), plus its test in
  `AccountPairingTests.swift`. Check first: the iPhone's Settings → Accounts
  shows the account under `tr_dgdsyb…` (it rekeyed on its first 022 launch).
- **The migration's own code.** `packages/canopyd/migrations/022-tree-configurations/`
  (`run.ts`, `legacy.ts`, `rekey-data-home.ts`, the test) goes with its backups
  on or after 2026-10-10, as the migration procedure already says. With it goes
  the last reader of `account.yaml` / `trees.yaml`, so the known gap
  "Compatibility cutoff" in `status.md` shrinks to the workspace-registry note.
  Directories 018–021 are due too (their backups age out 2026-10-08/09).
- **Keep:** `NativePlacementStore` dropping records it cannot read
  (`swift/CanopyApp/CanopySupportDirectories.swift`, `usable`). It was added for
  the pre-022 record, but it is the right behaviour for any cache the daemon can
  rebuild: without it one bad record made every tree fail to open.

## Phase 2: Older compatibility found while surveying

Each is dead for this install only if the check finds nothing.

- **Scalar `/~handle` group members.** `legacyMemberHandle`,
  `LEGACY_HANDLE_LOCATOR` and the `legacy` member flag
  (`packages/canopyd/src/profile.ts`), `legacyHandles` and the handle branch of
  `isProfileMember` (`packages/canopyd/src/canopy.ts`, `access.ts`), and the
  `json_extract(... '$.legacy')` reservation query. Check: no hosted group or
  root `_index.md` lists a member as a bare string (live `profile_facts`).
- **Pre-plural account files.** The `account.yaml` / `trees.yaml` / `devices/`
  refusal in `claimHostAccountBootstrap`
  (`packages/client/src/account-bootstrap.ts`). Check: none exist at the top of
  `~/.arbor`.
- **Placements without a configuration tree.** `configurationTree?` in
  `TreePlacement` (`packages/protocol/src/config/placement.ts`) and the
  `?? "legacy"` / `legacy:${endpoint}` account keys in
  `packages/arborsync/src/folder-sync.ts` and `service.ts`. Check: every
  `placements.yaml` entry sits under a configuration TreeID (it does today).
- **Path-derived `rt_` root IDs.** The normalization in
  `packages/protocol/src/config/private-state.ts`. Check: no `rt_` in
  `~/.arbor/.state` registries.
- **Keychain identities without metadata.** The `security find-generic-password`
  probe in `packages/arborsync/src/state/profile-identity.ts`, and Canopy's
  second native identity reconciliation (`legacy`, `legacyConflict` in
  `swift/CanopyApp/CanopyOnboarding.swift`). Check: the Keychain holds only the
  indexed identity for `tr_tkgfsm…`, on the Mac and the iPhone.

## Phase 3: Name what the data home holds

`~/.arbor/accounts/<ConfigurationTreeID>/` is the checkout of the profile's
tree configuration, and the code still calls it an account configuration
(`AccountConfigurationYAML`, `loadAccountConfigurations`,
`editAccountConfigurationFile`, `AccountConfigurationSnapshot`). Rename the
directory to `~/.arbor/configurations/<ConfigurationTreeID>/`, matching the
spec's term and its key, and the code to `ProfileConfiguration…` or
`TreeConfiguration…` where it already means any tree's. Canopy labels it
"~joe settings" and keeps doing so. A one-time data-home step (stop Arbor Sync,
`mv`, start) replaces a compatibility reader: there is one install.

Decide before starting: `configurations/` (recommended) or `settings/`.

## Verification

`bun run typecheck`, `bun run test`, `bun run test:protocol`, the full
`CanopyAppTests` bundle, the Swift package suites, `bun run check:links` and
`git diff --check`; for phase 2's canopyd items a deploy and `verify.ts`; for
phase 3, Arbor Sync back `idle` on every placement and a round-trip edit from
the Mac and the iPhone. Record the result in `status.md` and delete this plan.
