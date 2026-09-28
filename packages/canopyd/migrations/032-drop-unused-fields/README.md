# Migration 032: drop unused fields (batch 030–032)

Schema 29 to 32 in three steps, from the [canopyd cleanup
review](../../../../status.md#canopyd-cleanup-review--2026-09-28). Each step
removes something the host stored and never needed; none changes the wire, so
no client is replaced. The live run in place is `bun run
packages/canopyd/migrations/032-drop-unused-fields/run.ts /data`.

## Steps

The steps are files in `steps/`, listed in `run.ts`.
[`tools/batch.ts`](../tools/batch.ts) runs them and the final stamp in one
transaction, refusing (and changing nothing) on a schema outside the batch, a
failed `quick_check` or a dangling foreign key; a rerun reports
`migrated: false`. `run.ts` passes `assertCurrentHostSchema` and
`assertHostData` as `finish`.

| Step | Change | Product change at cutover |
|---|---|---|
| [030](steps/030-drop-tree-policy.ts) | `trees.policy` dropped: it is `tree-config-v1` exactly when `governs` is set. The step refuses (and the batch rolls back) a row where the two disagree. | `HostTree.policy` and `isTreeConfigPolicy` go; readers test `governs !== null` or `kind`: `model.ts`, `access.ts` (`accessLevel`, `canWrite`, `canAdminister`), `canopy.ts` (the tree select, `writableProfiles`, the mount query and mount checks, `submitCandidateLocked` and `submitSemanticCandidate`'s policy choice, `subjectFor`, the remote-group prefetch, `insertTree` and `insertConfig`) and `schema.ts` (`AUTHORITY_SCHEMA`, `createHostSchema`, `assertHostData`'s ordinary-tree test). |
| [031](steps/031-drop-unread-times.ts) | `profile_locator_pins.pinned_at`, `pairings.created_at` and `device_sessions.created_at` dropped; each is written and never read. | Their inserts in `locator-pins.ts` (`write`) and `accounts.ts` (`insertSession`, `createPairing`) stop writing them; `AUTHORITY_SCHEMA`, `createHostSchema`, `createDeviceSessionsTable` and `tests/unit/canopyd/locator-pins.test.ts`'s table lose them. |
| [032](steps/032-profile-facts-unversioned.ts) | Each `profile_facts.facts` loses `version: 3`, which nothing reads; the step refuses any other version. | `RootProfileFacts.version` goes from `profile.ts` (the type, the empty read and `readRootProfile`) and `canopy.ts` (`profileCard`'s default). |

## Cutover

The [common procedure](../README.md#the-procedure) applies. No data-home
rename and no client rebuild. The batch report has no per-tree roots, so
`verify.ts` reads a `roots.json` of `{ trees: [{ id, root }] }` taken from
the backup's trees.

```sh
bun run test:migration packages/canopyd/migrations/032-drop-unused-fields
bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
bun run packages/canopyd/migrations/032-drop-unused-fields/run.ts migrated | tee report.json
bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
```

## Rehearsal log

- 2026-09-28: synthetic schema-29 host (`migrate.test.ts`, 5/5), rewritten
  from a root this build wrote.
- 2026-09-28: live read-only check: 3 ordinary trees without `governs`
  and 3 `tree-config-v1` trees with it; both `profile_facts` rows at
  version 3; no pins, 4 pairings, 2 sessions.
- 2026-09-28: live backup `.backups/railway/20260928T205405Z/volume.tar`
  (sha256 `43ea282d…`, 173 MB; live and vacuumed row counts equal). The
  archive's imports resolve under the image's `bun install --frozen-lockfile
  --production`. `run.ts migrated`: 29 → 32 through 030, 031 and 032; a
  rerun reports `migrated: false`; `assertCurrentHostSchema` and
  `assertHostData` pass. `compare-canopy-roots` (now reading `governs` where
  `trees.policy` is gone): all 6 roots unchanged. Served with this build:
  `verify.ts --sync` ok (6 trees), `/.arbor/integrity` ok (called once).
