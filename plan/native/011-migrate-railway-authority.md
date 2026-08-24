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
- **Progress**: IN PROGRESS — exact committed revision `ddd0edd` passed both four-host Hetzner suites on 2026-08-24 and their evidence was collected; the restored-volume rollback and migration rehearsal is next.

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
4. Against a separate copy of that restored volume, start the exact candidate image and let its real one-way startup upgrade run. Restart it to prove idempotence. Require one baseline accepted update per legacy tree, valid initial-device records for existing credentials, unchanged identities/refs/access/public hashes, and zero missing or corrupt objects. Do not substitute a special dry-run path for the code that production will execute.
5. Only after the restored-copy rehearsal and Hetzner gate pass, request explicit approval to mutate Railway. Pause writes, confirm the backup is retained, deploy the exact tested `updates-v1`/private-history/device-capable image, allow its one-way startup upgrade to complete, and restart once to prove idempotence.
6. Verify every preflight root is still the current ref, public HTML/Markdown hashes match, canonical discovery/access work, public accepted-history reads are absent, non-current/draft object access is denied to every wire subject, and existing local arbord reconnects.
7. Create an isolated private Railway test tree; repeat the short production smoke for one-sided sync, additive Markdown merge, structured client-owned conflict, canonical semantic-request replay, watch/internal history, and device revoke. This is a production-environment verification, not a substitute for the earlier Hetzner acceptance gate.
8. If any verification fails, stop the candidate image, restore the complete pre-upgrade volume backup, redeploy the previous image, and repeat the preflight checks before resuming writes. If verification succeeds, resume writes and retain the backup and previous image until Plan 019 is complete.

## Verification

Run the repository gates before deploy, then documented production smoke commands that reveal no secrets. Expected evidence:

- pre/post current directory roots and public Markdown hashes are identical;
- each legacy tree has one baseline linear history record and its exact original current root;
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

- [ ] The complete backup was restored and verified under the previous image before live deploy.
- [ ] A separate restored copy passed the real one-way upgrade and an idempotent restart with exact identities, refs, access, credentials, and public output.
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
