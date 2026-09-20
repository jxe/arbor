# canopyd 010: Operations as evidence frames; history loaded lazily

Status: PLANNED (approved 2026-09-19, not started). Sole user; wire changes are clean
breaks, but Phase 2 ships Mac, iPhone and server together. Related:
[canopyd 001](001-pack-object-storage.md) (retained roots stay retained; nothing here prunes),
[canopyd 006](006-line-provenance.md) / [007](007-canopy-document-history.md) (archival
states remain their retained roots), [Native 008](../canopy-swift/008-complete-native-move-copy-undo-capture.md)
(client capture that Phase 3 replaces), and the measurements in
the deleted performance log (git history: `docs/canopy-update-performance.md`; its surviving facts are at the end of this plan).

## Context

Today an update's `operations` are mandatory semantic intent: they must reproduce
the candidate, the server retains every operation's effects, origins and change
envelope forever, and merges consult that whole history. Three costs follow:

- **Client fragility.** Debounce coalesces generations into one patch, and the
  editor must re-derive lineage and copies across generations by range
  composition. When the reconstruction differs it fails closed
  ("Captured editor intent changed"), which Joe hit today.
- **Server cost.** History maps grow without bound; the retention walk follows
  every change envelope back to genesis, so cold validation read 406 MB and the
  full evaluator loads ~11.5 MB of history per edit even for a one-line change.
- **Coupling.** Old operation bodies are load-bearing for only three things:
  `enforceDeletions` re-applies every historical deletion, `origins` give move
  provenance, and `undoOperation` targets. Native no longer emits undo (today's
  change), so the remaining two can be scoped.

Intended outcome: operations are optional, validated evidence carried as a chain
of frames; exact bytes (the object delta already sent) stay authoritative;
clients coalesce by concatenating frames. On the server, history is kept intact
but no longer loaded or scanned whole: the full evaluator reads only the history
pages an edit touches, deletion enforcement stops at a per-state watermark, and
validation proofs are weighed by touched pages. Collapsing old history into a
checkpoint was considered and deferred: its warm win is modest (roughly 200 ms
to 120 ms per edit), its cold win is already hidden by startup warm-up, and it
cannot advance past a live decision, which is exactly the tree that runs the
full evaluator on every edit.

Overstory changes are clean breaks (sole user), but Mac, iPhone and server must ship
together for Phase 2.

## Decisions

- **D1 Frames are tree-root to tree-root.** `Frame = {before: root, after: root, operations}`.
  Roots let entry operations and cross-document copies live inside frames and give
  two free invariants: `trace[0].before == base root`, `trace[last].after == candidate`.
  The client already computes each generation's root (`replace(graph.root, 0)` in
  `SourceAdmissionQueue.swift`). No source table: intermediate bytes are
  reproduced by applying frames.
- **D2 Refs are frame-local.** A basis ref in frame n names an object in frame n's
  `before` tree; an operation ref names any earlier key in the same change. This
  is what makes concatenation trivial.
- **D3 "Hints" means optional, never unchecked.** Absent trace = snapshot
  semantics (today's `operations: null`). Present trace: every frame must
  reproduce its `after` or the update is rejected. Keep spec/10's substance,
  reword :82 and :100.
- **D4 History is never deleted by this plan.** Old records stay; the engine
  stops reading what an edit does not touch. Identity checks keep using the full
  `changes` map, so nothing about change or operation identity changes.
- **D5 Deletion watermark.** Each recorded state carries `deletionsThrough`, the
  set of history buckets (or the change ordinal) whose `editSource` deletions
  have been applied to its active material; `enforceDeletions` scans only effects
  newer than the watermark. This generalizes what `editable` asserts today.
- **D6 Lazy history maps.** The full evaluator loads the v3 radix maps by
  bucket on demand instead of materializing all five maps; `evolved()`,
  `edits()`, `contributions()` and the write-back path read through the same
  lazy view. Retention and audits are unchanged.
- **D7 Proof weight counts touched pages**, not the whole dependency set, so
  proofs fit the cache and validation stays warm.
- **Deferred: collapse into a checkpoint state plus identity ledger.** Only if
  history size itself becomes the problem (storage, audit time, backup size).
  Its blocker is live decisions pinning older states; recursive collapse across
  decisions would be required and is the riskiest piece. Old accepted merge
  states remain retained roots for the history and blame plans either way.

## Findings that change the brief

- `reconcileSourceEdits` (`packages/canopyd/src/updates/source-reconciliation.ts`)
  has no production caller; `canopy.ts:1539` sets `history = null` and uses
  `reconcileUpdate`. `SourceIntentStore.insert` still writes rows. Bounding "replay"
  is a storage-shape change plus a test rewrite, not a live-path change.
- `undoOperation` can leave the grammar now; Native stopped producing it today.

## Phases

### Phase 0 — Baseline
- `packages/canopyd/src/host.ts` update log line: add `body-bytes`, later
  `trace-frames`, `trace-ops`. The record already has `history-*`, `proof-*`,
  `read-*`, `preflight-state`, `retention`, `w-load`.
- `tests/performance/merge-history.bench.ts`: per checkpoint record history map
  entry counts per field, `loadIntentState` bytes, cold `validateIntentState` time.
- Record numbers in `docs/canopy-update-performance.md` for a 256-edit synthetic
  tree and the live tree.

### Phase 1 — Engine understands frames (server-only, deployable alone)
- `packages/canopyd-merge/src/intent-model.ts`: `Frame`; `IntentRequest.incoming.trace`
  replaces `operations`; `parseIntentRequest` adapter wraps a legacy `operations`
  array as one frame `{before: base.object, after: incoming.object, operations}`;
  validate chain, cross-frame key uniqueness; remove `undoOperation` from the
  accepted kinds (:124-140).
- `packages/canopyd-merge/src/intent-engine.ts`: `run()` loops frames; after each frame
  `project(authored) === frame.after` else fail "Frame does not reproduce its
  result". Sites that iterate `incoming.operations` (:1724-1731, :1741-1775,
  :2287, evidence) use the flattened ops in order. Remove `Engine.apply`'s undo
  branch (:781-867). `editFastForward` (:2531-2560) accepts all-basis lineage-free
  `editSource` frames applied sequentially with `trustedProjection` per frame.
  `Effect.authored.basis` = the frame's `before`.
- `packages/canopyd/src/updates/source-edits.ts`: `validateSourceTrace(frames, load)`
  runs `validateSourceEditCandidate` per frame feeding generated objects forward;
  `composeFrames` for the disjoint rule (exact intermediate bytes make it
  deterministic; unsupported for lineage/copies that cannot rebase).
- Tests: extend `tests/unit/canopyd-merge/intent.test.ts` (two-frame trace equals
  composed one-frame trace in `result.object` and decisions; wrong `after` →
  invalid; cross-frame op ref works; undo → unsupported);
  `tests/unit/canopyd-merge/incremental.test.ts` multi-frame fast path with
  `engineDiagnostics.path === 1`; `tests/unit/canopyd/source-edits.test.ts` chain
  and key rules.
- Gate: merge and canopy suites green with the deployed wire unchanged.

### Phase 2 — Overstory clean break: `trace` replaces `operations` (ship all three together)
- `packages/protocol/src/updates/authored-contract.ts`: `AuthoredUpdateIntent
  {change, candidate, trace: Frame[] | null, resolves, ifCurrent}`; drop
  `undoOperation` (:18, :86); `decodeAuthoredCandidateIntent` validates chain,
  cross-frame uniqueness, `trace.length <= 64`, total ops `<= 1024`, frames must
  have `operations.length > 0`. `intent.ts`: canonical field `trace`; bump
  `domain` to `arbor-update/2` so old receipts cannot collide. `types.ts:75`
  follows.
- Swift mirror: `canopy-swift/Packages/Overstory/.../WireAuthoredContract.swift`
  (:117, :137-150), `WireModels.swift:489-524` `WireCandidateUpdate.trace`.
- canopyd: `canopy.ts:1186, 1198, 1233, 1304` `operations !== null` → `trace !== null`;
  `merge-state-store.ts` request shape; `source-intent-store.ts` `operations_json`
  → `trace_json` with a migration that wraps existing rows in one frame
  (`tests/unit/canopyd/schema-migration.test.ts`); `merge-tool.ts` `"trace" in
  request.incoming`.
- Clients: `packages/client/src/source-admission-queue.ts:144-160` and
  `canopy-swift/.../SourceAdmissionQueue.swift:132-174` emit one frame per record;
  journal schema 4 converts stored `update.operations`. `request(through:)` unchanged.
- Conformance: regenerate `protocol-authored-updates.json`, `protocol-update-intent.json`,
  `protocol-authored-transport.json`, `source-admission-queue.json`,
  `client-state-machines.json`; `tests/unit/protocol-updates/*` digest tests must show any
  frame's `before`, `after` or ops changes the digest.
- Gate: TS and Swift conformance green; a live Mac → server → iPhone round trip
  logs `trace-frames: 1`.

### Phase 3 — Client coalescing: one frame per generation
- `canopy-swift/Packages/CanopyAppKit/.../DocumentAdmissionMachine.swift`: keep the list
  of generations since the last admission (each with its captured patch,
  lineage, copies and source hash) instead of only the latest.
- `canopy-swift/Packages/CanopyEditor/.../ArborDocumentBinding.swift:510-548`:
  `persist` builds one frame per generation against the previous generation's
  ledger and hands the list to the queue. Delete the "captured intent mismatch"
  fail-closed branch and the exact-source fallback.
- Queues (Swift and TS): `prepare` accepts a generation list, emits a frame each;
  `compactTrace` merges adjacent frames whose ops are all lineage-free
  `editSource`, with vectors shared with the server's `composeFrames` in
  `source-admission-queue.json`. Editor recovery appends generations as frames.
- Tests: `LiveEditorAdmissionTests` coalesced Markdown normalization case now
  yields a two-frame trace with lineage in frame two and is accepted;
  `SourcePreservationTests`, `SourceAdmissionQueueTests` multi-frame records,
  schema 4 migration, compaction equivalence; frame vectors in
  `source-preservation.json`, `source-copy.json`, `cross-document-copy.json`.
- Measure `trace-frames`, `trace-ops`, `body-bytes`; expect two hashes per frame
  bounded by the 250 ms debounce.

### Phase 3b — Migration 013: compact merge evidence and old states (server-only, before Phase 4)
Measured on the live database after 012: 150 MB of SQLite, of which
`evidence.inputs` is ~100 MB (every object the evaluator happened to read;
nothing reads it back and it is not sent over the protocol) and the legacy
`dependencies` closure is ~44 MB (the oldest ~130 of ~640 merge rows; newer rows
use the two-root `retention` form, and the only reader is an audit that
recomputes the closure from those roots). Objects hold 319 MB of old merge
states in the pre-chunked format (~2.1–2.6 MB each across ~1,108 files) that
current states still reference through their change envelopes.

- Schema 14 → 15, `packages/canopyd/migrations/013-compact-merge-evidence/` set up like 012
  (offline `run.ts`, README, `migrate.test.ts`), rehearsed on the local copy
  first, live only with Joe's go-ahead. No wire change; server deploys alone.
- Merge records: `evidence.inputs` becomes the three input roots (base,
  current, incoming objects); the evaluator is deterministic, so reproducibility
  (spec/10 :190–198) holds through re-reading. Convert legacy `dependencies` rows
  to `retention: {version: 1, roots}` after checking each against the existing
  audit (`canopy.ts` `verifyIntegrity` legacy branch), then drop the field.
- Old merge states: rewrite the full-copy states into the chunked v3 format.
  This changes their content hashes, so every reference must move together:
  `accepted_merge_states.state`/`authored`, `retention.roots`, change envelopes
  that name a rewritten `base.state`, and decision `context`/alternative
  `state` values. Tree roots and file objects are untouched. Verify with the
  full retention audit before and after; keep the old objects until the audit
  passes, then VACUUM.
- Cleanup: remove leftover `merge-jobs` directories; canopyd clears stale ones
  at startup.
- Gate: audit passes on the migrated copy; sizes recorded in
  `docs/canopy-update-performance.md` (target: SQLite under 10 MB, objects
  about 95 MB); a Mac and an iPhone edit succeed against the migrated copy.
- Why before Phase 4: lazy loading changes what the evaluator reads, which
  would silently change what `evidence.inputs` meant.

### Phase 4 — Lazy history and the deletion watermark (server-only)
- `packages/canopyd-merge/src/state-storage.ts` / `state-map.ts`: a `LazyStateMap` view
  over a v3 map root exposing `get(key)`, `has(key)`, `entries(prefix?)` and
  `touched()` (the bucket hashes read), backed by `getStateMap` and the existing
  `StateMapValidationCache`. `loadIntentState` gains a `lazy` mode that returns
  active material plus lazy maps; `loadEditableIntentState` already does this
  for the fast path and can share the view.
- `packages/canopyd-merge/src/intent-model.ts`: `IntentState.deletionsThrough` (bucket
  set or change ordinal); `storeIntentState` records it; `parseIntentState`
  accepts it; `intentReferences` unchanged.
- `packages/canopyd-merge/src/intent-engine.ts`: the full evaluator's `run()` loads
  base and current lazily; `enforceDeletions` (:1231-1271) iterates only effects
  newer than `deletionsThrough` and then advances the watermark on the result;
  `evolved()` (:559-604), `edits()` (:1222-1230), `contributions()`
  (:1444-1461), the history write-back (:2265-2274) and `checkpointIntent` read
  through the lazy view; `record()` writes only touched buckets (path copies
  already do this). `editFastForward` sets the watermark on its output.
- `packages/canopyd/src/merge-tool.ts` proof weight (`bytes` in `validate`):
  count `touched()` pages instead of every dependency, and keep the dependency
  set only for the retention check.
- Differential suite `tests/unit/canopyd-merge/lazy-history.test.ts` (pattern from
  `incremental.test.ts:80-153`): a 60-step history mixing appends, deletes,
  `moveSource`, `copySource`, lineage edits and two checkpoint barriers; for each
  scenario assert `result.object`, decisions and `evidence.operations` equal
  between eager and lazy loading: fast-path head edit; divergent edit based at
  step 32 merged into head; move and copy of old text; concurrent inserts at one
  anchor; deletion of old text on one branch vs an edit inside it on the other
  (the watermark case); resolution of a live decision. Assert
  `touched().size` is bounded by edited paths, not history length.
- `tests/performance/merge-history.bench.ts`: report bytes loaded per edit and
  full-evaluator time with a live decision present, eager vs lazy; expect the
  11.5 MB load to fall to the touched pages.
- Gate: differential suite green; bench shows load proportional to the edit.

### Phase 5 — canopyd adoption and measurement
- `packages/canopyd/src/merge-tool.ts` and `updates/semantic-merge.ts`: request
  lazy loads for authority validation and worker inputs; keep `verifyRetention`
  as is.
- Watch the live update log (`w-load`, `w-read-bytes`, `history-mb`,
  `proof-bytes-last`, `worker-validate-state`, `retention`) and the startup
  `warm` line before and after; record in `docs/canopy-update-performance.md`.
  Expect the conflict-tree case (`w-path: 0`) to drop from about 1 s to well
  under 200 ms on Railway.
- Gate: 20 live edits on a tree with a live decision show the same outcomes and
  the reduced phases.

### Phase 6 — Spec and docs, written ahead of each phase (plans/canopyd/009 :28-30)
- spec/10: :82 "each frame MUST reproduce its `after`"; :100 reworded per D3;
  new Trace section. spec/01: :744 digest covers `trace`. spec/09:
  per-generation capture and coalescing.
- docs/merge-operation-evaluation.md frames, lazy loading and the deletion
  watermark; docs/update-protocol.md; docs/canopy-update-performance.md
  numbers. No retention or spec promise is relaxed by this plan.

## Risks and stop conditions
- Any eager-vs-lazy differential mismatch without a documented cause: stop.
- The watermark must be set only by evaluations that actually ran
  `enforceDeletions` over everything up to it; a state imported from a snapshot
  carries no watermark and takes the full scan once, as `editable: false` does today.
- Fast-path decline rate must not rise after Phases 2–3; watch `w-decline`
  counts in the update log.
- Phase 2 needs all three deployables in one go; keep the previous build installable.
- If lazy loading leaves the conflict-tree case above 200 ms on Railway, the
  next lever is the deferred collapse, not more caching.

## Verification
- Per phase: `bun run typecheck`, `bun run test`, `bun run test:protocol`,
  `swift test --package-path canopy-swift/Packages/CanopyWorkingTree`,
  `canopy-swift/scripts/test-canopy-editor-local.sh`, both app builds.
- Live: the canopyd update log line (`trace-frames`, `body-bytes`, `w-path`,
  `history-mb`, `retention`) and Native's network log (`out=` bytes, `note`
  rows) before and after each deployed phase; `docs/canopy-update-performance.md`
  records them.

## Retained facts from the deleted checkpoints

- Migration 013 compacted `evidence.inputs` to the three input roots (base,
  current, incoming). The rule is deterministic, so those roots reproduce every
  object it read; Phase 4 must not reintroduce a retained read set.
- The retired causal-undo journal is why undo is an ordinary edit: on the Mac
  it reached 432 records and 75 MB, and every admission re-encoded and fsynced
  all of it, 7.2 s per edit against a host that answered in about 250 ms.
  `spec/conformance/causal-undo.json` was deleted with it;
  `page-conversion-undo.json` remains.
- The old 100,000-object / 1 GB per-tree quota checks were removed from update
  acceptance; nothing bounds retained storage today, and periodic storage
  accounting or fsck is deferred to this plan's measurement phase.
- The host latency target is under 100 ms of server processing for a small
  fast-forward including validation and durable acceptance. Divergent-merge
  and live latency are not established; cold startup is about 5 s and the
  first edit after a restart is measured in seconds unless warm-up ran.
