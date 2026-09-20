# Migration 013: compact merge evidence and old merge states (14 → 15)

Carries [canopyd 010](../../plans/canopy/010-operation-frames-and-lazy-history.md)
Phase 3b. Server-only: no wire field changes, so Native is unaffected and the
server deploys alone. It must land before Phase 4, because lazy history changes
what the evaluator reads, and that would silently change what the old
`evidence.inputs` meant.

Three things change, all inside `accepted_merge_states.record_json` and the
object store:

1. **Evidence.** `evidence.inputs` was every object the evaluator happened to
   read (~100 MB of the 150 MB database; nothing reads it back and it is never
   sent over the protocol). It becomes the three evaluated tree roots,
   `{ base, current, incoming }`, taken from the row's `accepted_updates`
   columns (`base_root`, `previous_root`, `candidate_root`). The migration
   refuses a row whose old read set does not list all three. The rule is
   deterministic, so the roots reproduce the read set; spec/10's
   reproducibility promise holds by re-reading. New rows are written in this
   form by the engine (`IntentResponse.evidence.inputs`).
2. **Retention.** The oldest ~130 rows carried a flattened `dependencies`
   closure (~44 MB). Each is checked one last time against the retention audit
   (the same check `verifyIntegrity` used to run for that branch) and becomes
   `retention: { version: 1, roots: [state, authored] }`. The field and the
   legacy audit branch are gone from `MergeStateRecord` and `verifyIntegrity`.
3. **Old merge states.** The ~133 states stored in the pre-chunked full-copy
   format (`arbor-merge-intent-state`, ~2.4 MB each, ~319 MB) are rewritten
   into the indexed v3 format. Content hashes change, so every reference moves
   with them: the row's `state`/`authored` and `retention.roots`, decision
   `context` and alternative `state` values inside states, and change envelopes
   whose `base.state` names a rewritten state. A rewritten envelope changes
   hash too, so the v3 states holding it are path-copied in turn (only their
   active part and the touched `changes` buckets move; untouched history
   buckets keep their hashes). The cascade runs oldest row first through a
   rewrite map. Tree roots, `accepted_updates`, file and directory objects,
   receipts and conflicts are untouched; every tree's current root is listed
   in the report for `verify.ts` and is identical before and after.

It also removes leftover `merge-jobs`/`merge-workers` directories; canopyd now
clears stale ones at startup (`MergeTool.clearStaleJobs`).

## Row classes and the cascade

| Row class | Count (live) | State format | What moves |
| --- | --- | --- | --- |
| legacy (`dependencies`) | 130 | full-copy | evidence, retention form, state rewritten to v3, references |
| compact (`retention`) | 510 | v3 | evidence; state path-copied when an envelope or decision names a rewritten state |

Every row class is rewritten. No class had to be left as is: the cascade is
safe because a state only ever references older states (through its envelopes
and decisions), so oldest-first processing with a memoized map terminates, and
the full retention audit over the new roots is run before the transaction
commits and before any old object is deleted.

Superseded objects are exactly the objects the rewrite read that are neither in
the post-migration retention closure, nor reachable from any tree root or
conflict alternative, nor written by this run. They are deleted after the
transaction, then `VACUUM`.

One consequence: a change envelope's bytes no longer equal
`changeIdentity(request)` for the request that produced it, because that
identity embedded the old `base.state`. The only reader compares a *new*
request's identity against the envelope stored under the same change id, so a
client retrying an already-accepted change whose base state was rewritten
would see "Change identity reused with different intent" and derive a fresh
change, exactly as after 012. No client holds such an in-flight change across
this cutover when writers are quiesced.

## Offline run

After the archive backup and with writers quiesced:

```sh
bun migrations/013-compact-merge-evidence/run.ts /data | tee live-report.json
```

Progress goes to stderr as JSON events; the report is the single JSON line on
stdout. Order inside the tool: stamp and `quick_check` → full audit of the
schema-14 data → write new objects → audit the new roots → one transaction
(rows + stamp 15) → delete superseded objects → remove job directories →
`VACUUM`. A crash before the transaction leaves a schema-14 root plus some
unreferenced new objects; rerunning completes it. A crash after it leaves
superseded objects behind; a rerun reports `migrated: false`.

## Verification

```sh
bun run test:migration migrations/013-compact-merge-evidence
```

Then serve the migrated copy with the new build and confirm it opens and warms
(the startup `warm` line), and `verify.ts` against the report.

## Rehearsal log

2026-09-19, local copy of the post-012 data (`~/arbor-012-frames-20260919/migrated`,
schema 14, 640 merge rows, 5 trees, 1,620 accepted updates) copied to
`~/arbor-013-compact-20260919/{before,migrated}`:

- Rows: 130 legacy + 510 compact. Every legacy closure matched the audit; every
  row's read set listed its three roots.
- Rewrite: 1,652 states rewritten (0 kept: the cascade reaches every state, since
  each envelope names its base state), 1,614 envelopes rewritten, 18,023 objects
  written, 6,759 superseded objects deleted.
- Audit before: 1,521 tree roots / 3,546 tree objects reachable; retained closure
  24,056 objects. After: identical tree figures; retained closure 34,017 objects
  (v3 states are more, smaller chunks), 640 compact rows, 0 legacy.
- Sizes: SQLite 149,876,736 → 6,189,056 bytes; objects 413,456,469 → 106,666,927
  bytes (34,109 files).
- Timing on the Mac: audit-before 62.6 s, rewrite 65.5 s, audit-after 70.0 s,
  commit 0.2 s, delete 0.9 s, VACUUM 0.06 s; 200 s total.
- Rerun reported `migrated: false`; `compare-canopy-roots` showed all five tree
  roots unchanged; the new `canopyd` opened the schema-15 copy, warmed
  (`warm` 21,061 reads, 1.7 s), health `ok`, `verify.ts --no-sync` ok.
- No `merge-jobs` directory existed on the copy (`jobs: []`).

Native clients were not exercised offline; a Mac and an iPhone edit are checked
against the live server after cutover, as for 012.
