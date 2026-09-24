# canopyd 015: One merge-state model, then squash retained history

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** HIGH. The migration rewrites live history, and a mistake in the
  unification step changes conflict behavior on every ordinary tree.
- **State:** Stages 1 and 2 DONE in code, 2026-09-24, on
  `claude/canopyd-code-review-pvrk0p`; not deployed. Remaining: the rehearsal
  (replay check, migration on restored copies) and the live run, both in the
  [migration 016 runbook](../../packages/canopyd/migrations/016-squash-history/README.md).
  Delete this plan once 016 has run and its evidence is in `status.md`. Joe
  accepts losing accepted history to retire legacy storage, keeps
  `document_versions` and entry dates, and resolves open conflicts first.
- **Depends on:** the no-migration cleanup of the same review, which removed
  dead readers, the one-shot merge mode, the source-proposal request and other
  code that needed no data change. Migrations 013 to 015 must be out of their
  rollback window (backups from 2026-09-23 age out around 2026-10-07).

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

## Stage 1: every acceptance records a merge state (done in code)

Every path that inserts an accepted update now records a merge state, and
`AcceptedUpdateInput.mergeState` is required: ordinary and governed
snapshots go through `submitSemanticCandidate`; tree creation, pairing,
account-configuration creation and nested-boundary rewrites checkpoint their
root. Account-configuration policy conflicts are merge-state decisions, so
nothing writes `accepted_conflicts` and no conflict row is copied forward.
`reconcileEntryAmbiguity` and `updates/entry-ambiguity.ts` are gone. A snapshot
takes one worker job for its two checkpoints (`authored: true`), plus a tree
merge only when concurrent. Profile facts rows are written only for accepted
person and group roots, inside the accepting transaction. The behavior is in
the [merge tool](../../docs/architecture/canopyd/merge-tool.md#checkpoints-and-recorded-merge-states).

Not yet done: the rehearsal on a restored backup, replaying its last N
accepted updates through the new path and comparing roots and conflict flags.
`packages/canopyd/migrations/016-squash-history/replay-check.ts` does it; the
runbook runs it before the migration. Stage 1 deploys with stage 2.

Stage 2 must know:

- Legacy readers are marked `Legacy rows only; deleted by migration 016`.
  Once no row lacks a merge state, `ConflictStore` (and `entryValue`,
  `decisionDependencies`), `openDecisions`' fallback, the `conflictPage` and
  preflight fallbacks, the audit's conflict-row checks and the preflight's
  receipt replay branch all go.
- A snapshot now costs a checkpoint, which is linear in the tree's nodes
  (active-state load, store and host validation), like a traced edit: on a
  synthetic 1000-file tree a snapshot fast-forward went from about 90 ms to
  about 380 ms (`tests/performance/snapshot-acceptance-cost.ts`). An
  incremental checkpoint that path-copies the active state, as the traced fast
  path does for history, is the follow-up if folder sync of large trees
  matters.
- An unavailable worker now refuses every acceptance with a retryable 503,
  including tree creation, pairing and account claims.
- Old `profile:<root>` rows exist for every root ever validated, in older
  formats too; `storedProfileFacts` reads them all. Rebuild only current
  person and group heads.

## Stage 2: migration 016 squashes history (schema 18)

**Implemented (2026-09-24), not run.** As planned, with these choices:

- Each head keeps its old ordinal, so its wire id and cursor are unchanged and
  placements only resume. Its `previous` becomes `null`.
- `previous_ordinal` is a foreign key; the wire `previous.root` is joined from
  the predecessor.
- `document_versions.update_id` stays as opaque text without a foreign key;
  `entry_metadata` keeps only `modified_at`.
- The merge-state record drops `retention` but keeps `request` (after the
  squash it is the only stored copy of an authored candidate and trace) and
  the engine's `evidence`, whose input roots the tests read.
- The engine's checkpoint `path` branch was not legacy-only: stage 1's
  per-entry snapshot choices use it. It stays, with its errors reworded, and
  now also takes a folder path: stage 1 had turned every folder conflict into
  a whole-root choice, and the folder choice restores the pre-stage-1 scope
  and inspection shape (an `entry` decision with `directory` values at the
  folder's path). See the
  [merge tool](../../docs/architecture/canopyd/merge-tool.md#checkpoints-and-recorded-merge-states).
- `storedProfileFacts` reads only version-3 rows, since the migration rebuilt
  every row.

The plan as written:

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
- `profile:<root>` rows in `meta`. Rebuild them for current person and group
  profile heads only; the code already writes no others.

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
- migration directories 013, 014 and 015, replaced by 016 as the template;
- `updates/source-edits.ts`, moved to test support if the conformance run and
  `swift/scripts/conflict-lab.ts` still need it.

**Objects:** the squash leaves old objects unreferenced. Do not delete them in
016. Either prune in a later step behind a fresh full retention audit, or leave
them to [canopyd 001](001-pack-object-storage.md)'s packing, which then only
packs live data.

## Decisions for Joe before stage 2 (decided)

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
