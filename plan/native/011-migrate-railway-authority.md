# Plan 011: Migrate the Railway authority

> **Executor instructions**: This is the first plan allowed to mutate the configured live authority. Obtain explicit operator confirmation immediately before backup/deploy/apply. Never print credential values. Abort and restore on any content/ref mismatch.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- packages/wire packages/arbord packages/cli deploy tools tests plan/native`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plans 009 and 010
- **Category**: production migration
- **Planned at**: Arbor `dc34126`, 2026-08-23

## Why this matters

Native sync cannot qualify against a fictional environment. The configured Railway authority already contains the community, Joe profile, and drift tree, so the rollout must add server-assisted sync, retained history, and device attribution without changing their exact current roots, content, URLs, identities, or access.

## Preconditions

- Sync/history migration and rollback pass on copied data.
- Local arbord/CLI negotiate both legacy root-CAS and `sync-v1` only for this bounded migration window.
- Device-credential migration preserves current access.
- The live endpoint is discovered from safe local configuration; never copy its credential into the plan or command history.

## Scope

**In scope**: backup/restore rehearsal, live deploy/migration, current-tree/device verification, isolated private sync test, recorded non-secret evidence.

**Out of scope**: native app deployment, Hunch workspace, new public access, canonical path changes, unrelated production administration.

## Steps

1. Record safe preflight evidence: tree IDs/canonical paths/access, current root refs, current public Markdown hashes, schema version, object count, and service revision.
2. Create a complete Railway volume backup and restore it into an isolated authority. Demonstrate rollback before touching live state.
3. Run migration dry-run against the restored copy; require one linear baseline history record per legacy tree, unchanged current root refs, and zero missing/corrupt objects.
4. With explicit approval, pause writes, deploy the `sync-v1`/history/device-capable server, apply the explicit migration transaction, and restart.
5. Verify every preflight root is still the current ref, public HTML/Markdown hashes match, canonical discovery/access work, non-current/draft access is restricted, and existing local arbord reconnects.
6. Create an isolated private test tree; exercise one-sided sync, two-client additive Markdown merge, structured conflict draft, exact request replay, watch/history, and device revoke. Verify both clients receive the server's accepted root and every added line. Remove only its local placement if desired; do not delete evidence needed for rollback.
7. Resume writes and retain the backup until Plan 019 is complete.

## Verification

Run the repository gates before deploy, then documented production smoke commands that reveal no secrets. Expected evidence:

- pre/post current directory roots and public Markdown hashes are identical;
- each legacy tree has one baseline linear history record and its exact original current root;
- Railway restart retains history, attempts/drafts, idempotency results, and devices;
- local arbord can sync the isolated private tree and the server performs the merge;
- a revoked test device is denied.

Also run:

```sh
bun run typecheck
bun test
bun run test:protocol
bun run build
git diff --check
```

## Done criteria

- [ ] Backup restore was demonstrated before apply.
- [ ] All real trees preserved exact identity/content/access.
- [ ] `sync-v1` discovery is live and new clients cannot silently downgrade.
- [ ] Device credentials and revocation work live.
- [ ] Rollback material remains available through native cutover.

## STOP conditions

- Operator has not explicitly approved the live mutation.
- Any pre/post hash, TreeID, canonical path, or access differs unexpectedly.
- The backup cannot start an isolated restored authority.
- Local arbord cannot synchronize immediately after migration.

## Maintenance note

Record only safe operational evidence in `plan/records/history.md`. Production secrets and user content do not belong in Git history.
