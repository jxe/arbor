# Migration 029: profile locators (batch 028–029)

Schema 27 to 29 in two steps, cut over with Security 011 (profiles on other
hosts named by locator, placement by reservation) and four wire changes that
ride the same client replacement. The live run in place is `bun run
packages/canopyd/migrations/029-profile-locators/run.ts /data`.

## Steps

The steps are files in `steps/`, listed in `run.ts`.
[`tools/batch.ts`](../tools/batch.ts) runs them and the final stamp in one
transaction, refusing (and changing nothing) on a schema outside the batch, a
failed `quick_check` or a dangling foreign key; a rerun reports
`migrated: false`. A step may return notes, which the report carries.
`run.ts` passes `assertCurrentHostSchema` and `assertHostData` as `finish`.

| Step | Change | Product change at cutover |
|---|---|---|
| [028](steps/028-profile-locator-pins.ts) | `profile_locator_pins` (empty): per tree, the Profile TreeID each profile locator its configuration names first resolved to. | Qualified profile locators ([Security 011](../../../../plans/soon/011-placement-by-reservation.md)): members and rules may name a profile on another host by its locator there, pinned to its first TreeID; a member naming another host's locator is a placement account with its root declared on accept; the placement claim and `homeHost` go. |
| [029](steps/029-drop-tree-status.ts) | `trees.status` dropped. Code before canopyd 005 retired trees, and live holds one, `tr_unkaimbksfitula6i5n4acid6y` (ordinary, one accepted update, unmounted, unconfigured). At Joe's decision (2026-09-28) the step deletes a retired tree nothing points at, with its rows, and names it in the report's `notes`; it refuses (and the batch rolls back) a retired tree that a mount, boundary, configuration or app rule still names. | Every `status = 'active'` test goes, and `HostTree.status` with them: `access.ts`, `directory.ts`, `schema.ts` (the column list and the integrity queries), `recomputeBoundaries`, `groupProfiles`, `insertTree`, `prepareMountRewrite`, `validateReservedBoundaries` and the `/.arbor/trees` listing in `host.ts`. |

## Wire changes at cutover

The cutover replaces every client with the host (028 retires the placement
claim and `homeHost`), so these rode it rather than costing a release of
their own. The spec stated them ahead of the code; the branch implemented them
in canopyd, the TypeScript clients and the Swift clients together, with the
conformance vectors. An older client cannot sync with a host at schema 29.

| Change | Spec | Host | Clients |
|---|---|---|---|
| **Update response.** `head` is required; the top-level `observedThrough`, which no client reads, goes. | [tree operations §2.4](../../../../docs/overstory-spec/01-tree-operations.md#24-results-conflicts-and-retry) | `host.ts` update route; `StoredUpdateResponse` results in `canopy.ts` (`submitUpdatesLocked`, `declareTree`) | `decodeUpdateResponseJSON` (`protocol/src/updates/json.ts`); the fallback descriptor read in `working-tree/src/coordinator.ts` and `UpdateCoordinator.swift`; `ProtocolModels.swift` |
| **Watch frame.** The cursor only in the SSE `id`, the kind only in `event`; `data` is `{ transition, access, canonical }`, one transition, no descriptor, no repeated tree or `requestDigest`; `resync-required` is `data: { reason }` with no `id`. | [tree operations §1.1.3, §4.2](../../../../docs/overstory-spec/01-tree-operations.md#113-watching) | `watchDescriptor` and the resync frame in `host.ts` | `decodeAcceptedWatchChange` (`protocol/src/updates/accepted-contract.ts`) and `ProtocolClient.watch` (`transport.ts`); `ProtocolClient.watch` and its observation models in Swift; vectors `observation-events-invalid.json`, `protocol-accepted-transport.json` |
| **One watch cursor.** `after` only; `Last-Event-ID` is ignored and its disagreement 400 goes. | [tree operations §1.1.3](../../../../docs/overstory-spec/01-tree-operations.md#113-watching) | the watch route in `host.ts`; Arbor Sync's local watch (`arborsync/src/sync-http.ts`) mirrors it | Swift `ProtocolClient.watch` sends `after` (TypeScript already does); `ArborSyncRESTClient.swift` for the local watch |
| **Unused cursors and `/access`.** `/account`, `/trees` and `/directory` carry no `observedThrough`; `/access` answers `{ policy, locators }`, the rules with each named profile's `arbor://` locator, instead of the whole-tree entry list, `policy` and a cursor. | [locators §5](../../../../docs/overstory-spec/03-locators.md#5-finding-trees), [access control §4](../../../../docs/overstory-spec/05-access-control.md#4-reading-access) | `host.ts` routes; `accessEntries` and `AccessControl.entries` go (the directory already reads `ruleProfiles`) | `ProtocolClient.account`/`list`/`access` (TS); `ProtocolTreeAccessSnapshot` (`ResourcePolicy.swift`) and its one reader, the locator map in `TreeConfigurationClient.access`; the account check in `ProtocolClient.swift` |

## Cutover

The [common procedure](../README.md#the-procedure) applies. No data-home
rename. The batch report has no per-tree roots, so `verify.ts` reads a
`roots.json` of `{ trees: [{ id, root }] }` taken from the backup's
active trees.

```sh
bun run test:migration packages/canopyd/migrations/029-profile-locators
bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
bun run packages/canopyd/migrations/029-profile-locators/run.ts migrated | tee report.json
bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
```

## Rehearsal log

- 2026-09-28: synthetic schema-27 host (`migrate.test.ts`, 6/6), rewritten
  from a root this build wrote.
- 2026-09-28: live read-only recheck: no `tree_policy` or `app_policy` rule
  names `homeHost`, no placement accounts, and one retired tree,
  `tr_unkaimbksfitula6i5n4acid6y` (the reason step 029 deletes rather than
  refuses).
- 2026-09-28: live backup `.backups/railway/20260928T161650Z/volume.tar`
  (sha256 `4b262226…`, 173 MB; live and vacuumed row counts equal). The
  archive's imports resolve under the image's `bun install --frozen-lockfile
  --production`. `run.ts migrated`: 27 → 29 through 028 and 029, notes
  `deleted retired tree tr_unkaimbksfitula6i5n4acid6y with 1 accepted
  update(s)`; a rerun reports `migrated: false`; `assertCurrentHostSchema`
  and `assertHostData` pass. `compare-canopy-roots`: the 6 other roots
  unchanged, the retired tree missing (the one expected difference). Served
  with this build: `verify.ts --sync` ok (6 trees), `/.arbor/integrity` ok
  (called once).

## Cutover log

(Filled in at cutover.)
