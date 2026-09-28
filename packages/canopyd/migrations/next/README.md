# The next migration batch

Schema changes wait here and cut over together, so the live host is
migrated, backed up and verified once per batch rather than once per change.
Nothing under `packages/` imports this directory, so `main` stays deployable
while steps accumulate: the product keeps serving the live schema until the
cutover commit. The previous batch is
[029-profile-locators](../029-profile-locators/README.md); copy its `run.ts`,
`migrate.test.ts` and README shape when adding the first step.

## Steps

The live schema is 29; the batch ends at 32. Each step removes something
the product stores and never needs; none changes the wire.

| Step | Change | Product change at cutover |
|---|---|---|
| [030](steps/030-drop-tree-policy.ts) | `trees.policy` dropped: it is `tree-config-v1` exactly when `governs` is set. The step refuses (and the batch rolls back) a row where the two disagree. | `HostTree.policy` and `isTreeConfigPolicy` go; readers test `governs !== null` or `kind`: `model.ts`, `access.ts` (`accessLevel`, `canWrite`, `canAdminister`), `canopy.ts` (the tree select, `writableProfiles`, the mount query and mount checks, `submitCandidateLocked` and `submitSemanticCandidate`'s policy choice, `subjectFor`, the remote-group prefetch, `insertTree` and `insertConfig`) and `schema.ts` (`AUTHORITY_SCHEMA`, `createHostSchema`, `assertHostData`'s ordinary-tree test). |
| [031](steps/031-drop-unread-times.ts) | `profile_locator_pins.pinned_at`, `pairings.created_at` and `device_sessions.created_at` dropped; each is written and never read. | Their inserts in `locator-pins.ts` (`write`) and `accounts.ts` (`insertSession`, `createPairing`) stop writing them; `AUTHORITY_SCHEMA`, `createHostSchema`, `createDeviceSessionsTable` and `tests/unit/canopyd/locator-pins.test.ts`'s table lose them. |
| [032](steps/032-profile-facts-unversioned.ts) | Each `profile_facts.facts` loses `version: 3`, which nothing reads; the step refuses any other version. | `RootProfileFacts.version` goes from `profile.ts` (the type, the empty read and `readRootProfile`) and `canopy.ts` (`profileCard`'s default). |

## Adding a step

1. Write `steps/NNN-<name>.ts` exporting a `MigrationStep` whose `from` is
   the previous step's plus one (030 was the first, from 29), with a `verify`
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
