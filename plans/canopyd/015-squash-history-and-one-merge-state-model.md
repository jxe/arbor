# canopyd 015: One merge-state model, then squash retained history

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** HIGH. The migration rewrites live history, and a mistake in the
  unification step changes conflict behavior on every ordinary tree.
- **State:** PLANNED, 2026-09-24. Joe accepts losing accepted history to
  retire legacy storage.
- **Depends on:** the no-migration cleanup of the same review, which removed
  dead readers, the one-shot merge mode, the source-proposal request and other
  code that needed no data change. Migrations 013 to 015 must be out of their
  rollback window (backups from 2026-09-23 age out around 2026-10-07).
- **Conflicts with the merge boundary change (2026-09-24, [status](../../status.md#merge-boundary--2026-09-24)).**
  canopyd now accepts a verified plain edit on the head without the merge
  sidecar and without a merge state; the state is recorded later by replaying
  the edit's trace from `authored_changes`. That relies on `SourceIntentStore`,
  `validateSourceTrace` in `updates/source-edits.ts`, `SemanticMerge` replay
  and, for untraced gaps, `checkpoint-batch`, all of which stage 2 below
  deletes, and it adds rows without a merge state, which stage 1 forbids.
  Decide which model wins before starting this plan. Account-config merging
  also moved into canopyd (`account-policy-v2.ts`); `account-v2.ts` is gone.
  Check 016 took the next migration number, so this plan's migration is 017.

## Why

canopyd records conflicts in two ways, and that duplication keeps most of the
remaining legacy machinery alive:

- The semantic path (`submitSemanticCandidate`) writes a v3 merge state to
  `accepted_merge_states`.
- The snapshot path (`reconcileUpdate` plus `reconcileEntryAmbiguity`,
  roughly 270 lines in `canopy.ts`) writes whole-entry decisions to
  `accepted_conflicts`. So do account-config writes. Pairing and tree creation
  write no merge state at all.
- Because some rows have no merge state, `SemanticMerge.state()` replays them
  through `checkpoint-batch` and translates conflict rows with
  `legacyDecisions`. Together with the worker's batch protocol and the engine's
  legacy-decision branch, that is about 250 lines.
- `AcceptedUpdateStore.insertWithinTransaction` copies the prior conflict
  state forward into every later snapshot row, and `semantic.record` parses
  every copy on each accept that has decisions.

Squashing history alone would not delete any of this, because the snapshot
path keeps producing rows without a merge state. So there are two stages:
unify first (code only, no data change), then squash (a migration).

## Stage 1: every acceptance records a merge state (no migration)

1. Route ordinary snapshot candidates through `submitSemanticCandidate`, which
   already handles snapshots through checkpoints (`canopy.ts` ~1911-1976).
   Retire `reconcileUpdate`, `reconcileEntryAmbiguity` and
   `updates/entry-ambiguity.ts` for ordinary trees.
2. Record a merge state on every other path that inserts an accepted update:
   - tree creation (`canopy.ts` ~851);
   - pairing (~717);
   - account-config writes (~1131, ~2407, through `insertAcceptedUpdate`).

   Account-config policy conflicts either become merge-state decisions or stay
   the only writer of `accepted_conflicts`. Decide this after reading
   `account-policy-v2.ts`. The recommendation is to move them, so that
   `ConflictStore` only reads.
3. Stop copying conflict state forward. Write a conflict row only when
   decisions or resolutions change, and read "latest row at or before".
4. Collapse the snapshot-on-semantic-tree case from three worker round trips
   (a tree merge and then two `checkpoint` jobs) to one request.
5. Verification: the full canopyd suites, `self-sync`, the protocol
   conformance run, and a rehearsal on a restored backup. Replaying the
   rehearsal's last N accepted updates through the new path must produce
   byte-identical roots and equivalent decisions.

After stage 1, `checkpoint-batch` replay is reached only for rows written
before it. Stage 2 removes those rows.

## Stage 2: migration 017 squashes history (schema 18)

**Preconditions, checked by `run.ts`, which refuses to run otherwise:**

- No tree has unresolved decisions at its head. Resolve them in Canopy first.
  This avoids carrying live alternatives across the squash.
- All clients are quiesced (the standard procedure, steps 4 and 5).

**Per tree:**

- Keep the head root unchanged. Write one accepted update whose `ordinal`
  becomes the new id, with a fresh editable v3 merge state from `engine.initial`
  over the head root and no history effects.
- Head roots are unchanged, so clients only advance each placement to the new
  update id. Old status cursors resync, as they did after 015.

**Delete (data):**

- every accepted update except the new head rows;
- `authored_changes`;
- every `accepted_conflicts` row (none are unresolved, by the precondition);
- every `accepted_merge_states` row except the heads';
- `profile:<root>` rows in `meta`. Rebuild them for current profile heads
  only, and change the code to write them only for person and group roots.

**Drop (schema):**

- `accepted_updates`: `id` (the ordinal is the wire id), `previous_root`,
  `kind`, `remote_root`, `merge_summary`, `base_root`, `candidate_root` and
  `transition_json`. Watch replay derives transitions from two roots, as
  `netAcceptedTransition` already does, with a small LRU cache. `previous_id`
  becomes `previous_ordinal`.
- `access.claimed_profile` and `entry_metadata.data_json`.
- In the merge-state record: `retention` and the copies of `change_id`,
  `candidate_root` and the input roots.

**Delete (code), once no stored data needs it:**

- `SourceIntentStore` and `updates/source-intent-store.ts`, and the intent
  branch of `recordOrigins`;
- `SemanticMerge` replay and `legacyDecisions`; `checkpoint-batch` with its
  schemas, contract entry, 128 MiB/64-step budgeting and `checkpoint-batch-too-large`
  handling; the engine's checkpoint `input.path` "Legacy file decision" branch;
- the `effectEdits` whole-piece fallback, with `edits` made required. `apply`
  must then always write `edits: {}`;
- the `editable ?? false` defaulting;
- decision-ID reuse in `semantic.record` and `ConflictStore.forTree`;
- `retentionAudit`'s non-union mode;
- migration directories 013, 014 and 015, replaced by 017 as the template;
- `updates/source-edits.ts`, moved to test support if the conformance run and
  `swift/scripts/conflict-lab.ts` still need it.

**Objects:** the squash leaves old objects unreferenced. Do not delete them in
017. Either prune in a later step behind a fresh full retention audit, or leave
them to [canopyd 001](001-pack-object-storage.md)'s packing, which then only
packs live data.

## Decisions for Joe before stage 2

1. **Document versions and entry dates.** `document_versions` feeds
   [canopyd 007](007-document-history-routes-and-restore.md) (P1) and
   [006](006-line-provenance.md). `entry_metadata` feeds the date pages on Mac
   and iOS. Neither needs accepted history to be read; each needs only content
   hashes and times. Recommendation: keep both. Replace `update_id` with the
   `accepted_at` it points to (entry metadata) or an opaque value (versions),
   and keep the version content objects retained. Squashing these would reset
   every date to the migration time and empty History before it ships.
2. **Idempotency across the squash.** `request_digest` and `change_id` guard
   retries. Deleting old rows allows a client's pre-squash retry to be accepted
   again. Quiescing and re-placing covers Joe's own clients. Confirm that no
   other client exists.

## Verification

- Follow the [migration procedure](../../packages/canopyd/migrations/README.md)
  in full: backup, rehearsal on two restored copies, `compare-canopy-roots`
  (head roots identical), `verify.ts`, and a round-trip edit.
- Run a full `/.arbor/integrity` audit on the migrated rehearsal copy, once.
- Mac and iPhone re-place, or advance without re-placing. The
  authored-manifest diff is empty.
- `status.md` records schema 18 and the history cut date. The
  "No accepted-history listing" and "Storage is unbounded" gaps are updated to
  match.
