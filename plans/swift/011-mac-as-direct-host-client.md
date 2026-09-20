# Native 011: Make the Mac a direct host client like iOS

Status: NEEDS DESIGN REVIEW; approved in principle 2026-09-20. Sole user; no
compatibility shims. Depends on nothing; Web 025 should build on the result.

## Why

The Mac app and the iOS app run the same working tree, update machine, and
admission queue, but they reach accounts, placements, and conflicts by
different roads. iOS is a direct client of the host through `OverstoryClient`
and `CanopyWorkingTree`. The Mac asks the daemon over its loopback API for
the same things, so the daemon carries a second copy of host-facing
behavior, `ArborSyncClient` mirrors half of the host API, and the two apps
diverge in exactly the places that are hardest to test (claiming, pairing,
conflict handling).

The daemon is still essential on the Mac for one thing: the placed folder is
the source of truth there, and only the daemon turns a folder into a
working tree (hashes it, serves objects by hash, materializes accepted host
changes into it, watches external edits). That dependency, and the app's
ability to install and supervise the daemon, stay.

## The four surfaces

| Surface | Mac today | iOS today | After |
|---|---|---|---|
| Bootstrap and objects | `GET /v1/bootstrap` seeds the in-memory working tree; `GET /v1/objects` is the platform object store | Durable working tree on disk, objects from the host through `CanopyObjectStore` | Unchanged on the Mac: the daemon is the folder's object store |
| Accounts and credentials | `GET /v1/accounts`, `GET /v1/credential`, claim and pair through `/v1/bootstrap/*` | `Credentials` in the platform store, claim and pair through `OverstoryClient` against the host, YAML edited in the checkout | The Mac uses the iOS path. The app edits `~/.arbor/accounts/<cfg>/*.yaml` on disk (it already does for `trees.yaml`) and holds the credential in the same platform store the daemon reads. The daemon only observes the checkout and pushes it |
| Placements | `GET /v1/trees` and `POST /v1/placements/move` | `WorkingTreePlacementService` over `placements.yaml` and the checkout | The Mac uses `WorkingTreePlacementService`; moves become a checkout edit plus a request to the daemon to re-place, not a daemon-owned operation |
| Conflicts | `GET /v1/conflicts` and `POST /v1/conflicts/resolve` for filesystem-sync conflicts; accepted-choice review in the app | Accepted-choice review through `CanopyWorkingTree` (`ConflictReview`) against the host | Accepted-choice review is the iOS path on both platforms. Filesystem-sync conflicts on a placed folder stay a daemon concern and keep their route, shown by the Mac only because it has a folder |

Publication and watch are already direct: the Mac's `UpdateCoordinator`
publishes durable heads to the host and follows the host's watch, not the
daemon's events.

## What the daemon keeps and what it loses

Routes the Mac app still needs, and that the CLI or tests also use:

| Route | Keeps because |
|---|---|
| `GET /v1/status`, `GET /v1/trees` | CLI status and placement inventory (`arbor status`, `arbor place`, `arbor mv`) |
| `GET /v1/bootstrap` | Seeds the Mac's in-memory working tree from the placed folder |
| `GET /v1/objects` | The folder as object store, for the Mac app and for visits (`?origin=`) |
| `GET /v1/credential` | The CLI's cloud sessions read the stored credential; the Mac app stops needing it once it holds the credential itself |
| `POST /v1/sync` | `arbor sync`, and the app's "re-place after a checkout edit" request |
| `GET /v1/events` | CLI and tests observe the daemon |
| `GET /v1/conflicts`, `POST /v1/conflicts/resolve` | Filesystem-sync conflicts on a placed folder |
| `POST /v1/resolve` | CLI locator resolution |

Routes that become Mac-unused and are candidates for removal once the CLI is
checked:

| Route | Today's consumers after this plan | Recommendation |
|---|---|---|
| `GET /v1/accounts` | `arbor` (one call) | Keep for the CLI, or have the CLI read the checkout directly the way the app will; then remove |
| `POST /v1/bootstrap/accounts` (claim), `POST /v1/bootstrap/pairings` (pair) | None: the Mac claims and pairs through `OverstoryClient`; iOS already does; the CLI does not claim | Remove, with `account-http.ts` and the claim/pair half of `account-service.ts` |
| `POST /v1/me` (create profile identity) | `arbor me create` runs in-process; the app can create identity through the shared `ProfileIdentityStore` | Remove |
| `POST /v1/local/forget` | `arbor` does not use it; the app forgets an account by editing the checkout | Remove |
| `POST /v1/placements/move` | `arbor mv` (one call) | Keep for the CLI unless `arbor mv` becomes a checkout edit plus `POST /v1/sync`, which is the app's new path anyway; then remove |

`ArborSyncClient` (Swift) shrinks to `status`, `trees`, `bootstrap`,
`object`, `conflict`, `resolveConflict`, `synchronize`, and the process
supervisor. `createCommunityPairing`, `claimAccount`, `credential`, and
`accounts` go, along with their models, which then live only in
`OverstoryClient`. The TypeScript `arborsync-client` keeps whatever the CLI
still calls (`status`, `trees`, `resolve`, `synchronizeNow`, `movePlacement`,
and `accounts` until the CLI reads the checkout) and drops the rest;
`canopy-web`'s imports are Web 025's problem and are not a reason to keep any
method.

The daemon's `account-service.ts` keeps only what observing and pushing the
checkout needs: watching `accounts/<cfg>/`, validating candidates, and the
credential store. Its claim, pair, forget, and identity-creation code paths
are deleted rather than kept as adapters.

## Steps

1. **Credential ownership.** Confirm the daemon and the app read the same
   platform credential entry (scoped by data home and configuration TreeID,
   [data home](../../docs/arborsync/data-home.md)). If the app already can,
   nothing changes; if the daemon holds it under a different key, pick one
   and migrate once.
2. **Accounts on the Mac.** Route claim, pair, forget, and account listing
   through `OverstoryClient` and the checkout, sharing the iOS code. Delete
   the Mac-only branches in `ArborAppModel.swift` that call the daemon for
   these. Gate: claim a fresh account and pair a second device from the Mac
   against a disposable host with the daemon running but never asked.
3. **Placements on the Mac.** Use `WorkingTreePlacementService` for the
   inventory and for moves; after a checkout edit, ask the daemon to
   synchronize (`POST /v1/sync`) so it re-places. Gate: `arbor mv` and an
   app-initiated move produce identical checkout and `placements.yaml`
   results.
4. **Accepted-choice review on the Mac.** Drive it through `CanopyWorkingTree`
   exactly as iOS does; keep the daemon's filesystem-sync conflict sheet as
   the only daemon-fed review. Gate: the same conflict fixture resolves
   identically on both platforms, and `swift/CanopyAppTests` covers both.
5. **Remove the unused routes and client methods** listed above, in one
   commit per side (daemon, Swift client, TypeScript client), each with the
   CLI suite, `bun run test:protocol`, and a Mac app build green.
6. **Docs.** Update [the Arbor Sync REST API](../../docs/arborsync/arborsync-api.md)
   to the reduced surface, [architecture](../../docs/architecture.md)'s client
   mechanics, and [Canopy local state](../../docs/canopy-browser/local-state.md)
   where it says the app "asks the daemon" for accounts. Note in
   [Web 025](../canopy-web/025-arbor-web.md) that the browser's `LocalHost`
   should target the reduced surface.

## Out of scope

- Making the Mac keep a durable on-disk working tree with the folder as a
  projection. That is the larger unification and overlaps with what Web 025
  needs for the browser; decide it there.
- Changing the daemon's folder materialization, watcher, or journal.
- Linux and Windows supervision.
