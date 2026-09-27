# canopyd 019: Cut over to schema 26, key devices only

## Status

- **Priority:** P2
- **Effort:** S of Joe's attention (about an hour on the Mac), the code is written.
- **Risk:** MEDIUM. A live schema migration, a host deploy whose clients must
  follow in the same sitting, and a one-time data-home rename.
- **State:** READY 2026-09-27 on branch `claude/happy-davinci-pftumh`. The live
  host is at schema 23; nothing here runs without Joe's go-ahead.
- **Absorbs:** Security 006's close-out, Cleanup 007 (legacy compatibility and
  the data-home name) and canopyd 020 (CBOR object transport), whose code is
  on the branch. Their evidence is in [status](../../status.md).

## What the branch carries

The branch is one cutover: merged to `main`, it deploys a host that serves only
schema 26, and the Mac app, Arbor Sync and the iPhone must be rebuilt from it
in the same sitting.

| Part | Change | Needs on the live side |
|---|---|---|
| Batch step 024 | Drop `profile_resets` | The table is empty (the step refuses otherwise) |
| Batch step 025 | One `challenges` table with `purpose` | Nothing |
| Batch step 026 | `devices` loses `token_digest`; a device without a key must be revoked | The last digest device, `dv_ry4dqmh32o5ovzccizd2xfhhje` ("iPhone", unused since 2026-09-05), deauthorized first (the step refuses otherwise) |
| Key devices only | The spec, host, CLI, Arbor Sync, Mac and iPhone drop credential digests; Arbor Sync hands local clients sessions only | Every device a key device |
| CBOR transport | Update requests and results, and account claims, travel as canonical CBOR when negotiated; the claim's configuration is an activation element; `/v1/bootstrap` answers CBOR only | Mac app and CLI rebuilt with the daemon |
| Legacy readers removed | Scalar `/~handle` members, the pre-plural refusal, placements without a configuration tree, Keychain identities without metadata, early connection records, the earlier synchronizer's state, update control before schema 4, bare node dates, the iPhone rekey, the singleton credential | The survey passes |
| Data home | `~/.arbor/accounts/` becomes `~/.arbor/configurations/` | A `mv` while Arbor Sync is stopped |

## The survey

Before anything live, `packages/canopyd/migrations/next/survey.ts` checks, read
only, that the state each removal assumes gone is gone on the Mac, the iPhone
copy and the host. Each failing line names the commit to revert (or the
live step to take first). See the [batch README](../../packages/canopyd/migrations/next/README.md#before-cutover-the-survey).

## Cutover

The [batch runbook](../../packages/canopyd/migrations/next/README.md#cutover)
and the [common procedure](../../packages/canopyd/migrations/README.md#the-procedure),
with these additions in order:

1. **On the Mac, before anything live:** check out the branch, `bun install`,
   build and test the Swift packages and `CanopyAppTests`
   (the branch's Swift was compiled only on Linux), run `bun run test:protocol`.
2. **Survey.** Copy the iPhone's app container, run `survey-host.ts` against
   the host (it is not in the deployed image: run it over `railway ssh` with
   the script piped in, or against the backup from step 4), then `survey.ts`.
   Revert what fails, or fix the live state it names.
3. **Deauthorize the last digest device**, with Joe's go-ahead: from the Mac
   app's device list, or by deleting its entry from the checkout's
   `devices.yaml` while Arbor Sync runs. Either is an accepted update to the
   profile's configuration; see it leave `GET /.arbor/account`.
4. **Back up, download, rehearse** per the procedure: `bun run test:migration
   packages/canopyd/migrations/next`, restore twice, `run.ts`,
   `compare-canopy-roots` (every root unchanged), serve the copy and call
   `/.arbor/integrity` once. Record the rehearsal in the batch README.
5. **Quiesce, snapshot the Mac, rename the data home:** stop Arbor Sync,
   `cp -a ~/.arbor` as the procedure says, then
   `mv ~/.arbor/accounts ~/.arbor/configurations`.
6. **The cutover commit:** rename `migrations/next/` to
   `026-key-devices-only/` and start a fresh `next/`; merge to `main`, push, and
   wait for the build (it starts in maintenance mode on schema 23).
7. **Migrate in place** over `railway ssh`, redeploy, verify with `verify.ts`.
8. **Clients:** start Arbor Sync from the new checkout; rebuild and launch the
   Mac app; round-trip one edit; install the iPhone build and round-trip one
   edit from it.
9. **Close out:** record the result in `status.md`, the batch README and the
   schema history; delete this plan. Migration directories 018–023 go when
   their backups age out (018–021 after 2026-10-09, 022 after 2026-10-10, 023
   two weeks after this cutover).

**Gate:** the survey, the rehearsal, the Mac's Swift suites, and a round-trip
edit from the Mac and the iPhone after cutover.
