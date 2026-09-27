# The next migration batch

Schema changes wait here and cut over together, so the live host is
migrated, backed up and verified once per batch rather than once per change.
Nothing under `packages/` imports this directory, so `main` stays deployable
while steps accumulate: the product keeps serving the live schema until the
cutover commit. The previous batch is
[026-key-devices-only](../026-key-devices-only/README.md); copy its `run.ts`,
`migrate.test.ts` and README shape when adding the first step.

## Steps

The live schema is 26; the batch ends at 27.

| Step | Change | Product change at cutover |
|---|---|---|
| [027](steps/027-placement-accounts.ts) | `accounts.home_host` (NULL for every existing account: this host is its home). | Placement accounts (Security 007): a profile claims an account on a host that is not its home, which reads the home host's published device keys, opens sessions from them and declares the profile's placement root at `/~handle`. `CANOPY_SCHEMA_VERSION` is already 27 on this branch, ahead of the cutover; see below. |

The placement role landed on a branch together with its product change, so
that branch serves schema 27 and a host built from it enters maintenance mode
on the live schema-26 root until this batch runs. Cut the batch over before
deploying that branch.

## Adding a step

1. Write `steps/NNN-<name>.ts` exporting a `MigrationStep` whose `from` is
   the previous step's plus one (the first is 027 from 26), with a `verify`
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
