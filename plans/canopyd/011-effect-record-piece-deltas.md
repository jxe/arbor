# canopyd 011: Effect records store piece deltas, not whole node copies

Status: PLANNED. Written 2026-09-22 from measurements on the 2026-09-19 Railway backup.
Independent of canopyd 010; both reduce what a checkpoint or retention walk reads.


## Context

Every `editSource` effect embeds full `before` and `after` `Node` copies for
each touched node, including the entire `pieces` array
(`intent-engine.ts:859`, `:1166-1189`). On a long-edited file that is two
copies of ~110 pieces per edit. Measured on the 2026-09-19 backup of
`/~joe/todos`: 639 effect records = 4,194 distinct chunks, 6.5 MB, p50 12
chunks per record, worst 53 KB JSON; effects are 75% of the state DAG.

Lazy history (Phase 4/5 of the operation-frames plan, on main) means the
normal edit path no longer reads these. They still cost on: eager loads
(`eager: true`, legacy/snapshot states, `validateIntentState` with
`validation` set at the authority boundary), retention walks
(`retention.ts:271-317` extract references from every record), and storage
growth, which is unbounded per file version.

The pieces in effect snapshots are load-bearing, so this is a format change:

1. `enforceDeletions` (`intent-engine.ts:1205-1244`) recomputes
   `pieceEdits(before.pieces, after.pieces)` and subtracts the removed piece
   ranges from every active node in the realm. Missing pieces are silently
   skipped (`:1210`), which would be a wrong merge, not an error.
2. Competing-move detection (`:1830-1845`) scans `effect.before[*].pieces`
   for overlap with a `moveSource` selection.
3. `intentDependencies` / `intentReferences` (`intent-model.ts:575-637`)
   add every piece `object` in before/after to the retained set, so those
   blobs stay alive.
4. Schemas are `.strict()` (`intent-model.ts:375`, `:450`); unknown fields
   reject the state.

## Design

Replace before/after pieces with a delta that answers exactly those readers:

```
Effect {
  …existing fields, before/after Node copies WITHOUT pieces…
  edits?: Record<nodeID, {
    removed: Piece[];          // pieces cut from before (origin/start/length/object)
    inserted: Piece[];         // pieces added in after
    range: [number, number];   // byte range in before, for the move-overlap test
  }[]>
}
```

- `enforceDeletions` iterates `edits[id]` and uses `removed` directly; the
  `pieceEdits` recomputation goes away. Semantically identical: today it
  derives exactly `slice(before.pieces, ...edit.range)` for deletion edits.
- Competing moves test `edits[id][*].removed` (a moveSource's before pieces
  that overlap the selection are precisely the moved ones).
- `intentDependencies` adds `removed[*].object` and `inserted[*].object`,
  plus `node.object` from the slimmed before/after. Retained set is a
  superset of what those readers need, and a subset of today's (pieces that
  were untouched by the edit are still referenced by the active node or by
  the effect that introduced them).
- Legacy records: keep reading `before.pieces`/`after.pieces` when `edits`
  is absent. Reader supports both forever; no migration of stored history.
  Writer emits the new shape only. Mark with the existing v3 state format;
  only the record schema gains an optional field.

Alternative rejected: hash-referencing the piece arrays. Makes
`enforceDeletions` and the move test async, and the retention walker would
have to follow the reference or lose blobs.

## Steps

1. `intent-model.ts`: `Effect.edits` type; zod schema with `edits` optional
   and before/after nodes allowing absent `pieces` (already optional).
2. `intent-engine.ts` apply (`:1166-1189`): compute `pieceEdits` once for
   each touched file node, fill `edits`, strip `pieces` from the stored
   `before`/`after` copies. Keep `before` cloning as is for now (`:859`, it
   is CPU only) or narrow it to touched nodes as a follow-on.
3. `enforceDeletions` and the competing-move check: read `edits`, fall back
   to recomputation from pieces when absent.
4. `intentDependencies` / `intentReferences`: include delta piece objects.
5. Retention (`retention.ts`) and `state-storage.ts` reference extraction go
   through `intentHistoryReferences`, so step 4 covers them; verify with a
   retention test that a legacy record and a new record retain the same
   blobs for the same edit.
6. Tests: `tests/unit/canopyd-merge/lazy-history.test.ts` differential
   (eager vs lazy vs fast) already covers deletion propagation over 90
   steps; add a mixed-vintage state (records written by the old shape, then
   new edits) and assert identical merges. Add a size assertion: effect
   record bytes stay flat as a file's piece count grows.
7. `tools/replay-update-cost.ts` on a data copy before and after.

## Risks

- Any consumer of `before[*].pieces` I did not list. Grep `.pieces` over
  `effect`/`e.before`/`e.after` once more before starting; the list above
  is from a read of intent-engine.ts, intent-model.ts, retention.ts,
  history-view.ts.
- `undone` effects: `enforceDeletions` skips them; the delta path must too.
- Effects for `moveSource`/`copySource` also write before/after with pieces;
  the move test needs `removed` for moves, so compute `edits` for all three
  source kinds, not just `editSource`.

## Verification
- `bun run test` (all differential lazy-history tests).
- Replay the todos tree on a backup copy: effects chunk count and bytes per
  new record, and identical accepted roots versus main.
