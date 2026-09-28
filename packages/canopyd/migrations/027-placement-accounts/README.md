# Migration 027: placement accounts (batch 027)

Schema 26 to 27 in one step, cut over with the placement role (Security 007)
and the placement grace and remote groups (Security 009). The live run in
place is `bun run packages/canopyd/migrations/027-placement-accounts/run.ts
/data`.

## Steps

The step is one file in `steps/`, listed in `run.ts`.
[`tools/batch.ts`](../tools/batch.ts) runs it and the final stamp in one
transaction, refusing (and changing nothing) on a schema outside the batch, a
failed `quick_check` or a dangling foreign key; a rerun reports
`migrated: false`.

| Step | Change | Product change at cutover |
|---|---|---|
| [027-placement-accounts](steps/027-placement-accounts.ts) | `accounts.home_host` (NULL for every existing account: this host is its home). | Placement accounts (Security 007): a profile claims an account on a host that is not its home, which reads the home host's published device keys, opens sessions from them and declares the profile's placement root at `/~handle`. Security 009 rides along with no schema change: the one-hour grace while a home host is unreachable, and rules naming a group another host holds. |

The placement role landed on a branch together with its product change, so
that branch served schema 27 ahead of the cutover, and a host built from it
entered maintenance mode on the live schema-26 root until this batch ran.
`run.ts` passes `assertCurrentHostSchema` and `assertHostData` as `finish`.

## Cutover

The [common procedure](../README.md#the-procedure) applies. No data-home
rename: existing `placements.yaml` files stay valid, since a bare TreeID still
names the home host.

```sh
bun run test:migration packages/canopyd/migrations/027-placement-accounts
bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
bun run packages/canopyd/migrations/027-placement-accounts/run.ts migrated | tee report.json
bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
```

The cutover commit renamed `next/` to this directory and started a fresh
`next/` for the steps after 027.

## Rehearsal log

- 2026-09-27: synthetic schema-26 host only (`migrate.test.ts`).
- 2026-09-28: live backup `.backups/railway/20260928T091800Z/volume.tar`
  (sha256 `8da03ac3…`, 169 MB; live and vacuumed row counts equal apart from
  one expired `device_sessions` row pruned after the copy). The archive's
  imports resolve under the image's `bun install --frozen-lockfile
  --production`. `test:migration` 4/4. `run.ts migrated`: 26 → 27 through
  027; a rerun reports `migrated: false`; the one account's `home_host` is
  NULL. `compare-canopy-roots`: all 7 roots unchanged. Served with this build:
  `verify.ts --sync` ok (7 trees), `/.arbor/integrity` ok (called once).

## Cutover log

- 2026-09-28, `02689859`: Canopy quit on the Mac and iPhone; authored
  manifest (112 files over 3 placements) and `cp -a ~/.arbor` taken; Arbor
  Sync stopped; pushed `main`, which deployed into maintenance mode;
  `railway ssh -- bun run
  packages/canopyd/migrations/027-placement-accounts/run.ts /data` reported
  `migrated: true`, 26 → 27 through 027, as rehearsed; `railway redeploy
  --from-source -y`. Then `verify.ts --sync` ok on all 7 roots,
  `/.arbor/integrity` ok (once), Arbor Sync started from the new checkout with
  every placement idle at its old update, the authored manifest unchanged, and
  round trips from the file system (5257/5258), the rebuilt Mac app and the
  iPhone (Joe, by hand).
