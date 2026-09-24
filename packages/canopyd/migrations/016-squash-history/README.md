# Migration 016: squash accepted history (17 → 18)

One cutover from the live schema 17, which [migration 015](../README.md#schema-history)
deployed on 2026-09-23. It is stage 2 of
[canopyd 015](../../../../plans/canopyd/015-squash-history-and-one-merge-state-model.md).
Stage 1 (every acceptance records a merge state) ships in the same deploy; this
migration makes the code that served rows written before it unreachable, and that code
is deleted.

**Status: implemented and tested, not rehearsed on a backup, not run.**

## What changes

Every tree keeps its head: the root is unchanged, and so is the head update's ordinal,
which is its wire id and its cursor. Everything before the head is dropped.

- **`accepted_updates`** keeps one row per tree, the head, under its old ordinal. The
  row keeps `accepted_at`, `subject`, `request_digest` and `change_id` (the receipt of the
  request that produced it) and gets `previous_ordinal = NULL` and `conflicted = 0`.
  - `id` is dropped: the wire id is `String(ordinal)`, as it already was for every update
    accepted since the observation log was folded in. The report's `respelledHeads` counts
    heads whose stored id was spelled otherwise; it should be 0, and a client placed at
    such a head re-places.
  - `previous_id` becomes `previous_ordinal`, a foreign key to the predecessor. The wire
    `previous.root` is read by joining the predecessor, so `previous_root` is dropped.
  - `kind`, `base_root`, `candidate_root`, `remote_root`, `merge_summary` and
    `transition_json` are dropped. Nothing read the first five. The watch derives a
    single update's transition from its predecessor's root and its own, as net
    catch-up already did for a backlog, with a 32-entry cache; the payload is built by
    the same function from the same roots, so frames are byte-identical.
- **`accepted_merge_states`** keeps one row per head, keyed by the ordinal
  (`accepted_id INTEGER`). Its record is new: a fresh, editable merge state checkpointed
  from the head root alone, exactly as tree creation records a tree's first root
  (`SemanticMerge.checkpoint(tree, null, root, "initial:<tree>")` through the merge
  worker). It has no decisions and no history, so no stored state carries records written
  by older code. The record loses `retention` (its roots were always `state` and
  `authored`); `request` stays, as the only stored copy of an authored candidate and
  trace, and `evidence` stays as the engine returned it.
- **Dropped tables:** `accepted_conflicts` (whole-entry decisions; none are open, by the
  precondition) and `authored_changes` (retained traces).
- **Kept:** `entry_metadata` loses `update_id` and `data_json` (nothing read them) and
  keeps every `modified_at`, so date pages are unchanged. `document_versions` keeps every
  row, in rowid order; its `update_id` is now opaque text without a foreign key, because
  most name squashed updates.
- **`access.claimed_profile`** is dropped (never written).
- **Profile facts.** Every `profile:<root>` row in `meta` is deleted, including rows in
  older formats for roots that are nobody's head, and rows are rebuilt for current heads
  that declare `type: person` or `type: group`, with the writer canopyd uses at acceptance
  (`recordProfileFacts`).
- **Objects** are not deleted. Every squashed root, state and alternative stays in
  `objects/`, unreferenced. [canopyd 001](../../../../plans/canopyd/001-pack-object-storage.md)
  packs live data only, or a later step prunes behind a fresh full audit.

Unchanged: every tree's root and `trees` row, accounts, devices, pairings, reservations,
resource policy, entry dates, document versions. No wire format changes. The
`AcceptedUpdate` of a head differs only in `previous`, which becomes `null`.

What is lost: accepted history before the cut. A client that retries a request accepted
before the cut (other than the head's) could have it accepted again, because its receipt
is gone; quiescing every client first (steps 5 and 6) is what makes that safe. Cursors
older than a head, and states older than a head in conflict inspection, answer as not
retained (`resync-required`, 404).

## Preconditions

`run.ts` refuses with nothing changed unless:

- the stamp is 17 (a second run reports `migrated: false`);
- every tree has an accepted update whose root is its `trees.ref`;
- **no tree has an unresolved decision at its head**: the head is not `conflicted`, its
  merge state has no decision, and no legacy conflict row at the head has one. The error
  names each tree by path, TreeID and update. Resolve them in Canopy, then run again.

The merge worker must start: the fresh states are computed by it, and after the deploy
every acceptance needs it (stage 1: an unavailable worker answers every acceptance,
including tree creation, pairing and account claims, with a retryable 503).

## Order inside the run

1. Check the stamp and run `quick_check`.
2. Read-only checks: heads, refs and open decisions.
3. For each tree, checkpoint the head root through the worker and store the new objects
   durably; read its profile facts.
4. With foreign keys off, one transaction: rebuild `accepted_updates` with the heads,
   drop the legacy tables, rebuild `accepted_merge_states`, `entry_metadata`,
   `document_versions` and `access`, rebuild the profile rows, keep the AUTOINCREMENT
   sequence (no ordinal is ever reused), stamp 18, `foreign_key_check`.
5. The startup schema check.

A crash before step 4 leaves the database unchanged (the objects written in step 3 are
unreferenced). Progress goes to stderr as JSON events; the report is the single JSON line
on stdout. The database is not vacuumed.

In the report, `trees` lists each head (`id`, `root`, `update`): the roots must equal the
backup's, and `update` is the id each placement already holds. `removedUpdates` is
everything but the heads; `nextOrdinal` is the next id the host assigns.

## Runbook

All from Joe's laptop, in the linked repository directory. Read the
[standard procedure](../README.md#the-procedure) first; the steps below follow it with
this migration's specifics.

0. **Check out the branch.**

   ```sh
   git switch claude/canopyd-code-review-pvrk0p
   git pull
   bun install
   ```

1. **Resolve open decisions** in Canopy for every tree, and let the Mac settle (every
   placement `idle` in `GET /v1/trees`). The rehearsal in step 4 names any that remain.
2. **Back up** as one archive while the old image runs (standard step 1), named
   `016-squash`. Compare row counts between the live database and the copy.
3. **Download** the archive in the background (standard step 2) into
   `.backups/railway/<YYYYMMDDTHHMMSSZ>/` with a `source.txt` naming migration 016, and
   check its sha256.
4. **Rehearse** on restored copies:

   ```sh
   bun run test:migration packages/canopyd/migrations/016-squash-history
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
   ```

   **Replay check (stage 1's rehearsal).** Before anything else, replay the recent
   history of every ordinary tree through this build's acceptance path. It copies
   `before` to a scratch directory (it never writes `before`), cuts each tree back to the
   update before its last 20 client updates, runs this migration there, submits those
   updates again in order, and compares each accepted root and conflict flag with the
   recorded one:

   ```sh
   bun run packages/canopyd/migrations/016-squash-history/replay-check.ts before --last 20 | tee replay.json
   ```

   `ok: true` means every replayed update reproduced its root and flag. A mismatch is a
   behavior difference between the deployed acceptance and this build's (or history the
   squash drops mattering to a merge): read it before going on. `skipped` lists updates
   that resolved decisions or whose basis was not replayed. `--tree <id>` narrows it,
   `--keep` keeps the scratch copy.

   Then migrate one copy and compare:

   ```sh
   bun run packages/canopyd/migrations/016-squash-history/run.ts migrated | tee report.json
   bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
   ```

   `compare-canopy-roots` must print `root unchanged` for every tree. A second
   `run.ts migrated` must report `migrated: false`. Then serve the migrated copy with this
   build and verify it:

   ```sh
   bun run canopyd migrated --url https://<public-domain> --port 4399 --hostname 127.0.0.1
   curl -s http://127.0.0.1:4399/.arbor/integrity   # full audit, once: {"status":"ok"}
   bun run packages/canopyd/migrations/tools/verify.ts http://127.0.0.1:4399 report.json --no-sync
   ```

   Read a tree's `/entry-metadata` and one document page. Record the result in the
   rehearsal log below. Repeat until green.
5. **Snapshot the Mac** (standard step 4): the authored manifest over every placement
   path, and `cp -a ~/.arbor dot-arbor.before`.
6. **Quiesce writers** (standard step 5): `bun run arbor daemon stop`; Canopy closed on
   the iPhone.
7. **Deploy once.** Merge `claude/canopyd-code-review-pvrk0p` into `main` and push; that
   deploys stage 1 and stage 2 together. Poll `railway deployment list` until the build
   succeeds. The new server finds stamp 17 and serves maintenance mode by itself.
8. **Migrate in place.**

   ```sh
   railway ssh -- bun run packages/canopyd/migrations/016-squash-history/run.ts /data | tee live-report.json
   ```

   The report's `trees` must equal the rehearsal's, apart from any tree changed between
   the backup and the quiesce (there should be none). Then
   `railway redeploy --from-source -y` and poll `/` or a tree route until it serves.
   Never poll `/.arbor/health`.
9. **Bring the Mac back** (standard step 8): `bun run arbor daemon start`. Roots and head
   ids are unchanged, so no placement re-places or advances; each should be idle within
   seconds. Then `verify.ts https://<public-domain> live-report.json --sync http://127.0.0.1:4317`
   and the authored-manifest diff, which must be empty.
10. **Round trip one edit** (standard step 9). Its update id is the report's
    `nextOrdinal`.
11. **iPhone last.** Open Canopy. Its placements are at the heads, so it only resumes.
12. **Close out** (standard step 11). Record the cut date in `status.md` and delete
    [canopyd 015](../../../../plans/canopyd/015-squash-history-and-one-merge-state-model.md)
    after recording its evidence there.

Rollback before step 9 is `restore-canopy` from the archive onto the volume and a
redeploy of the previous `main` (schema 17). After step 9 it also means restoring
`~/.arbor`.

## Verification

```sh
bun run test:migration packages/canopyd/migrations/016-squash-history
```

The test writes a long history with this build (snapshots, a traced source edit, a binary
file, a nested folder added and removed) and rewrites it into the schema-17 layout with
the legacy rows the deployed build retains: ids beside ordinals (one non-decimal),
reconciliation columns and stored transitions, merge-state records with `retention` and
one row without a record, whole-entry conflict rows (one copied forward to the head,
resolved), a retained trace, entry metadata's `update_id` and `data_json`, the version
foreign key, `access.claimed_profile`, profile rows in an older format, and an
AUTOINCREMENT sequence that ran ahead. It checks that:

- heads keep their ordinal, root, receipt columns and trees row; every other update, the
  legacy tables and the old merge states are gone; each head has one fresh merge state;
- entry dates, document versions (in rowid order), access, accounts and devices are
  unchanged; profile rows exist exactly for current person and group heads;
- the migrated schema equals the one this build creates; the run happens once;
- this build opens and serves the root: descriptors name the kept heads, conflict pages
  are empty, a new update takes the next ordinal with the head as its predecessor, a
  squashed base is not retained, and the full integrity audit passes;
- an open merge-state decision or an open legacy conflict row at a head, or a stamp other
  than 17, stops the run with nothing changed;
- the replay check re-accepts a window (including the traced edit) with every root and
  flag matching, leaves its source untouched, and reports a tampered flag as a mismatch.

## Rehearsal log

Not yet rehearsed.
