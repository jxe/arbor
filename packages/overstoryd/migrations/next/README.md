# The next migration batch

Schema changes wait here and cut over together, so the live host is
migrated, backed up and verified once per batch rather than once per change.
Nothing under `packages/` imports this directory, so `main` stays deployable
while steps accumulate: the product keeps serving the live schema until the
cutover commit. The previous batch is
[032-drop-unused-fields](../032-drop-unused-fields/README.md); copy its `run.ts`,
`migrate.test.ts` and README shape when adding the first step.

## Steps

The live schema is 32. No step is pending.

| Step | Change | Product change at cutover |
|---|---|---|

## Adding a step

1. Write `steps/NNN-<name>.ts` exporting a `MigrationStep` whose `from` is
   the previous step's plus one (the first is 033 from 32), with a `verify`
   for what it promises.
2. Add it to `steps` in `run.ts` and a case to `migrate.test.ts`.
3. Add its row above, with the product change it brings at cutover.
4. Keep the product unchanged until cutover; anything it must stop using
   first lands on `main` on its own.

## Cutover

The [common procedure](../README.md#the-procedure) applies to the whole batch.
The cutover commit bumps `OVERSTORYD_SCHEMA_VERSION`, makes each step's product
change, passes `assertCurrentHostSchema` and `assertHostData` as `run.ts`'s
`finish`, renames this directory to `NNN-<batch-name>/` (NNN the new schema)
and starts a fresh `next/`. Record the rehearsal and the cutover in its README
before the rename.
