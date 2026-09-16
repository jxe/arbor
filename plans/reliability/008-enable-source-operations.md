# Reliability 008: Enable source operations incrementally

Status: IN PROGRESS after the foundational cutover. Priority: P1. Work on main per Joe. This plan owns operation execution and editor emission; [009](009-canopy-provenance-merges.md) owns merge intelligence, and [010](010-client-conflict-review.md) owns review UX.

Historical experiment evidence remains on `codex/source-intent-experiment`, through
`b76870b` for the source-edit engine and `e5fd139` for the later contract work.
Inspect that branch's `docs/source-edit-experiment.md` before promoting engine code.
The engine, editor harness and experiment-only fixtures are not part of this main
checkout. Target semantic models here do not implement execution.

## Outcome and boundaries

Enable each operation in [the source-intent contract](../../spec/10-source-intent.md) only when Canopy can validate, execute, reconcile, and persist it safely and clients can emit it durably. Current clients send `operations: null`; source-built Canopy accepts the [exact-basis subset](../../docs/exact-source-execution.md), while deployed Canopy still rejects operation-bearing batches. Preserve that fail-closed behavior for every operation not yet enabled. No API version fork, silent snapshot fallback, or residual field.

Inspect `git status`, `status.md`, the Wire operations/JSON/intent modules, Canopy's update/store path, `packages/canopy-client/src/sync-state.ts`, Swift `WireOperations.swift`, `WireModels.swift`, and `ArborWorkingTree/UpdateCoordinator.swift` before implementing. Recheck Quagmire ownership and the exact-source ledger before editor changes; follow repository local-workspace and release-pin instructions.

## 1. Build the smallest execution foundation

The [exact-basis executor and candidate validator](../../docs/exact-source-execution.md)
and atomic evidence storage are implemented and tested. Schema 10 migration 008
preserves history and provenance from schema 8 or 9 in disposable tests; live
rehearsal remains. Public
acceptance now executes the exact-basis subset and atomically stores evidence,
including equal-byte edits. Disjoint concurrent edits from one accepted basis now merge using retained
contributions and explicit rule evidence. Cross-basis correspondence, snapshot
attribution beyond the implemented [whole-entry choices](../../docs/accepted-entry-conflicts.md), range-level ambiguity, and validation of the emitted subset remain before client emission.

- Implement exact basis resolution for accepted updates and preceding submitted candidates. Check object reachability, file hashes, UTF-8 boundaries, TreeID scope, authorization, and immutable origin bindings. Resolve output references in causal order; reject forward references, cycles, retired origins, and contradictory reused change identities.
- Persist admitted operation records, origin bindings, derivation, and any unresolved state atomically with accepted update/ref/observation. Include provenance-only transitions even when the projected root is unchanged. Supply a bounded retention and resynchronization policy before exposing retained outputs.
- Interpret a complete operation array against its exact basis and compare its resulting graph to `candidate`, byte for byte. Reject unexplained changes and false lineage. Do not use a matching root as proof that the operations are redundant.
- Keep snapshot-only acceptance working. Snapshot correspondence may be conservative; it must never invent explicit resolution or undo.
- Preflight the whole batch against the enabled operation set before applying a prefix. Supported-operation conflicts keep the existing sequential completed/failed/suffix contract.

Acceptance: fixtures for malformed and stale references, cross-tree references, unauthorized historical objects, candidate mismatch, false lineage, duplicate origins, restart/replay, metadata-only CAS, and rollback after injected failures. Old accepted history must remain readable after a rehearsed offline storage migration.

## 2. Enable in useful slices

Follow [011](011-compatible-accepted-ambiguity.md)'s single foundational cutover.
For each row, implement, deploy and verify server acceptance support first, then
release client emission of the supported input forms. Keep baseline snapshot clients
working throughout. Record the server prerequisite and verified destinations with
the release evidence; no runtime support advertisement is needed. Update `status.md`
with the exact supported subset. No per-operation coordinated release is required.

| Slice | Operations | Required discriminating cases |
| --- | --- | --- |
| Exact source edits | `editSource` | insert/delete/replace; emoji and combining marks; untouched Markdown fidelity; verified retained spans; zero-width anchors; edits ending at old base bytes |
| Entry changes | `moveEntry`, `copyEntry`, `removeEntry`, `replaceEntry` | rename plus concurrent content edit; directory descendants; destination collision; removal versus unseen child; nested tree boundaries |
| Source relocation | `moveSource`, `copySource` | paragraph/list reorder plus peer edit; duplicate identical paragraphs; copy followed by independent edits to source and copy; cross-file movement |
| Explicit alternatives | ordinary operations targeting alternative material plus `resolves` declarations | edit hidden alternative; preserve unresolved state at equal bytes; stale state/alternative-set guard; independent conflicts; reviewed result plus unattempted suffix |
| Causal undo | `undoOperation` | undo move after content edit; undo copy without deleting source; undo deletion with intervening insert; overlapping later edit retained for review |

The explicit-alternative slice depends on 009's accepted-conflict storage and inspection foundation. Whole-entry replacement/removal uses the common operation and resolution contract. Implement the specified non-text inspection and verify format constraints before enabling its review UI.

## 3. Preserve editor intent before sending

- Capture authored transactions before serialization loses move/copy/undo distinctions. Map Quagmire positions to exact UTF-8 source using its ledger; editor-local identities do not cross Wire. Implement the same source contract for any second maintained editor rather than a speculative adapter.
- Generate change/operation identities while preparing the durable generation. Coalesce unsent edits with compositional lineage, then freeze the submitted prefix. Undo/redo must retain causal references across coalescing; where evidence is incomplete, prepare a separate snapshot element.
- Carry the full candidate and operations through editor admission, working-tree persistence, bootstrap adoption, retry, longer prefixes, and suffix replay. A transport delta is never an authored operation. Preserve unsupported requests and provide a visible upgrade reason.
- Enable one editor operation at a time after the corresponding server tests pass. Do not turn plain external-file observations into confident editor intent.

## Verification and completion

Add paired examples that have identical snapshots but different move/copy/undo intent; assert different origins and the appropriate merge result. Run focused TS/Swift conformance plus editor ledger/coordinator tests during each slice, then the relevant `DEVELOPMENT.md` gates. Exercise crash points before admission, after durable preparation, after acceptance, and before materialization. Test coordinated Arbor/Quagmire changes locally before publishing a release. Archive this plan only after every supported slice is documented and verified; record implementation subsets in status and remaining specification gaps explicitly.
