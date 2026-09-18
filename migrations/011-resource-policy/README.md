# Migration 011: resource policy preparation (12 → 13)

**Prepared and tested on synthetic offline databases only. Not deployed or rehearsed
against Joe's production copy.** Complete the remaining [Apps 004](../../plans/apps/004-mutation-permissions.md)
implementation gates and follow [the operator procedure](../README.md) before live use.
Never retarget this migration after its rollback window begins.

## Prepare without changing accepted data

```sh
bun migrations/011-resource-policy/run.ts --inspect /path/to/offline-copy
bun migrations/011-resource-policy/run.ts --prepare /path/to/offline-copy --out /new/private/bundle
```

Preparation requires unambiguous v2 account configurations with matching accepted
heads. Legacy v1 configurations need their prior dedicated migration. The bundle
contains before/after `trees.yaml` and ordinary guarded update requests. It preserves
account/device object bytes, TreeIDs, credentials, source roots and content history;
only the intentional resource-rule YAML conversion changes. No code grants are
invented. Output files are private and no request is submitted. Repeating preparation
against the same accepted state produces the same intent. If heads change, prepare
again rather than removing guards.

## Offline schema step

After a full checksummed database/object backup and with writers quiesced:

```sh
bun migrations/011-resource-policy/run.ts --offline-database /offline/canopy.sqlite3 --backup /new/backup.sqlite3
```

The tool checks schema 12/integrity, refuses an existing backup path, creates and
verifies a SQLite backup, adds the derived `resource_policy` index, and advances the
stamp transactionally. It also records a durable new-format writer floor for each
v2 account, including accounts whose empty access lists look identical in both
YAML grammars. It never changes existing accepted roots or content rows. Schema 13
reruns diagnose the completed state. Startup performs no automatic migration.

Bring up the matched server/merge/client artifacts on the isolated copy, then submit
prepared requests through ordinary account-device authentication and verify accepted
roots and derived policy. The schema-only step deliberately retains old effective
ACLs until those guarded configuration updates commit. Keep runtime activation off
until converted policy and installed clients are verified. Do not reopen writers in
between unmatched steps during the eventual coordinated live rollout.

Rollback restores the matched schema-12 binary/database/object/configuration set.
Quiesce and preserve any post-cutover writes before restore; a database backup alone
is not permission to discard accepted updates. Retain the full backup until explicit
rollback-window closure.

## Verification

```sh
bun run test:migration migrations/011-resource-policy
```

Three tests cover schema/integrity refusal, backup and row preservation, idempotence,
and deterministic guarded configuration preparation with exact non-policy objects.
Production-copy rehearsal, live identity/byte comparison, clients, rollback exercise
and soak are still required.
