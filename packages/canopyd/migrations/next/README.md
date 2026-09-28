# The next migration batch

Schema changes wait here and cut over together, so the live host is
migrated, backed up and verified once per batch rather than once per change.
Nothing under `packages/` imports this directory, so `main` stays deployable
while steps accumulate: the product keeps serving the live schema until the
cutover commit. The previous batch is
[027-placement-accounts](../027-placement-accounts/README.md); copy its `run.ts`,
`migrate.test.ts` and README shape when adding the first step.

## Steps

The live schema is 27; the batch ends at 28.

| Step | Change | Product change at cutover |
|---|---|---|
| [028](steps/028-profile-locator-pins.ts) | `profile_locator_pins` (empty): per tree, the Profile TreeID each profile locator its configuration names first resolved to. | Qualified profile locators ([Security 011](../../../../plans/soon/011-placement-by-reservation.md)): members and rules may name a profile on another host by its locator there, pinned to its first TreeID; a member naming another host's locator is a placement account with its root declared on accept; the placement claim and `homeHost` go. |

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
