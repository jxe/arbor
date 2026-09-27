# The next migration batch

Schema changes now wait here and cut over together, so the live host is
migrated, backed up and verified once per batch rather than once per change.
Nothing under `packages/` imports this directory, so `main` stays deployable
while steps accumulate: the product keeps serving the live schema until the
cutover commit.

The batch is planned in [canopyd 019](../../../../plans/soon/019-migration-batch-024.md).

## Steps

Each step is one file in `steps/`, carrying the schema from `from` to
`from + 1`, and is listed in `run.ts` in schema order.
[`tools/batch.ts`](../tools/batch.ts) runs the pending steps and the final
stamp in one transaction, refusing (and changing nothing) on a schema outside
the batch, a failed `quick_check` or a dangling foreign key; a rerun reports
`migrated: false`.

| Step | Change | Product change at cutover |
|---|---|---|
| [024-drop-profile-resets](steps/024-drop-profile-resets.ts) | Drop `profile_resets`, unused since the profile-key reset was withdrawn (Security 006, 2026-09-27). Refuses if it holds a row. | `schema.ts`: remove the table from `createDeviceKeyTables` and `TABLE_COLUMNS`. |

At cutover the batch's last schema becomes `CANOPY_SCHEMA_VERSION`, and
`run.ts` passes `assertCurrentHostSchema` and `assertHostData` as `finish`.

## Adding a step

1. Write `steps/NNN-<name>.ts` exporting a `MigrationStep` whose `from` is
   the previous step's plus one, with a `verify` for what it promises.
2. Add it to `steps` in `run.ts` and a case to `migrate.test.ts`.
3. Add its row above, with the product change it brings at cutover.
4. Keep the product unchanged until cutover; anything it must stop using
   first (as the reset code was removed before its table) lands on `main` on
   its own.

## Cutover

The [common procedure](../README.md#the-procedure) applies to the whole batch:
one backup, one rehearsal on restored copies, one deploy of the cutover commit,
one in-place run, one verification.

```sh
bun run test:migration packages/canopyd/migrations/next
bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
bun run packages/canopyd/migrations/next/run.ts migrated | tee report.json
bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
```

The cutover commit bumps `CANOPY_SCHEMA_VERSION`, makes each step's product
change, adds `finish` to `run.ts`, and renames this directory to
`NNN-<batch-name>/` (NNN the new schema). A fresh `next/` starts with the
first step after it. Record the rehearsal and the cutover below before the
rename.

## Rehearsal log

- 2026-09-27: synthetic schema-23 host only (`migrate.test.ts`, 3 tests).
