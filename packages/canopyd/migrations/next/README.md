# The next migration batch

Schema changes now wait here and cut over together, so the live host is
migrated, backed up and verified once per batch rather than once per change.
Nothing under `packages/` imports this directory, so `main` stays deployable
while steps accumulate: the product keeps serving the live schema until the
cutover commit.

The batch cuts over by [canopyd 019](../../../../plans/soon/019-cutover-026.md).

## Steps

Each step is one file in `steps/`, carrying the schema from `from` to
`from + 1`, and is listed in `run.ts` in schema order.
[`tools/batch.ts`](../tools/batch.ts) runs the pending steps and the final
stamp in one transaction, refusing (and changing nothing) on a schema outside
the batch, a failed `quick_check` or a dangling foreign key; a rerun reports
`migrated: false`.

| Step | Change | Product change at cutover |
|---|---|---|
| [024-drop-profile-resets](steps/024-drop-profile-resets.ts) | Drop `profile_resets`, unused since the profile-key reset was withdrawn (Security 006, 2026-09-27). Refuses if it holds a row. | `schema.ts`: the table is gone. |
| [025-one-challenge-table](steps/025-one-challenge-table.ts) | `account_challenges` and `device_challenges` become one `challenges` table with `purpose` (`account-claim` or `device-session`); only unexpired, unconsumed rows are copied. | `AccountDirectory`'s challenge helpers take a purpose and filter every read and consume on it. |
| [026-key-devices-only](steps/026-key-devices-only.ts) | `devices` loses `token_digest`; `public_key` is required unless the device is revoked. Every row is kept, so a revoked digest device's DeviceID is never reused. Refuses, naming the count, while any unrevoked device has no key. | Digest devices are gone: sessions are the only device authentication, pairing and claiming enroll a key, and a new `devices.yaml` entry without `key` is refused. |

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

## Before cutover: the survey

Two read-only scripts check that the state each removed legacy reader existed
for is gone, on the host, the Mac and the iPhone. Neither writes anything.

1. **The host.** [`survey-host.ts`](survey-host.ts) opens a data root
   read-only and prints counts only, never content or digests: unrevoked
   devices with no public key, group members stored as bare strings in
   `profile_facts`, and `profile_resets` rows. The deployed image predates it,
   so run it on the restored copy of the cutover's backup (step 3 of the
   procedure), which is taken after the last digest device is deauthorized:

   ```sh
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
   bun run packages/canopyd/migrations/next/survey-host.ts before > survey-host.json
   ```

2. **The iPhone.** Copy the app's data container (bundle id `org.nxhx.Arbor`,
   from `swift/project.yml`) to the Mac; `xcrun devicectl list devices` gives
   the device id:

   ```sh
   xcrun devicectl device copy from --device <id> --domain-type appDataContainer \
     --domain-identifier org.nxhx.Arbor --source / --destination ~/iphone-arbor
   ```

3. **The Mac.** [`survey.ts`](survey.ts) reads `~/.arbor`, the Mac app's
   `~/Library/Application Support/Arbor`, the macOS Keychain (attributes only,
   through `security`; this includes no account claim pending in the Mac
   app), and the two optional inputs:

   ```sh
   bun run packages/canopyd/migrations/next/survey.ts \
     --iphone ~/iphone-arbor --live survey-host.json
   ```

   `--home <dir>` (or `SURVEY_HOME`) surveys another home directory. Each line
   is `PASS`, `FAIL` or `SKIP`, the check, the commit to `git revert` if it
   fails (or the work it gates), and details; the script exits 1 when any
   check fails. `SKIP` marks an input not given. Run it once without `--live`
   before touching the host, and again with it after the backup. The iPhone's
   Keychain cannot be read from the Mac: check Settings → Accounts on the
   phone by hand, and that it is not mid-claim.

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

- 2026-09-27: synthetic schema-23 host only (`migrate.test.ts`).
