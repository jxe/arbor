# Plan 011: Upgrade the Railway authority

> **Executor instructions**: This is the first plan allowed to mutate the configured live authority. Obtain explicit operator confirmation immediately before the live deploy. Never print credential values. Upgrade only after a complete volume backup has been restored and migrated successfully in isolation and the exact committed revision has passed Hetzner. On any live mismatch, stop the new image and restore the backup with the previous image.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- packages/authority packages/wire packages/arbord packages/cli deploy tools tests plan/native`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plans 009 and 010
- **Category**: production migration
- **Planned at**: Arbor `dc34126`, 2026-08-23
- **Progress**: IN PROGRESS — exact committed revision `ddd0edd` passed both four-host Hetzner suites and the isolated restored-copy startup upgrade/restart under Bun 1.3.14; the write-frozen production authority is ready for explicit live-deploy approval.

## Backup evidence

Railway-managed snapshots are unavailable on the current Hobby workspace, so the rollback artifact is an application-consistent export: SQLite `VACUUM INTO` plus the complete immutable-object store and a safe preflight manifest. The archive remains on the production volume and an off-volume copy is retained at `/Users/joe/src/arbor-backups/railway/20260824T120458Z/arbor-authority-20260824T120458Z.tar.gz` with SHA-256 `3fdfd1b4638d37708d573543f61070c58d05a8e8aa90c97f8175691657b21eff`.

The downloaded archive passed SQLite `quick_check`, contained 101 hash-valid immutable objects totaling 947,073 bytes, and recorded four trees, two accounts, eight access entries, and 49 reflog entries without credential material. Every tree's latest reflog root matched its current ref. A separate extracted copy started under deployed source `dc34126` and exact Bun 1.3.14 while bound only to localhost and retaining the production canonical origin. Health passed, and the HTML and Markdown hashes for `/`, `/~joe`, `/~joe/drift`, and `/~mariana` matched the live preflight exactly. The downloaded archive remains unchanged and the tested old-image restore is retained. The sole operator has stopped arbord and is holding all writes, so this retained archive is the final pre-upgrade backup.

## Candidate rehearsal evidence

A second copy of the restored volume started under exact committed candidate `ddd0edd15f6261e3cb07234e14a561b47965c4c4` and exact Bun 1.3.14, bound only to localhost with the production canonical origin retained. The real startup path converted all 49 legacy reflog rows into 49 accepted updates with matching tree, root, previous root, kind, timestamp, and order; no current-root baseline was needed because every reflog already ended at its tree's current ref. It created exactly one unrevoked `Initial device` for each of the two existing accounts, preserving both credential digests, and created no pairing.

Before and after restart, SQLite `quick_check` passed; all legacy tree, boundary, reflog, account, access, and metadata rows remained exact; all 101 object path/content hashes remained exact; and the four public HTML and Markdown hashes matched the preflight. Restart retained the same accepted-update and device IDs without adding rows. The existing locally stored Joe credential authenticated against the isolated candidate, returned the same account/profile identity and its migrated device, and changed only that device's expected `last_used_at` field. No raw credential was printed, copied, or recorded. Production was not deployed, restarted, or migrated during this rehearsal.

## Why this matters

Native sync cannot qualify against a fictional environment. The configured Railway authority already contains the community, Joe profile, and drift tree, so the rollout must add server-assisted sync, retained history, and device attribution without changing their exact current roots, content, URLs, identities, or access.

## Preconditions

- A complete Railway volume backup can start under the previous image after isolated restore.
- The real one-way startup upgrade passes against a separate restored copy of that backup.
- The local arbord/CLI and authority move together to accepted updates; legacy `/push` is removed rather than negotiated.
- Device-credential migration preserves current access.
- The exact candidate revision passes both `bun run lab:hcloud test` and `bun run lab:hcloud test:authorization` on the disposable four-host Hetzner lab, and their non-secret evidence has been collected.
- The live endpoint is discovered from safe local configuration; never copy its credential into the plan or command history.

## Scope

**In scope**: complete volume backup, isolated old-image restore and new-image one-way-upgrade rehearsal, disposable Hetzner acceptance gate, approved live deploy, current-tree/device verification, isolated private sync test, old-image/volume rollback, recorded non-secret evidence.

**Out of scope**: native app deployment, Hunch workspace, new public access, canonical path changes, unrelated production administration.

## Steps

1. Record safe preflight evidence: tree IDs/canonical paths/access, current root refs, current public Markdown hashes, schema version, object count, and service revision.
2. From the exact committed candidate revision, run `bun run lab:hcloud test` and `bun run lab:hcloud test:authorization` on the four disposable Hetzner hosts. Require serial and three-writer convergence, private accepted-history/derived-request replay invariants, absence of public history and historical-object access, client-owned conflict persistence across restart and explicit resolution, `/push` absence, pairing/revocation, distinct-account read/write collaboration, read-only write denial without history/object retention, and existence-hiding denial for an authenticated subject with no access. Collect evidence and tear down the disposable hosts. Any failure returns to Plans 008–010; it is not waived during live approval.
3. Create a complete Railway volume backup. Restore a copy into an isolated authority and start it with the currently deployed image. Verify the preflight identities, refs, access, credentials, object integrity, and public hashes. This proves the rollback artifact before any live mutation.
4. Against a separate copy of that restored volume, start the exact candidate image and let its real one-way startup upgrade run. Restart it to prove idempotence. Require each legacy reflog row to become one accepted update in the same per-tree order, appending a current-root baseline only if the latest legacy reflog root did not already equal the current ref. Also require valid initial-device records for existing credentials, unchanged identities/refs/access/public hashes, and zero missing or corrupt objects. Do not substitute a special dry-run path for the code that production will execute.
5. Only after the restored-copy rehearsal and Hetzner gate pass, request explicit approval to mutate Railway. Pause writes, confirm the backup is retained, deploy the exact tested `updates-v1`/private-history/device-capable image, allow its one-way startup upgrade to complete, and restart once to prove idempotence.
6. Verify every preflight root is still the current ref, public HTML/Markdown hashes match, canonical discovery/access work, public accepted-history reads are absent, non-current/draft object access is denied to every wire subject, and existing local arbord reconnects.
7. Create an isolated private Railway test tree; repeat the short production smoke for one-sided sync, additive Markdown merge, structured client-owned conflict, canonical semantic-request replay, watch/internal history, and device revoke. This is a production-environment verification, not a substitute for the earlier Hetzner acceptance gate.
8. If any verification fails, stop the candidate image, restore the complete pre-upgrade volume backup, redeploy the previous image, and repeat the preflight checks before resuming writes. If verification succeeds, resume writes and retain the backup and previous image until Plan 019 is complete.

## Verification

Run the repository gates before deploy, then documented production smoke commands that reveal no secrets. Expected evidence:

- pre/post current directory roots and public Markdown hashes are identical;
- accepted-update history preserves every legacy reflog row in the same per-tree order, adds a current-root baseline only where the legacy reflog did not already end at that root, and retains every exact original current root;
- Railway restart retains private accepted-update history, accepted-row request digests, and devices; rejected conflicts leave no authority-side state;
- local arbord can sync the isolated private tree and the server performs the merge;
- a revoked test device is denied.
- the pre-Railway Hetzner report records one committed revision on all four hosts and passes every accepted-update and distinct-user authorization scenario.

Also run:

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
git diff --check
```

## Done criteria

- [x] The complete backup was restored and verified under the previous image before live deploy.
- [x] A separate restored copy passed the real one-way upgrade and an idempotent restart with exact identities, refs, access, credentials, and public output.
- [x] The exact candidate revision passed both full Hetzner suites before live approval.
- [ ] All real trees preserved exact identity/content/access.
- [ ] `updates-v1` discovery is live and `/push` is absent from both server and clients.
- [ ] Device credentials and revocation work live.
- [ ] The complete pre-upgrade volume backup and previous image remain available through native cutover.

## STOP conditions

- Operator has not explicitly approved the live mutation.
- Either pre-Railway Hetzner suite or its evidence collection has not completed successfully.
- Any pre/post hash, TreeID, canonical path, or access differs unexpectedly.
- The backup cannot start an isolated restored authority under the previous image.
- The candidate image cannot upgrade and restart the copied volume without an identity/ref/access/credential/public-output mismatch.
- Local arbord cannot synchronize immediately after migration.

## Maintenance note

The startup upgrade is intentionally one-way. Operational rollback restores the complete pre-upgrade volume and previous image; do not attempt to reverse individual schema writes in place. Record only safe evidence in `plan/records/history.md`. Production secrets and user content do not belong in Git history.
