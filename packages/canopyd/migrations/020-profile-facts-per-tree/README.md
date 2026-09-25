# Migration 020: profile facts per tree (20 → 21)

One cutover from schema 20, which [migration 019](../019-one-access-store/README.md)
deployed on 2026-09-24. The build that needs it (canopyd 018) keeps a tree's profile
facts in one `profile_facts` row per tree instead of one `meta` row per accepted profile
root, and recomputes them only when an update touches `_index.md` or the declared
avatar.

**Status: written and tested on disposable data only; not rehearsed on a backup and not
run live.** The rehearsal and the live run wait for Joe's go-ahead.

## What changes

- **Rows.** For every tree, the run reads the head with this build's `readRootProfile`.
  A head that declares `type: person` or `type: group` gets a `profile_facts` row:
  `tree_id`, `index_hash` (the head's root `_index.md` object), `avatar_path` (the
  avatar path its frontmatter declares, even when no file is there) and `facts` (the
  same `RootProfileFacts` JSON schema 20 stored). No other tree gets a row.
- **Meta.** Every `meta` row whose key starts with `profile:` is deleted: the heads' rows
  and every row an earlier root left (the community had one per edit of its
  `_index.md`). `meta` then holds only configuration keys.

Unchanged: tree ids, roots, refs, boundaries, accepted updates and entries, accounts,
devices, access, resource rules, entry dates, document versions.

**Behaviour the build changes with it.** None visible: authorization and the directory
read the same facts, keyed by tree rather than by root. `profileCard` no longer parses a
root that has no row; such a tree is not a profile, as before.

## Preconditions

`run.ts` changes nothing and exits nonzero unless:

- the stamp is 20 (a second run reports `migrated: false`) and `quick_check` passes;
- every head with a `profile:<head>` row rebuilds exactly that row's facts
  (compared as canonical JSON);
- every head that declares a type had a `profile:<head>` row.

Either failure is an `UnmigratableProfileError` naming the tree; understand it before
continuing (for example, a parser change since the row was written).

## Order inside the run

1. Check the stamp and run `quick_check`.
2. Read-only: rebuild every head's profile and compare it with its `meta` row.
3. One transaction: create `profile_facts`, insert the rows, delete the `profile:` meta
   rows, stamp 21, `foreign_key_check`.
4. The startup schema check and the row invariants (`assertCurrentCanopySchema`,
   `assertCanopyData`).

A crash before step 3 leaves the database unchanged. Progress goes to stderr; the report
is the single JSON line on stdout:

- `trees`: every tree with its unchanged root, path and status;
- `profiles`: each row written, as tree, type, `indexHash` and `avatarPath` (no member,
  display name or description);
- `metaRowsDeleted`, and `historicalRows`: how many of those named a root that is no
  tree's head.

## Runbook

From Joe's laptop, in the linked repository directory, after reading the
[standard procedure](../README.md#the-procedure).

0. **Check out the branch** carrying canopyd 018 and run `bun install`.
1. **Back up** as one archive while the old image runs (standard step 1), named
   `020-profile-facts-per-tree`, and compare row counts (`trees`, `meta`,
   `accepted_updates`, and `SELECT COUNT(*) FROM meta WHERE key LIKE 'profile:%'`).
2. **Download** it in the background (standard step 2) into
   `.backups/railway/<YYYYMMDDTHHMMSSZ>/` with a `source.txt` naming migration 020; check
   its sha256.
3. **Rehearse** on restored copies:

   ```sh
   bun run test:migration packages/canopyd/migrations/020-profile-facts-per-tree
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
   bun run packages/canopyd/migrations/020-profile-facts-per-tree/run.ts migrated | tee report.json
   bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
   ```

   Read the report: `profiles` should name the community (`group`), each account's
   profile (`person`) and any group tree, and nothing else; `metaRowsDeleted` must equal
   the backup's `profile:` row count; a second `run.ts migrated` must report
   `migrated: false`. `compare-canopy-roots` must print `root unchanged` for every tree.
   Then serve the migrated copy with this build and verify it:

   ```sh
   bun run canopyd migrated --url https://<public-domain> --port 4399 --hostname 127.0.0.1
   curl -s http://127.0.0.1:4399/.arbor/integrity   # full audit, once: {"status":"ok"}
   bun run packages/canopyd/migrations/tools/verify.ts http://127.0.0.1:4399 report.json --no-sync
   ```

   Also fetch `GET /.arbor/directory` with Joe's device credential on both the live
   server and 127.0.0.1:4399 and compare the bodies. Record the result in the rehearsal
   log below. Repeat until green.
4. **Snapshot the Mac** (standard step 4) and **quiesce writers** (standard step 5).
5. **Deploy once.** Merge the branch into `main` and push; poll `railway deployment list`.
   The new server finds stamp 20 and serves maintenance mode by itself.
6. **Migrate in place.**

   ```sh
   railway ssh -- bun run packages/canopyd/migrations/020-profile-facts-per-tree/run.ts /data | tee live-report.json
   ```

   `trees` and `profiles` must equal the rehearsal's. Then
   `railway redeploy --from-source -y` and poll `/` or a tree route until it serves.
   Never poll `/.arbor/integrity`.
7. **Bring the Mac back** (standard step 8). Roots and ids are unchanged, so placements
   only resume. Run `verify.ts` with `--sync` and the authored-manifest diff.
8. **Round trip one edit** (standard step 9), then edit the profile's `_index.md`
   `displayName` and see the directory show the new name.
9. **iPhone last**, then **close out** (standard step 11): record the result in
   `status.md`.

Rollback before step 7 is `restore-canopy` from the archive and a redeploy of the previous
`main` (schema 20). After step 7 it also means restoring `~/.arbor`.

## Verification

```sh
bun run test:migration packages/canopyd/migrations/020-profile-facts-per-tree
```

The test serves a community with this build (an owner who writes the community, a second
account, a group tree listing the second account and a tree the group may read), edits
the community twice and gives the owner's profile an avatar, then rewrites the root into
the schema-20 layout: `profile_facts` dropped, a `profile:<head>` row for each typed head
and one for each of the community's two earlier roots. It checks that:

- the run writes exactly the rows this build wrote (tree, `_index.md` object, avatar
  path, facts), deletes all six `profile:` rows (two historical), stamps 21 and reports
  no member locator;
- the run happens once;
- this build serves the migrated root: types by tree, group access, the avatar card and
  the community's members, and the integrity audit passes;
- a stamp other than 20, a head whose facts differ from its row, or a typed head without
  a row stops the run with nothing changed.

## Rehearsal log

Not yet rehearsed on a backup, and not run live: both wait for Joe's go-ahead.

- **2026-09-24, disposable data only.** The focused suite passes (5 tests) against data
  the test creates.
