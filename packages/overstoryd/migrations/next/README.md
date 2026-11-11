# The next migration batch

Schema changes wait here and cut over together, so the live host is
migrated, backed up and verified once per batch rather than once per change.
Nothing under `packages/` imports this directory, so `main` stays deployable
while steps accumulate: the product keeps serving the live schema until the
cutover commit. The previous batch is
[032-drop-unused-fields](../032-drop-unused-fields/README.md); copy its `run.ts`,
`migrate.test.ts` and README shape when adding the first step.

## Steps

The live schema is 32. Two steps are pending; this batch is Protocol 003's flag day, and the product on its branch already serves schema 34.

| Step | Change | Product change at cutover |
|---|---|---|
| [033-device-clients](steps/033-device-clients.ts) | `devices.clients`: a JSON object of the clients a device last named itself as, by product (Joe, 2026-11-08) | `AccountDirectory.noteClient` also writes `devices.clients` when a product's name changes (it already logs it); `AUTHORITY_SCHEMA.devices` and `createHostSchema` gain `clients`; `overstoryd report` lists each device with its label, last use and clients |
| [034-protocol-003](steps/034-protocol-003.ts) | Each tree's history becomes one first update holding its head in the new format, written beforehand by [`protocol-003.ts`](protocol-003.ts): entry times from history, Markdown files that read as pages become pages, `.mdx` pages become files, rows get Unix-ms times and tagged dates, and each collection's `schema.usl` becomes the `schema.beetle` it converts to (`tools/convert-usl-to-beetle.ts`, which keeps the model fingerprint). `document_versions` is emptied, `entry_metadata` dropped, profile facts reread. `run.ts` then deletes `provenance/`, `materialized/`, `entry-times.sqlite3` and the exec mutation receipts | Protocol 003 and every Protocol 001 move (plans/soon): new object format and wire forms; Protocol 002's index, `?times` and `entry-metadata` are gone. Mac, iPhone, CLI and Story Sync are replaced together, and every placement is placed again |

## Running it

`run.ts <data-root>` lists TreeIDs and DeviceIDs shorter than the spec allows
(`shortIds`), writes every tree's new head to the object store, then runs both
steps in one transaction and the product's schema and data checks. Its report
names each tree's new root (`trees`, as `tools/verify.ts` reads it), how many updates were dropped, what was
converted, and any tree whose head had decisions open (`conflicted`: the fresh
entry has none). Rehearse it on a copy of `/data` with a cold start of the new
build afterwards, timing the provenance backfill of every first entry.

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
