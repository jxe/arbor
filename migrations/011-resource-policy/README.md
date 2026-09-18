# Migration 011: resource policy preparation (12 → 13)

**Deployed on 2026-09-18; rollback window and soak remain open.** Complete the remaining [Apps 004](../../plans/apps/004-mutation-permissions.md)
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

### September 18 production-copy rehearsal

The downloaded schema-12 snapshot contained 1,038 accepted updates through 2619.
Its archive checksum matched the remote backup. All 4,534 immutable object hashes
verified (227,142,691 bytes); SQLite quick check and foreign keys passed.
Schema conversion preserved all tree roots. The guarded configuration conversion
produced the prepared root exactly, exact replay returned the same receipt, and
all ordinary content roots remained unchanged. The derived resource index has two
rows. HTTP checks using the existing administrator credential on a loopback-only
copy returned 200 for authorized access, 404 for an anonymous private-tree read,
and 409 for a stale guarded update. No credentials or authored content are recorded
in this report.

Matched Mac and physical-iPhone builds passed. The live TypeScript/Swift protocol
gate passed; focused authority tests passed 19 tests, and migration tests passed
3 tests. The full product suite passed 1,050 tests with only the previously
reproduced private-tree CLI placement failure. TypeScript checking and relative-link
checking passed apart from existing/example targets.

The final quiesced backup is separate from the rehearsal snapshot. Native completed
all 34 pending authored changes before shutdown. Arbor Sync's Todos filesystem
placement remains at its older accepted state with pre-existing file-read errors;
its state is preserved rather than reset. Configuration/profile manifests and the
entire Mac private data home are backed up. Do not infer filesystem placement health
from Native's completed publication.

### September 18 live cutover

Clean main revision `82e0c8e` was deployed to `canopy-arb-nxhx-org`;
active Railway deployment is `cd17ea6e-c5f1-4452-bb6e-6ab8a801c519`.
The final quiesced archive passed its remote/local checksum comparison and SQLite
quick/foreign-key checks, with 1,072 accepted rows through update 2653.
The offline schema step backed up schema 12 and advanced to 13. The ordinary
guarded configuration submission returned 201 at update 2654 with the exact
rehearsed root. All four non-configuration roots stayed unchanged; the accepted
count advanced by exactly one and the derived resource index has two rows.
Authorized access returned 200, anonymous Todos access 404, and a stale guarded
configuration write 409.

Signed matching Mac and iPhone builds were installed over the existing apps.
Both retained Todos at accepted update 2653 with the server's exact root; Mac
reopened with the recovery edits visible and fully synced. Arbor Sync pulled the
configuration to 2654, and local `trees.yaml` exactly matches the prepared bytes.
Account, device and profile file hashes are unchanged. No device was re-paired.

The pre-existing filesystem catch-up failure was traced to six undownloaded iCloud
placeholders. Foundation download requests hydrated them, and an ordinary sync
advanced Todos from 2564 to 2653 with the exact server root. All three placements
are idle. No content reset or replacement was needed.

Private backups are retained at `/Users/joe/arbor-permissions-cutover-20260918`
and `/data/backups/permissions-20260918-cutover`. Runtime provider integration,
interactive consent/conflict exercises and ordinary-use soak remain open; this
cutover does not activate an apps sidecar. Do not delete rollback artifacts.
