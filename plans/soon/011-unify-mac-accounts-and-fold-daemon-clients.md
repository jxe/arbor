# Native 011: Unify Mac account management with iOS

Status: NEEDS DECISION. The client folds, the pairing-offer route and the
forget route are done (see [status](../../status.md#native-011-daemon-client-folds--2026-09-24));
what remains is blocked on one design choice about where the Mac keeps its
identity and account credentials. Sole user; no compatibility shims.

## What is done

- The TypeScript daemon client is CLI code (`packages/cli/src/daemon-client.ts`);
  `@overstory/arborsync-client` is deleted and the four disposable-daemon
  tests import the CLI module.
- The Swift daemon client (REST client, loopback credential provider and
  object store, process supervisor, models) is app code in
  `swift/CanopyApp/ArborSync/` behind `#if os(macOS)`; the
  `ArborSyncClient` package is deleted, its tests moved to `CanopyAppTests`
  (and the platform-neutral provider contract to `CanopyWorkingTreeTests`),
  and `tests/protocol/conformance.ts` runs them through `xcodebuild`.
- `POST /v1/bootstrap/pairings` (create a pairing offer) and
  `POST /v1/local/forget` are removed. The Mac creates a pairing offer on the
  host with the account credential, as iOS does.
- Accepted-choice review already runs through `CanopyWorkingTree` on both
  platforms (`CanopyConflictReviewModel(coordinator:)`); a placed folder's
  held changes stay a daemon concern (`POST /v1/held/discard`,
  [Native 012](../swift/012-show-held-folders.md)).
- The daemon's filesystem-sync conflict routes (`GET /v1/conflicts`,
  `POST /v1/conflicts/resolve`) and their client methods were already removed
  with the daemon editor's mutation path; the TypeScript client also drops
  `discardHeld`, which only the Mac calls.

## Source audit, 2026-09-24 (on `5145569`): why the rest did not execute

The original removal list predates the onboarding identity and recovery work.
Reconciled against the source:

| Route | Consumer | Outcome |
|---|---|---|
| `POST /v1/me`, `/v1/me/restore`, `/v1/me/backup` | Mac onboarding create, recover, back up, and legacy-key adoption; `tools/test-sync-helper.ts` | Kept. There is no Swift writer for the data-home `ProfileIdentityStore`; the iOS `KeychainProfileIdentityStore` is a different store (the "legacy" identity the Mac reconciles). |
| `POST /v1/bootstrap/accounts`, `/accounts/cancel` | Mac onboarding claim, resume, cancel; `swift/scripts/hosted-smoke.ts`; integration fixtures (`cli-sync`, `cli-mv`, `cli-rehome`, `community-hosting`) through `LocalAccountService.claimHostAccount` | Kept. The CLI has no claim command, so this is the only way to claim into a data home. |
| `POST /v1/bootstrap/pairings/claim` | Mac onboarding pair and resume pairing | Kept, for the same reason. |
| `GET /v1/accounts` (with `identity`, `pendingClaim`, `pendingPairing`) | Mac overview and onboarding; `arbor status`, which may target a cloud-session daemon, so it cannot read the local disk instead | Kept. |
| `GET /v1/credential` | Mac `ArborSyncCredentialProvider`; CLI cloud sessions | Kept (the plan kept it too). |
| `POST /v1/placements/move` | `arbor mv` | Kept. The daemon pauses synchronization, relocates the watched root with its workspace state, and rolls back on failure; a client-side `placements.yaml` edit plus `POST /v1/sync` under a running watcher would first see the source vanish. The Mac app never moved placements, so step 3's Mac half had nothing to change. |

Step 1's check fails: the daemon and the iOS path do **not** share a
credential entry. The daemon's `HostAccountStore` keeps a connection record
under the data home's private root and the token in the platform store under
service `org.arbor.community-account`, name `account-<sha256(dataRoot, cfg)>`
(`Bun.secrets`), plus pending claim and pairing journals; iOS keeps
`KeychainDeviceCredentialStore` (`org.nxhx.Arbor.device`, `account:<cfg>`,
metadata under `.accounts`) and `KeychainProfileIdentityStore`
(`org.nxhx.Arbor.profile`). Routing the Mac through `NativeAccountService`
would put its accounts where the daemon and CLI cannot see them.

## Decision needed

Pick one owner for a Mac's identity and account credentials:

1. **The data home stays the owner (the Mac keeps the daemon's onboarding
   routes).** Nothing more to remove; close this plan and record the
   remaining routes as the Mac's data-home onboarding. Lowest risk.
2. **The app becomes the owner.** Port `claimHostAccountBootstrap`,
   `claimLocalPairing`, cancellation, and identity create/restore/backup to
   Swift writing the data-home format (connection record, platform-store
   entry, pending journals, checkout, `placements.yaml`, current device), then
   delete the routes, `account-http.ts`, the claim/pair half of
   `account-service.ts`, and the TypeScript bootstrap code. Requires a Mac
   check that a Keychain item written by the signed app is readable by the
   Bun daemon without a prompt (and the reverse), one migration of existing
   entries, and a replacement fixture for the four integration tests
   (`tests/helpers/account-home.ts` already installs a home directly).
3. **iOS stores on both platforms, the daemon reads them.** Teach
   `HostAccountStore` to read `org.nxhx.Arbor.device` entries and migrate
   once; the Mac then uses `NativeAccountService` unchanged. Same Keychain
   access question as option 2, plus the CLI's own identity commands.

## Remaining steps (options 2 or 3)

1. Resolve the Keychain access question on a Mac and migrate existing
   entries once.
2. Route claim, pair, identity and account listing through the chosen
   store, sharing the iOS code; delete the Mac onboarding's daemon calls in
   `CanopyOnboarding.swift` and the corresponding `ArborSyncRESTClient`
   methods (`onboardingState`, `createIdentity`, `restoreIdentity`,
   `backupIdentity`, `claimPairing`, `cancelPendingClaim`, `claimAccount`,
   and `credential` once the app holds the credential). Gate: claim a fresh
   account and pair a second device from the Mac against a disposable host
   with the daemon running but never asked.
3. Remove the routes above, `account-http.ts`, and the claim/pair/identity
   half of `account-service.ts`; update [the Arbor Sync REST API](../../docs/implementing-sync-services/arborsync-api.md)
   and [Canopy local state](../../docs/architecture/canopy-browser/local-state.md).

## Out of scope

- Making the Mac keep a durable on-disk working tree with the folder as a
  projection (Web 025 decides it).
- Changing the daemon's folder materialization, watcher, or journal.
- Linux and Windows supervision.
