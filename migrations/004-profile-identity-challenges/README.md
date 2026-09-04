# 004: self-certifying profile identity challenges

**Status:** implemented and rehearsed on a downloaded `arb.nxhx.org` archive;
live cutover pending.

This offline schema migration adds the single-use `account_challenges` ledger
and advances a Canopy data root from schema 5 to schema 6. It does not rewrite
accounts, authored trees, roots, history, or credentials. Existing accounts
remain readable; all newly created person accounts use the self-certifying
profile claim defined by Interface 006.

```sh
bun run migrations/004-profile-identity-challenges/run.ts canopy-root /data
```

An operator-approved one-time conversion of an existing, unhosted random
profile identity is explicit and key-checked:

```sh
bun run migrations/004-profile-identity-challenges/run.ts canopy-root /data \
  --replace-profile <old-TreeID> <new-self-certifying-TreeID> \
  --public-key <raw-Ed25519-public-key-base64url>
```

That form verifies the public-key derivation, rewrites the exact community
reservation and account-configuration graph, replaces profile ACL subjects,
resets history only for those two changed authority trees, and leaves every
ordinary hosted tree and its root untouched. It refuses a hosted old profile,
an ambiguous account, or any mismatched key.

Run it only while the Canopy is stopped or in maintenance mode, after creating
and downloading a verified volume archive. Re-running it against an exact
schema-6 root validates the result and reports `alreadyMigrated: true`.

After the Canopy migration succeeds, rekey the matching offline Arbor home
without hand-editing its account files:

```sh
bun run migrations/004-profile-identity-challenges/run.ts local-home ~/.arbor \
  --configuration <configuration-TreeID> \
  --replace-profile <old-TreeID> <new-self-certifying-TreeID> \
  --profile-path ~/.arbor/profile \
  --backup <new-backup-directory>

arbor me restore <identity-backup> ~/.arbor/profile
```

The local form requires Arbor Sync to be stopped. It first validates the exact
account, connection metadata, placement, profile workspace identity, and all
replacement targets, then writes a complete backup before changing anything.
It serializes the account checkout exactly as the Canopy migration does,
updates the private connection hint, removes only the old profile placement,
rebinds the existing profile folder to the new TreeID, and discards only
rebuildable refs, sync journals, and that folder's workspace index. It does not
change any authored file in the profile or another placed tree. Restore then
installs the already-created private identity key in this Arbor home's
operating-system credential slot. Exact reruns report `alreadyMigrated: true`.

For `arb.nxhx.org`, the old profile is not hosted there, so the explicit rekey
form preserves the current todos root and account/device credentials without a
service or volume replacement. The checked-in deployment manifest supplies
the same new founder Profile TreeID for a future fresh bootstrap. Retain the
schema-5 archive for rollback.

## Rehearsal, 2026-09-04

The live schema-5 volume archive was checksummed on Railway, downloaded, and
matched locally at
`sha256:1a71465c9d29ded57d62af39aaa9c6d3060d465f26c029630a7f2e81564eda07`.
Migration 004 changed Joe's profile from
`tr_j3adw24t7gexs3nraqrc4f4lre` to
`tr_tkgfsmtkauhinhjg7wp6rcuf5mrxpo7gyfyherkbetd72jgln4ua`. The changed
community root is
`sha256:d22007191266b9e37ee45972967c9db8f5b9a2c9c2b168f43a4c168ea7bacabc`
and the changed account-configuration root is
`sha256:beaf25354f2ddbe59098b1cae850d26783be33a5463e48dfdf9043b6987fd9c3`.

Comparison showed exactly the expected community `_index.md`, `account.yaml`,
and `trees.yaml` identity changes. The todos tree
`tr_owozr6aegt5z7x6qyllvzljl5u` retained root
`sha256:9a17a71fcc71a51576b8c1bb79e46c362a827d610c3ada248b527a9004df5b45`.
An exact rerun was idempotent. The migrated copy reopened under the production
Canopy, passed complete object/SQLite integrity, retained Joe's write access to
todos under the new profile, and returned healthy over HTTP.

The local-home form was then rehearsed on a separate copy of the full pre-cutover
Mac data home. Its generated account checkout hashed to the same migrated
configuration root shown above. A directory comparison found only the expected
account/connection/placement/workspace-registry edits and removal of the old
profile/configuration caches; the todos placement and workspace were untouched.
An exact rerun reported `alreadyMigrated: true` and made no backup or edits.
