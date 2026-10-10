# Migration 026: key devices only (batch 024–026)

The first batched migration: schema 23 to 26 in one transaction, cut over
with the key-only device model, the CBOR object transport and the removal of
legacy readers. The live run in place is `bun run
packages/overstoryd/migrations/026-key-devices-only/run.ts /data`.

The batch cut over live on 2026-09-27 (overstoryd 019, closed; see the
[status](../../../../status.md#schema-26-cutover--2026-09-27)).

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

The batch's last schema is `OVERSTORYD_SCHEMA_VERSION`, and `run.ts` passes `assertCurrentHostSchema` and `assertHostData` as `finish`.

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
   bun run packages/overstoryd/migrations/tools/restore-overstoryd.ts volume.tar before
   bun run packages/overstoryd/migrations/026-key-devices-only/survey-host.ts before > survey-host.json
   ```

2. **The iPhone.** Copy the app's data container (bundle id `org.nxhx.Arbor`,
   from `swift/project.yml`) to the Mac; `xcrun devicectl list devices` gives
   the device id:

   ```sh
   xcrun devicectl device copy from --device <id> --domain-type appDataContainer \
     --domain-identifier org.nxhx.Arbor --source / --destination ~/iphone-story
   ```

3. **The Mac.** [`survey.ts`](survey.ts) reads `~/.story`, the Mac app's
   `~/Library/Application Support/Story`, the macOS Keychain (attributes only,
   through `security`; this includes no account claim pending in the Mac
   app), and the two optional inputs:

   ```sh
   bun run packages/overstoryd/migrations/026-key-devices-only/survey.ts \
     --iphone ~/iphone-story --live survey-host.json
   ```

   `--home <dir>` (or `SURVEY_HOME`) surveys another home directory, skipping
   the Keychain checks, since the login Keychain is the running user's. Each line
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
bun run test:migration packages/overstoryd/migrations/026-key-devices-only
bun run packages/overstoryd/migrations/tools/restore-overstoryd.ts volume.tar before
bun run packages/overstoryd/migrations/tools/restore-overstoryd.ts volume.tar migrated
bun run packages/overstoryd/migrations/026-key-devices-only/run.ts migrated | tee report.json
bun run packages/overstoryd/migrations/tools/compare-overstoryd-roots.ts before migrated
```

The cutover commit renamed `next/` to this directory and started a fresh
`next/` for the steps after 026.

## Rehearsal log

- 2026-09-27: synthetic schema-23 host only (`migrate.test.ts`).
- 2026-09-27: live backup `.backups/railway/20260927T175419Z/volume.tar`
  (sha256 `8008cdba…`, 165 MB; live and vacuumed row counts equal), taken
  after `dv_ry4dqmh32o5ovzccizd2xfhhje` left `devices.yaml`. `survey-host.ts`
  on `before`: schema 23, 0 unrevoked devices without a key, 0 bare-string
  members, 0 `profile_resets`. `survey.ts --iphone … --live`: every gate
  passes; the three failures are expected (update control before schema 4,
  whose removal was reverted, in the Mac app and on the iPhone; and 1,655
  test-made `self-`/`home-` Keychain records beside the indexed
  `primary-v2`, which the removed guard never read for this data home).
  `test:migration` 12/12. `run.ts migrated`: 23 → 26 through 024–026; a
  rerun reports `migrated: false`. `compare-overstoryd-roots`: all 7 roots
  unchanged. Served with this build: `verify.ts` ok (7 trees, `--sync`),
  `/.overstory/integrity` ok (called once). Migrated `devices`: 2 key devices,
  2 revoked without a key (`dv_ry4d…`, `dv_7y6b…`).

## Cutover log

- 2026-09-27, `377e87ac`: Canopy quit on the Mac and iPhone; authored
  manifest (112 files) and `cp -a ~/.story` taken; Story Sync stopped;
  `mv ~/.story/accounts ~/.story/configurations`; pushed `main`, which
  deployed into maintenance mode; `railway ssh -- bun run
  packages/overstoryd/migrations/026-key-devices-only/run.ts /data` reported
  `migrated: true`, 23 → 26 through 024–026, as rehearsed; `railway redeploy
  --from-source -y`. Then `verify.ts --sync` ok on all 7 roots,
  `/.overstory/integrity` ok (once), every placement idle at its old update, the
  authored manifest unchanged apart from the renamed directory, and round
  trips from the file system (5187/5188), the rebuilt Mac app and the iPhone.
