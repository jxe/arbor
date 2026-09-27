# canopyd 019: Cut over to schema 26, key devices only

## Status

- **Priority:** P2
- **Effort:** S of Joe's attention (about an hour on the Mac); the code is written.
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
| Legacy readers removed | Scalar `/~handle` members, the pre-plural refusal, placements without a configuration tree, Keychain identities without metadata, early connection records, the earlier synchronizer's state, bare node dates, the iPhone rekey, the singleton credential | The survey passes |
| Data home | `~/.arbor/accounts/` becomes `~/.arbor/configurations/` | A `mv` while Arbor Sync is stopped |

## The survey

`packages/canopyd/migrations/next/survey.ts` checks, read only, that the state
each removal assumes gone is gone on the Mac, the iPhone copy and the host.
Each failing line names the commit to revert or the live step to take first.
See the [batch README](../../packages/canopyd/migrations/next/README.md#before-cutover-the-survey).

## Cutover

The [common procedure](../../packages/canopyd/migrations/README.md#the-procedure)
applies, with these additions, in order. Every live step needs Joe's go-ahead.

1. **Build and test on the Mac.** Check out the branch and `bun install`. Run
   the Swift package suites, `swift/scripts/test-canopy-app.sh`
   (`CanopyAppTests`), and `bun run test:protocol`: the branch's Swift was
   compiled only on Linux against stand-ins, and the app target not at all.
   Replace the cloud-bundle fixture in `tests/unit/cloud-bundle.test.ts` with
   a string `CanopyCloudBundle.encode` really produces if the Swift test
   disagrees with it.
2. **Survey the Mac and the iPhone** (no `--live` yet): copy the iPhone's app
   container, run `survey.ts --iphone <copy>`, and check on the phone that
   Settings → Accounts shows only the current account and no claim is
   pending. Revert what fails, or fix the state it names.
3. **Deauthorize the last digest device**, `dv_ry4dqmh32o5ovzccizd2xfhhje`
   ("iPhone", unused since 2026-09-05), from the Mac app's device list or by
   deleting its entry from the checkout's `devices.yaml` while the current
   Arbor Sync runs. See it leave `GET /.arbor/account`. Step 026 refuses
   otherwise.
4. **Back up and download** (procedure steps 1–2), then **survey the host** on
   the restored copy: `restore-canopy.ts volume.tar before`,
   `survey-host.ts before > survey-host.json`, `survey.ts --iphone <copy>
   --live survey-host.json`. All must pass.
5. **Rehearse** (procedure step 3): `bun run test:migration
   packages/canopyd/migrations/next`, restore `migrated`, `run.ts migrated`,
   `compare-canopy-roots before migrated` (every root unchanged), serve the
   copy with this build and call `/.arbor/integrity` once. Record it in the
   batch README's rehearsal log.
6. **Snapshot and quiesce the Mac** (procedure steps 4–5), then rename the
   data home: `mv ~/.arbor/accounts ~/.arbor/configurations`.
7. **The cutover commit:** rename `migrations/next/` to
   `026-key-devices-only/` (fixing its links), start a fresh `next/` README
   with no steps, add schema rows 24–26 to the schema history, merge the
   branch to `main` and push. The new build starts in maintenance mode on
   schema 23.
8. **Migrate in place** over `railway ssh` (`026-key-devices-only/run.ts
   /data`), redeploy, verify (procedure steps 6–7).
9. **Clients:** start Arbor Sync from the new checkout and see every
   placement `idle`, the configuration checkout included; rebuild and launch
   the Mac app; round-trip one edit; install the iPhone build and round-trip
   one edit from it (procedure steps 8–10).
10. **Close out:** record the result in `status.md` and the batch README, and
    delete this plan. Migration directories go when their backups age out:
    018–021 after 2026-10-09, 022 after 2026-10-10 (with it the last reader
    of `account.yaml`), 026 two weeks after this cutover.

**Rollback** before step 9 is the procedure's: restore the archive and
redeploy the previous build, and `mv ~/.arbor/configurations ~/.arbor/accounts`
back with the old checkout.

**Gate:** the survey, the rehearsal, the Mac's Swift suites and
`CanopyAppTests`, and a round-trip edit from the Mac and the iPhone after
cutover.
