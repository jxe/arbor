# canopyd 019: Migration batch 024

## Status

- **Priority:** P3
- **Effort:** S for what is in it now; each step that joins adds its own.
- **Risk:** MEDIUM. A live schema migration, run once for the whole batch.
- **State:** PLANNED 2026-09-27. The batch lives in
  [`packages/canopyd/migrations/next/`](../../packages/canopyd/migrations/next/README.md)
  with one step (024, dropping `profile_resets`), tested against a synthetic
  schema-23 host. The live host is at schema 23 and serves it unchanged; nothing
  here runs without Joe's go-ahead.
- **Follows:** [migration 023](../../packages/canopyd/migrations/023-device-keys/README.md)
  (device keys, 2026-09-26) and the withdrawal of the profile-key reset
  (Security 006, 2026-09-27).

## Why a batch

Each migration so far meant its own backup, download, rehearsal, quiesce,
deploy and verification, about an hour of Joe's attention for changes that
were often one table. From 024 on, schema changes wait in `migrations/next/`
as steps and cut over together. `main` stays deployable meanwhile: product
code stops using what a step removes before the step exists (as the reset code
was removed before its table), and anything a step adds is used only from the
cutover commit.

## What is in it

| Step | Change | Why |
|---|---|---|
| 024 | Drop `profile_resets` | The profile-key reset was withdrawn for the operator's recovery pairing, which needs no table. It has never held a row live; the step refuses if it does. |

## Candidates to add before cutover

Each joins as a step when its plan reaches its schema work; the challenge
table is ready whenever the batch wants it.

- **Actor columns on accepted updates**, [canopyd 006](../canopyd/006-line-provenance.md)
  (line provenance): a server-derived actor per accepted update.
- **Placement accounts and cached device keys**, [Security 007](007-placement-hosts.md)
  Phase 2's placement role: host state for accounts whose home is another
  host.
- **The packed-object index**, [canopyd 001](../canopyd/001-pack-object-storage.md), if
  packing goes ahead after measurement.
- **One challenge table.** `account_challenges` (account claims) and
  `device_challenges` (device sessions) have identical columns and already
  share `AccountDirectory.insertChallenge`, `challenge` and
  `consumeChallenge`, which take the table name. The step creates one
  `challenges` table with `purpose TEXT NOT NULL` (CHECK `account-claim` or
  `device-session`), copies the unexpired, unconsumed rows of both (the rest
  can never be redeemed), and drops the two tables. The column keeps what the
  separate tables give today, since an account challenge carries no `purpose`
  field of its own, without a wire change. Product change at cutover: the
  helpers take `purpose` in place of the table name and filter every read and
  consume on it; `schema.ts` and the host reference's device-keys paragraph
  follow. Its test: a challenge issued for one purpose is refused by the
  other route.

## When to cut over

When a step's product change is needed live (Security 007's placement role is
the likeliest first), or whenever Joe wants the `profile_resets` cleanup live.
There is no deadline: the unused table costs nothing.

## Cutover

The [batch runbook](../../packages/canopyd/migrations/next/README.md#cutover)
and the [common procedure](../../packages/canopyd/migrations/README.md#the-procedure):

1. Write the cutover commit: `CANOPY_SCHEMA_VERSION` to the batch's last
   schema, each step's product change, `finish` in `run.ts`, and the directory
   renamed from `next/` to `024-<batch-name>/` (or the last schema's number).
2. Back up the live volume and download the archive.
3. Rehearse on restored copies; `compare-canopy-roots` must find every tree
   unchanged; serve the migrated copy and call `/.arbor/integrity` once.
4. With Joe's go-ahead: quiesce, push the cutover commit (it starts in
   maintenance mode on schema 23), run the batch over `railway ssh`, redeploy,
   verify, round-trip one edit.
5. Record the result in the batch README, `status.md` and the schema history
   table, start a fresh `next/`, and delete this plan.

**Gate:** `bun run test:migration packages/canopyd/migrations/next`,
`bun run typecheck`, `bun run test`, and the rehearsal on a fresh backup.
