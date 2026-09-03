# Migration 003 rehearsal

## Automated fixtures

At 2026-09-03T10:10:18+02:00:

```text
bun test migrations/003-multi-canopy-accounts
4 passed, 0 failed, 30 assertions
```

The fixtures cover two accounts at one Canopy, every-account conversion,
production reopen, exact rerun, mismatched device policy, local backup and
atomic replacement, production local-registry restart, rollback-source restore,
authored-file preservation, current-device-only placement extraction, mixed
layouts, unknown stamps, and unavailable credentials.

## Retained schema-4 Canopy copy

The independent rehearsal copied, rather than modified, the retained
post-migration-002 data root. Its safe inventory was schema 4, two accounts,
two v1 configuration trees, nine total trees, and eleven credential-bound
devices.

Migration 003 converted both configuration trees:

```text
tr_4edxhzczqpnglwrmmcpy5q2bwe
  sha256:8891ac813b83e49410184ca63509c0204912da17601ff8de6261bf02155978c2
  -> sha256:24b6f25f1a9dd10d69f2343037175b4b98449e9fb597b41f4997fc61777e70a8

tr_vwzb2cxpal3kqy57jhqsct6d7a
  sha256:d5bef3ddb5bd97a7caacbff6dc5cb3b4a4a8bbf0c9f2d7bacdb8b46a2c7d022e
  -> sha256:bc2d52f911bb9ea391e1b5d20026eff59a601a66b9d09ef67c4bdac2898a73f4
```

`compare-canopy-roots` proved v1/v2 account semantics equal and all seven
ordinary tree roots byte-identical. The migrated copy reopened under the
production Canopy at schema 5. Serving it locally with its configured public
origin and running `verify.ts --no-sync` returned `{ ok: true, failures: [] }`.
The safe report checksum was
`6798503b54c5b7be61ee14e1ab8d0589995f417f21e632852a44de04b5e6263b`.

## Disposable copy of the current local shape

A disposable copy of the current default home—not the default home itself—was
migrated through the production runner. It retained configuration TreeID
`tr_vwzb2cxpal3kqy57jhqsct6d7a`, profile TreeID
`tr_j3adw24t7gexs3nraqrc4f4lre`, current DeviceID
`dv_xsqfhpxkjfnxwgqae6754shgde`, and four current-machine placements. Its
explicit backup contained 2,097 files and had aggregate checksum
`sha256:93d212c9295393266d6e6b63c02ac6f82ff3e31f3b563ff529fde1b1509bbc12`.

The staged result had state stamp 4 and exactly `account.yaml`, `trees.yaml`,
and `devices.yaml` under its configuration-ID checkout. The backup retained
the singleton files and stamp 3. An exact second run returned
`alreadyMigrated: true` with the same identity and four placements.

Both disposable private-data copies and the temporary rehearsal Keychain
credential were removed after verification. No persistent state changed.

## Authorized live cutover

Joe explicitly authorized the persistent Railway Canopy at
`https://resplendent-freedom-production-a839.up.railway.app` and the default
local home at `~/.arbor` on 2026-09-03.

Before deployment, the live schema-4 `/data` volume was archived at
`/data/backups/2026-09-03-multi-canopy-accounts/volume.tar`. Its SHA-256 was
`8b68f0a2ee1f3be3de623c2d5c57ac6a75eab934dafc489913136c48224c91a9`.
The downloaded archive matched that checksum and restored twice. Its live and
restored inventories agreed: nine trees, seven canonical boundaries, 65
reflog rows, 65 accepted updates, two accounts, twelve device rows, ten
pairings, eleven access rows, no reservations, and 65 observations.

The fresh restored-copy rehearsal produced these account-configuration roots:

```text
tr_4edxhzczqpnglwrmmcpy5q2bwe
  sha256:8891ac813b83e49410184ca63509c0204912da17601ff8de6261bf02155978c2
  -> sha256:24b6f25f1a9dd10d69f2343037175b4b98449e9fb597b41f4997fc61777e70a8

tr_vwzb2cxpal3kqy57jhqsct6d7a
  sha256:7414769f29913c1f7641363ab124c7ed53687fe1fdceec4e998130d4d084073f
  -> sha256:fdc69d2f42158047a47347d257bd1e36a6b4075d0143bd412d279f004af87433
```

All seven ordinary roots remained byte-identical and the migrated copy passed
production reopen and public verification. The schema-5 image then entered
maintenance, migration 003 changed persistent `/data`, and deployment
`80f65c08-f853-4a70-8798-e27185157fb4` returned public health to `ok`. The
live report exactly matched the fresh rehearsal and has SHA-256
`c726c94b0115ae9b4c34a0ec2d943b4f27c17b269239cb4d9c6c9b6e1e0128ec`.

The local migration retained configuration TreeID
`tr_vwzb2cxpal3kqy57jhqsct6d7a`, profile TreeID
`tr_j3adw24t7gexs3nraqrc4f4lre`, current DeviceID
`dv_xsqfhpxkjfnxwgqae6754shgde`, and four placements. Its explicit 2,097-file
backup has aggregate checksum
`sha256:93d212c9295393266d6e6b63c02ac6f82ff3e31f3b563ff529fde1b1509bbc12`.
The new home reports state stamp 4. The daemon enumerated the account and all
five placed/configuration trees, reached idle, passed full verification,
restarted, and returned to idle again.

A temporary page created in the Drift placement appeared at its canonical
`/~joe/drift/` URL and returned 404 after deletion. The before/after manifests
cover 102 authored files and are byte-identical, both with SHA-256
`55d7035931adce6efab7cad1192d8ecabe875cb1c23287592289f6197a4d10d4`.
The server archives, restored copies, reports, manifests, and local-home backup
are retained under `~/arbor-migration-2026-09-03/multi-canopy-accounts` for the
two-week observation window.

The current signed iOS artifact was built for and installed on the physical
iPhone without launching it or clearing its data. Joe then completed the
selected Mac-account QR flow, explicit iPhone placement, and app restart and
reported that it worked. The synchronized account configuration contains the
new account-scoped iPhone DeviceID, the Mac reports no account diagnostics, and
all local trees remain idle. This closed the deliberately-last live cutover
gate.
