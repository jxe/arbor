# The next migration batch

Schema changes wait here and cut over together, so the live host is
migrated, backed up and verified once per batch rather than once per change.
Nothing under `packages/` imports this directory, so `main` stays deployable
while steps accumulate: the product keeps serving the live schema until the
cutover commit. The previous batch is
[027-placement-accounts](../027-placement-accounts/README.md); copy its `run.ts`,
`migrate.test.ts` and README shape when adding the first step.

## Steps

The live schema is 27; the batch ends at 29.

| Step | Change | Product change at cutover |
|---|---|---|
| [028](steps/028-profile-locator-pins.ts) | `profile_locator_pins` (empty): per tree, the Profile TreeID each profile locator its configuration names first resolved to. | Qualified profile locators ([Security 011](../../../../plans/soon/011-placement-by-reservation.md)): members and rules may name a profile on another host by its locator there, pinned to its first TreeID; a member naming another host's locator is a placement account with its root declared on accept; the placement claim and `homeHost` go. |
| [029](steps/029-drop-tree-status.ts) | `trees.status` dropped. Code before canopyd 005 retired trees, and live holds one, `tr_unkaimbksfitula6i5n4acid6y` (ordinary, one accepted update, unmounted, unconfigured). At Joe's decision (2026-09-28) the step deletes a retired tree nothing points at, with its rows, and names it in the report's `notes`; it refuses (and the batch rolls back) a retired tree that a mount, boundary, configuration or app rule still names. | Every `status = 'active'` test goes, and `HostTree.status` with them: `access.ts`, `directory.ts`, `schema.ts` (the column list and the integrity queries), `recomputeBoundaries`, `groupProfiles`, `insertTree`, `prepareMountRewrite`, `validateReservedBoundaries` and the `/.arbor/trees` listing in `host.ts`. |

## Wire changes at cutover

The cutover already replaces the clients with the host (028 retires the
placement claim and `homeHost`), so these wire changes ride it rather than
costing a release of their own. The spec states them now, ahead of the code,
as it does 028's; the cutover commit implements them in canopyd, the
TypeScript clients and the Swift clients together, with the conformance
vectors. Nothing lands on `main` before then: both clients' decoders still
require what the host would stop sending.

| Change | Spec | Host | Clients |
|---|---|---|---|
| **Update response.** `head` is required; the top-level `observedThrough`, which no client reads, goes. | [tree operations §2.4](../../../../docs/overstory-spec/01-tree-operations.md#24-results-conflicts-and-retry) | `host.ts` update route; `StoredUpdateResponse` results in `canopy.ts` (`submitUpdatesLocked`, `declareTree`) | `decodeUpdateResponseJSON` (`protocol/src/updates/json.ts`); the fallback descriptor read in `working-tree/src/coordinator.ts` and `UpdateCoordinator.swift`; `ProtocolModels.swift` |
| **Watch frame.** The cursor only in the SSE `id`, the kind only in `event`; `data` is `{ transition, access, canonical }`, one transition, no descriptor, no repeated tree or `requestDigest`; `resync-required` is `data: { reason }` with no `id`. | [tree operations §1.1.3, §4.2](../../../../docs/overstory-spec/01-tree-operations.md#113-watching) | `watchDescriptor` and the resync frame in `host.ts` | `decodeAcceptedWatchChange` (`protocol/src/updates/accepted-contract.ts`) and `ProtocolClient.watch` (`transport.ts`); `ProtocolClient.watch` and its observation models in Swift; vectors `observation-events-invalid.json`, `protocol-accepted-transport.json` |
| **One watch cursor.** `after` only; `Last-Event-ID` is ignored and its disagreement 400 goes. | [tree operations §1.1.3](../../../../docs/overstory-spec/01-tree-operations.md#113-watching) | the watch route in `host.ts`; Arbor Sync's local watch (`arborsync/src/sync-http.ts`) mirrors it | Swift `ProtocolClient.watch` sends `after` (TypeScript already does); `ArborSyncRESTClient.swift` for the local watch |
| **Unused cursors and `/access`.** `/account`, `/trees` and `/directory` carry no `observedThrough`; `/access` answers `{ policy, locators }`, the rules with each named profile's `arbor://` locator, instead of the whole-tree entry list, `policy` and a cursor. | [locators §5](../../../../docs/overstory-spec/03-locators.md#5-finding-trees), [access control §4](../../../../docs/overstory-spec/05-access-control.md#4-reading-access) | `host.ts` routes; `accessEntries` and `AccessControl.entries` go (the directory already reads `ruleProfiles`) | `ProtocolClient.account`/`list`/`access` (TS); `ProtocolTreeAccessSnapshot` (`ResourcePolicy.swift`) and its one reader, the locator map in `TreeConfigurationClient.access`; the account check in `ProtocolClient.swift` |

## Adding a step

1. Write `steps/NNN-<name>.ts` exporting a `MigrationStep` whose `from` is
   the previous step's plus one (the first is 028 from 27), with a `verify`
   for what it promises.
2. Add it to `steps` in `run.ts` and a case to `migrate.test.ts`.
3. Add its row above, with the product change it brings at cutover.
4. Keep the product unchanged until cutover; anything it must stop using
   first lands on `main` on its own.

## Cutover

The [common procedure](../README.md#the-procedure) applies to the whole batch.
The cutover commit bumps `CANOPY_SCHEMA_VERSION`, makes each step's product
change, passes `assertCurrentHostSchema` and `assertHostData` as `run.ts`'s
`finish`, renames this directory to `NNN-<batch-name>/` (NNN the new schema)
and starts a fresh `next/`. Record the rehearsal and the cutover in its README
before the rename.
