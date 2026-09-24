# Migration 019: one access store (19 → 20)

One cutover from the live schema 19, which [migration 018](../018-log-entries/README.md)
deployed on 2026-09-24. The build that needs it keeps each tree's access in one place:
a tree an account owns is governed by that account's resource rules alone, and the
`access` table holds only the entries of trees no account owns. It also drops columns
nothing has read since the 2026-09-24 cleanup.

**Status: written and tested, not rehearsed or run.** The schema-20 build lives on
`claude/canopyd-code-review-jtaebc`. Do not merge it into `main` before step 5 below:
`main` deploys, and a schema-20 server serves maintenance mode on a schema-19 volume
until this migration runs.

## What changes

- **Owners.** For every active account configuration, the run reads the accepted
  `trees.yaml`. Each tree it hosts (declares with a `canonical`) that no account owns
  becomes that account's: `trees.account_id` is set. Under schema 19 these were the trees
  created at bootstrap (the community root and the bootstrap profiles), which a
  configuration converted at startup hosted without owning; their access was the
  `access` rows the configuration rewrote on every change.
- **Rules.** Each account's `resource_policy` rows are rewritten from its accepted
  resources. A configuration converted at bootstrap never had them written until its
  first edit.
- **Access rows.** Every owned tree's `access` rows are deleted: they were a lossy
  whole-tree copy of the owner's rules. Rows of trees no account owns stay.
- **Columns.** `trees.updated_at`, `tree_reservations.status` and `.error`,
  `account_challenges.claim_digest` and the `community_name` meta row are dropped.

Unchanged: tree ids, roots, refs, boundaries, accepted updates and entries, accounts,
devices, pairings, reservations, entry dates, document versions, profile facts.

**Behaviour the build changes with it.** Only an owned tree's owner administers it. Its
owner's rules keep governing it even if the community disables the owner, as the `access`
rows did. A configuration may not host another account's tree, and may not retire the
community root. `GET /.arbor/trees/{id}/access` builds an owned tree's `snapshot` from the
owner's whole-tree rules (same shape, ids stable per subject), so clients see no wire
change. Tree-listing `publicAccess` for an owned tree now comes from its rules via the
authorization checks, not from a stored `everyone` row.

## Preconditions

`run.ts` changes nothing and exits nonzero unless:

- the stamp is 19 (a second run reports `migrated: false`) and `quick_check` passes;
- every reservation is still `awaiting-initialization` with no error (so the dropped
  columns hold nothing);
- every account configuration's accepted `trees.yaml` parses;
- no tree without an owner is hosted by two accounts, and no owned tree is hosted by
  another account.

## Order inside the run

1. Check the stamp and run `quick_check`.
2. Read-only: parse every active account configuration, plan owners and rules, and
   compare each owned tree's `access` rows with its owner's whole-tree rules.
3. With foreign keys off, one transaction: set owners, rewrite `resource_policy`, delete
   owned trees' `access` rows, drop the columns and the meta row, stamp 20,
   `foreign_key_check`.
4. The startup schema check.

A crash before step 3 leaves the database unchanged. Progress goes to stderr; the report
is the single JSON line on stdout:

- `trees`: every tree with its unchanged root, path, status and owner after the run;
- `adopted`: the trees that gained an owner, and which account;
- `policyRewritten`: accounts whose `resource_policy` rows differed from their
  configuration;
- `accessRowsDeleted`;
- `accessDifferences`: per owned tree, whole-tree access its deleted rows granted that the
  owner's rules do not (`narrowed`), and the reverse (`widened`). The owner's own profile
  is never a difference. **Both lists should be empty**; any entry is a change in who can
  read or write that tree, to be understood before deploying;
- `unownedAccess`: the `access` rows kept.

Link subjects appear by kind only; no digest is reported.

## Runbook

From Joe's laptop, in the linked repository directory, after reading the
[standard procedure](../README.md#the-procedure).

0. **Check out the branch.** `git switch claude/canopyd-code-review-jtaebc && git pull && bun install`.
1. **Back up** as one archive while the old image runs (standard step 1), named
   `019-one-access-store`, and compare row counts (`trees`, `access`,
   `resource_policy`, `accounts`, `accepted_updates`).
2. **Download** it in the background (standard step 2) into
   `.backups/railway/<YYYYMMDDTHHMMSSZ>/` with a `source.txt` naming migration 019; check
   its sha256.
3. **Rehearse** on restored copies:

   ```sh
   bun run test:migration packages/canopyd/migrations/019-one-access-store
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
   bun run packages/canopyd/migrations/019-one-access-store/run.ts migrated | tee report.json
   bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
   ```

   Read the report: `accessDifferences` must be empty (or each entry understood and
   accepted), `adopted` should name only trees you expect your account to own (the
   community root and your profile, if your configuration hosts them), and a second
   `run.ts migrated` must report `migrated: false`. `compare-canopy-roots` must print
   `root unchanged` for every tree. Then serve the migrated copy with this build and
   verify it:

   ```sh
   bun run canopyd migrated --url https://<public-domain> --port 4399 --hostname 127.0.0.1
   curl -s http://127.0.0.1:4399/.arbor/integrity   # full audit, once: {"status":"ok"}
   bun run packages/canopyd/migrations/tools/verify.ts http://127.0.0.1:4399 report.json --no-sync
   ```

   Also open the public page of each publicly readable tree on 127.0.0.1:4399 without
   credentials, and a private one, to see public access unchanged. Record the result in
   the rehearsal log below. Repeat until green.
4. **Snapshot the Mac** (standard step 4) and **quiesce writers** (standard step 5).
5. **Deploy once.** Merge the branch into `main` and push; poll `railway deployment list`.
   The new server finds stamp 19 and serves maintenance mode by itself.
6. **Migrate in place.**

   ```sh
   railway ssh -- bun run packages/canopyd/migrations/019-one-access-store/run.ts /data | tee live-report.json
   ```

   `adopted`, `accessDifferences` and the owners must equal the rehearsal's. Then
   `railway redeploy --from-source -y` and poll `/` or a tree route until it serves.
   Never poll `/.arbor/health`.
7. **Bring the Mac back** (standard step 8). Roots and ids are unchanged, so placements
   only resume. Run `verify.ts` with `--sync` and the authored-manifest diff.
8. **Round trip one edit** (standard step 9), and open the Mac app's sharing panel for
   one tree to see its access list unchanged.
9. **iPhone last**, then **close out** (standard step 11): record the result in
   `status.md`.

Rollback before step 7 is `restore-canopy` from the archive and a redeploy of the previous
`main` (schema 19). After step 7 it also means restoring `~/.arbor`.

## Verification

```sh
bun run test:migration packages/canopyd/migrations/019-one-access-store
```

The test serves a community with this build (an owner who writes the community, a second
account, and a tree the owner declares with a link rule and activates), then rewrites the
root into the schema-19 layout: the dropped columns and meta row back, the bootstrap trees
without an owner and their rules only in `access`, the bootstrap configurations without
`resource_policy` rows, and the activated tree's rule copied into `access`. It checks that:

- the community root and the owner's profile become the owner's, and the second
  account's profile becomes its own;
- both accounts' rules are rewritten, all seven `access` rows go, no access differs, no
  link digest is reported, the columns and meta row are gone and the stamp is 20;
- the run happens once;
- this build serves the migrated root with the access schema 19 gave (public read of the
  community and profiles, writers, the link-only tree) and passes the integrity audit;
- a stamp other than 19, or an unowned tree hosted by two accounts, stops the run with
  nothing changed.

## Rehearsal log

Not rehearsed yet.
