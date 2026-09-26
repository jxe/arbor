# 023: Device keys

Schema 22 → 23, with no wire break: key devices sign in beside digest
devices ([Security 006](../../../../plans/security/006-device-keys.md); the
contract is [accounts §5](../../../../docs/overstory-spec/04-accounts-and-devices.md#5-device-pairing)).
Existing clients keep working unchanged: every device already paired keeps
its credential, and a claim or pairing that sends a credential digest is
accepted as before. Clients move to keys when their new builds are installed.

## What changes

- `devices.token_digest` becomes nullable and `devices.public_key` is added,
  with exactly one of them set. Every existing row keeps its digest and gets
  no key.
- Added, empty: `device_challenges`, `device_sessions` (with its
  `device_sessions_device` index) and `profile_resets`.
- No configuration changes. An existing `devices.yaml` has no `key` and
  already parses.

The run refuses, changing nothing, when the stamp is not 22 or `quick_check`
fails, and rolls back if the rebuilt table would differ from the old one in
any row or leave a dangling foreign key.

## Files

- `run.ts <data-root>`: the host migration. A rerun reports
  `migrated: false`. It ends with `assertCurrentHostSchema` and
  `assertHostData`.
- `migrate.test.ts`: `bun run test:migration packages/canopyd/migrations/023-device-keys`.
  It builds a schema-23 host with two digest devices, rewrites it to the
  schema-22 layout, migrates it, checks every device row is unchanged and the
  rerun is a no-op, and serves the result with both credentials.

## Runbook

The [common procedure](../README.md#the-procedure) applies, with these
specifics. Joe confirms each step; nothing touches the live host before
step 3.

1. **Back up** the live data root as one archive.
2. **Rehearse** on restored copies:

   ```sh
   bun run test:migration packages/canopyd/migrations/023-device-keys
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
   bun run packages/canopyd/migrations/023-device-keys/run.ts migrated | tee report.json
   bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
   ```

   `compare-canopy-roots` must find every tree unchanged. Serve `migrated`
   with the new build, call `/.arbor/integrity` once, and check that the Mac's
   and iPhone's current credentials read `/~joe`.
3. **Deploy and migrate in place.** The new image starts in maintenance mode
   on schema 22, so no writer needs quiescing beyond the usual:

   ```sh
   railway ssh -- bun run packages/canopyd/migrations/023-device-keys/run.ts /data | tee live-report.json
   ```

   Then redeploy so it serves. The report's device count must match the
   rehearsal's.
4. **Verify**: `tools/verify.ts`, then a read and a write from the Mac and
   the iPhone with their existing credentials.
5. **Close out**: record the result below and in `status.md`, and delete this
   directory when the backups age out. Moving Joe's devices to keys follows
   as their builds are installed; it needs no host step.

Rollback is `restore-canopy` from the archive and a redeploy of the previous
image. Once any device has moved to a key, rolling back also loses that
device's key binding, so it must pair again.

## Rehearsal log

- 2026-09-26: synthetic schema-22 host only (`migrate.test.ts`, 2 tests
  passing).
- 2026-09-26: live backup (`/data/backups/023-device-keys/volume.tar`,
  sha256 `914ee40a…`, schema 22, row counts equal to live). `run.ts`
  reported `migrated: true, devices: 4`, and a rerun `migrated: false`;
  every device row is unchanged apart from a null `public_key`, the three
  new tables are present, and `compare-canopy-roots` found all seven roots
  unchanged. Served with the new build, `/.arbor/integrity` was ok once and
  the Mac's existing credential read `/~joe` and its private Console tree.

## Cutover

2026-09-26, build `0621789b`: backup `/data/backups/023-device-keys`
(local copy `.backups/railway/20260926T172800Z/`, with `dot-arbor.before`
and the rehearsal copies; keep until about 2026-10-10). The live report
matched the rehearsal (`migrated: true, devices: 4`); after the redeploy
health and `/.arbor/integrity` (called once) were ok, all seven roots
matched the rehearsal, and a round-trip edit through Joe's profile was
accepted and removed (updates 5131/5132). The Mac's Console placement
was already in `error` before the cutover ("The folder does not hold the
accepted root it was given", an Arbor Sync problem unrelated to this
migration); on restart Arbor Sync merged the host's newer content into
it without losing Joe's queued edit, which is why `verify.ts` reports it
and its two changed files.
