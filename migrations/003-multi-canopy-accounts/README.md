# 003: plural Canopy accounts and local placements

**Status:** complete. Implementation, corrupt-fixture tests, independent
Canopy/local rehearsals, the authorized persistent Canopy/default-home cutover,
and the deliberately-last live iPhone pairing and re-placement check passed on
2026-09-03. The Canopy and Mac are on schema/layout 5/4.

## What changes

This migration is the one-time boundary from Interface 005's singleton v1
account graph to its plural v2 graph. It has two explicit modes and never
guesses a target kind.

`canopy-root` requires schema 4. It validates every account, active credential
binding, configuration tree, canonical boundary, ACL, and object graph. It
then converts each `account-config-v1` root to the exact three-file v2 graph:

```text
account.yaml
trees.yaml
devices.yaml
```

The conversion retains account/configuration/profile/tree/DeviceIDs, labels,
administrator authority, full tree declarations, ACLs, and Canopy path policy.
It removes synchronized placements, turns each `canonicalPath` into a complete
URL at that account's Canopy, and omits the legacy handle from `account.yaml`.
The Canopy continues to own that handle in its community-member allocation.
New immutable objects are stored before one transaction changes each
configuration root to `account-config-v2`, installs one `restored` accepted
update, and advances the schema stamp to 5. Ordinary tree roots do not change.

`local-home` requires the exact singleton layout and local state stamp 3. It
checks the synchronized graph against private account metadata, the current
DeviceID, current-machine placements, and the operating-system credential
store. It makes a checksummed explicit backup, stages a complete same-volume
copy, writes `accounts/<ConfigurationTreeID>/`, writes local
`placements.yaml`, moves private connection/device metadata beneath that
account, copies the credential into its account-keyed slot, advances the local
stamp to 4, validates the staged result, and atomically swaps it into place.
The old credential remains available for rollback. An exact rerun validates
the v2 result and reports `alreadyMigrated: true` without mutation.

## Commands

Follow [the common migration procedure](../README.md#the-procedure). The two
migration commands are:

```sh
bun run migrations/003-multi-canopy-accounts/run.ts canopy-root /data
bun run migrations/003-multi-canopy-accounts/run.ts local-home ~/.arbor \
  --backup ~/arbor-migration-2026-09-03/multi-canopy-accounts/dot-arbor.before
```

Before the live commands:

1. Create and checksum the live Canopy archive while schema 4 is still serving.
2. Download it and repeat the green rehearsal recorded in
   [rehearsal.md](rehearsal.md).
3. Record an authored manifest for every local placement.
4. Confirm Arbor Native and Arbor on iPhone are closed, every placement was
   idle, and `arbor daemon stop` completed.
5. Deploy the schema-5 build into maintenance mode, migrate `/data`, redeploy,
   and verify its report before migrating the local home.

Bring the daemon back only after both persistent targets are v2. Verify account
enumeration, credentials, configuration roots, all placements, canonical/raw
resolution, one reversible edit, restart, and authored-file equality. Update
and re-place the iPhone last. Keep the server archive, restored copies, local
home backup, reports, and manifests for two weeks.

## Rollback

Before the new daemon starts, restore the schema-4 Canopy archive and redeploy
the previous image. If the local mode has run, move the v2 home aside and copy
the explicit `dot-arbor.before` directory back to its original path. After any
new writer starts, stop all new writers before restoring both authorities; do
not run mixed v1/v2 writers.

Reports contain safe IDs, roots, paths, counts, and aggregate checksums only.
They never contain raw credentials, credential digests, proof material, or
authored content.
