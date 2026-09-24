# Migration 018: accepted history as log entries (18 → 19)

One cutover from the live schema 18, which [migration 016](../016-squash-history/README.md)
deployed on 2026-09-24. It is step 7 of
canopyd 016 (completed; see [status](../../../../status.md#log-entries-and-one-merge-question--2026-09-24)). The build
that needs it stores each accepted update as an immutable log entry in the object store
and asks the merge sidecar one question; see
[writing a sidecar](../../../../docs/architecture/canopyd/writing-a-sidecar.md).

**Status: ran live 2026-09-24 at build `dd5313c8`; the live report matched the rehearsal.** Keep this directory and its backup until about 2026-10-08, then delete both.

## What changes

- **`accepted_updates`** gains `entry` (`TEXT NOT NULL`): the hash of the update's log
  entry. Every other column and every row is unchanged: roots, ordinals (wire ids and
  cursors), predecessors, conflict flags, receipts.
- **Log entries** (`overstory-log-entry-v1`, canonical JSON) are written into `objects/`,
  one per row, from the row and its schema-18 merge-state record:
  - `previous` is the predecessor row's entry, or `null` for a tree's first retained row
    (each head migration 016 kept), so each tree's rows form one hash chain;
  - `root` is the row's root; `change`, `trace` and `evidence` come from the record;
  - `resolves` is the decision keys the record's resolution declarations named in the
    predecessor's decisions (the report counts any that named none);
  - `decisions` are the record's, under the same keys, so every public decision and
    alternative id is unchanged: a choice about one entry names whole alternative roots
    (the row's root with each alternative's version at that path), a source choice names
    its range and each alternative's bytes, and a choice about the root names its roots.
    New directories those roots need are stored with the entries.
  - No entry records how the sidecar was asked (`asked`); a sidecar replays these entries
    by aligning to their recorded roots and decisions.
- **`accepted_merge_states`** is dropped. The merge worker's retained states it named stay
  in `objects/`, unreferenced; no build reads them.

Unchanged: trees, boundaries, accounts, devices, pairings, reservations, resource
policy, access, entry dates, document versions, profile facts. No wire change: every
conflict page is the same, apart from an alternative's `revision`, which now names its
value and contributions rather than the worker's state.

## Preconditions

`run.ts` refuses with nothing changed unless the stamp is 18 (a second run reports
`migrated: false`), every tree's newest row has its ref as root, every row has a merge
state whose decisions agree with its conflict flag, and every open decision converts
(an entry, a range of a file, or the root). Open decisions do **not** need resolving first.

No merge worker runs during the migration.

## Order inside the run

1. Check the stamp and run `quick_check`.
2. Read-only checks, then every entry built in ordinal order; entries and new
   directories stored durably.
3. With foreign keys off, one transaction: rebuild `accepted_updates` with `entry`, drop
   `accepted_merge_states`, keep the AUTOINCREMENT sequence, stamp 19,
   `foreign_key_check`.
4. The startup schema check.

A crash before step 3 leaves the database unchanged. Progress goes to stderr; the report
is the single JSON line on stdout: each tree's head (`id`, `root`, `update`, `entry`),
counts of entries, traced entries and open decisions at heads, `unmappedResolutions`
(should be 0) and `nextOrdinal`.

## Runbook

From Joe's laptop, in the linked repository directory, after reading the
[standard procedure](../README.md#the-procedure).

0. **Check out the branch.** `git switch claude/dazzling-keller-29kiss && git pull && bun install`.
1. **Back up** as one archive while the old image runs (standard step 1), named
   `018-log-entries`, and compare row counts.
2. **Download** it in the background (standard step 2) into
   `.backups/railway/<YYYYMMDDTHHMMSSZ>/` with a `source.txt` naming migration 018; check
   its sha256.
3. **Rehearse** on restored copies:

   ```sh
   bun run test:migration packages/canopyd/migrations/018-log-entries
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
   bun run packages/canopyd/migrations/018-log-entries/run.ts migrated | tee report.json
   bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
   bun run packages/canopyd/migrations/018-log-entries/rebuild-check.ts migrated | tee rebuild.json
   ```

   `compare-canopy-roots` must print `root unchanged` for every tree, and a second
   `run.ts migrated` must report `migrated: false`. `rebuild-check` is the plan's
   cold-rebuild measurement: a fresh sidecar rebuilds each tree's head from its chain's
   start, as the first merge after a restart will; each tree's `ms` is that cost and
   `same` must be true. If a tree's rebuild is too slow, stop: the fix is a snapshot entry
   that starts a chain later (canopyd 016's risks), not this migration.
   Then serve the migrated copy with this build and verify it:

   ```sh
   bun run canopyd migrated --url https://<public-domain> --port 4399 --hostname 127.0.0.1
   curl -s http://127.0.0.1:4399/.arbor/integrity   # full audit, once: {"status":"ok"}
   bun run packages/canopyd/migrations/tools/verify.ts http://127.0.0.1:4399 report.json --no-sync
   ```

   Compare a conflicted tree's `/conflicts` page against live, if any tree is conflicted
   (ignoring `revision`). Record the result in the rehearsal log below. Repeat until green.
4. **Snapshot the Mac** (standard step 4) and **quiesce writers** (standard step 5).
5. **Deploy once.** Merge the branch into `main` and push; poll `railway deployment list`.
   The new server finds stamp 18 and serves maintenance mode by itself.
6. **Migrate in place.**

   ```sh
   railway ssh -- bun run packages/canopyd/migrations/018-log-entries/run.ts /data | tee live-report.json
   ```

   The heads must equal the rehearsal's. Then `railway redeploy --from-source -y` and poll
   `/` or a tree route until it serves. Never poll `/.arbor/integrity`.
7. **Bring the Mac back** (standard step 8). Roots and ids are unchanged, so placements
   only resume. Run `verify.ts` with `--sync` and the authored-manifest diff.
8. **Round trip one edit** (standard step 9); a plain edit on the head is accepted without
   the sidecar, so also make one concurrent edit (two devices, or a snapshot on an older
   base) and see it merge.
9. **iPhone last**, then **close out** (standard step 11): record the result in
   `status.md` and delete canopyd 016's plan after recording its evidence there.

Rollback before step 7 is `restore-canopy` from the archive and a redeploy of the previous
`main` (schema 18). After step 7 it also means restoring `~/.arbor`.

## Verification

```sh
bun run test:migration packages/canopyd/migrations/018-log-entries
```

The test writes a history with this build (a snapshot, a plain traced edit, two
concurrent traced edits of one range, two concurrent snapshots of a binary file, both
choices left open at the head), records every update's conflict page, and rewrites the
root into the schema-18 layout with a merge-state record per update (decision keys and
inspections, evidence, the request with its resolution declarations). It checks that:

- every row is unchanged apart from its new entry, `accepted_merge_states` is gone, the
  stamp is 19, and each tree's entries chain in ordinal order;
- a fresh sidecar rebuilds each head from its chain and keeps its root and decisions;
- the run happens once;
- this build serves every recorded conflict page unchanged, passes the full integrity
  audit, and accepts the next update after the head with the head's entry as its
  entry's predecessor;
- a stamp other than 18, or an update without a merge state, stops the run with nothing
  changed.

## Rehearsal log

**2026-09-24, green.** Backup `.backups/railway/20260924T131328Z/volume.tar` (sha256
`7468b0d3…`, matches `/data/backups/018-log-entries/volume.tar`; live and vacuumed copy
both 5 trees, 22 accepted updates, 22 merge states, 2,812 document versions, 113 entry
dates, schema 18). Build: this branch with `main` merged (`249a3484`).

- Check 017 on `before`: 1 account configuration checked, none failing.
- `run.ts migrated`: 22 entries, 15 traced, 0 open decisions at heads,
  `unmappedResolutions` 0, `nextOrdinal` 4346, 11 ms. A second run reported
  `migrated: false` with the same heads.
- `compare-canopy-roots`: every tree `root unchanged`; migration-specific differences only.
- `rebuild-check`: all 5 trees `same: true`; the longest chain replayed 18 entries in
  120 ms, the others 1 entry in 1 to 6 ms.
- Served on 127.0.0.1:4399: `/.arbor/integrity` `{"status":"ok"}` (once);
  `verify.ts --no-sync` ok, no failures.
- No accepted row is conflicted, so there was no conflict page to compare; decision
  conversion is covered only by `migrate.test.ts`.

Heads the live run must reproduce (tree, update, root, entry):

| Tree | Update | Root | Entry |
|---|---|---|---|
| `tr_2y2grqksa3klhhv6aziplhl2ha` | 3494 | `ad65cac8…` | `d3ae20c9…` |
| `tr_boseki5agb24ysc6cxakwcq57i` | 2654 | `7962a24e…` | `30b63d71…` |
| `tr_owozr6aegt5z7x6qyllvzljl5u` | 4345 | `59755e67…` | `802925ca…` |
| `tr_tkgfsmtkauhinhjg7wp6rcuf5mrxpo7gyfyherkbetd72jgln4ua` | 3499 | `e99b1fa6…` | `edb51e2e…` |
| `tr_unkaimbksfitula6i5n4acid6y` | 1586 | `92bbe39c…` | `2e1589c4…` |

Any update accepted on live after this backup changes a head (and `nextOrdinal`); the live
report then matches this table only for trees nobody edited. Take the backup again at
cutover if anything was edited, and rehearse on that one.

## Live run

**2026-09-24, green.** Live was unchanged since the backup (22 updates, newest 4345).
Mac placements idle at the heads (after `brctl download` of iCloud-evicted files in the
Console folder); authored manifest (111 files) and `dot-arbor.before` taken; daemon
stopped. Pushed `dd5313c8`; the new build served maintenance mode by itself. `run.ts
/data` reported the rehearsal's exact heads, 22 entries, `unmappedResolutions` 0,
`nextOrdinal` 4346, 147 ms. After `railway redeploy --from-source -y` it served;
`verify.ts --sync` passed; the authored manifest diff was empty; the round trip was
accepted as 4346 (entry chained from the migrated head's) and 4347. The concurrent-edit
check ran in the conflict lab on this build instead (see `status.md`).
