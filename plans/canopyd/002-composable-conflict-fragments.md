# canopyd 002: Reassess remaining conflict-fragment storage gaps

Historical identifier: **canopyd storage 002**. The filename number is preserved; this plan now belongs to canopy.

Status: DEFERRED / NEEDS REASSESSMENT. No production backend replacement is scheduled.
The old prerequisite of adding fine-grained state to a schema-11-only authority is obsolete:
[schema 12](../../migrations/README.md#schema-history) now retains merge semantic states and their
complete immutable dependencies. Independent source choices, fragment reads and guarded range
resolution are implemented; their rollout is tracked in [release and verification](../verification/release-and-soak.md).

## Existing evidence

The isolated fragment storage proof (removed from the tree; see git history before 2026-09-20
for the since-deleted `experimental/conflict-fragments` module) was representation evidence only.
The production merge authority now owns accepted/authored semantic state,
hidden and undo material, and public inspection identities. Do not import the experiment's parallel
authority, receipt API or owner table, or repeat the completed schema-12 migration.

## Trigger before writing another implementation plan

Reconcile the original experiment's cases with current merge/authority tests: independent choices,
hidden and length-changing edits, ancestor replacement/deletion, partial resolution, snapshot
continuation, restart, exact retry and transaction faults. Identify a concrete unsupported case or
measured representation cost before proposing a storage change. User deferral is not automatically
revoked because the former client prerequisites have landed.

- If the gap is transfer or format policy, use [canopyd 009](009-canopy-provenance-merges.md).
- If it is client capture or review, use Native [008](../canopy-swift/008-complete-native-move-copy-undo-capture.md)
  or Native [010](../canopy-swift/010-client-conflict-review.md).
- If it is retention, packing or garbage collection, use [Storage 001](001-pack-object-storage.md),
  preserving semantic roots, transitive hidden/undo material and staged transaction inputs/results.
- Keep a task here only for a demonstrated production representation gap those owners cannot cover.

Any such change must preserve exact accepted history, source identity distinct from content hashes,
TreeID boundaries, authorized inspection, guarded resolution and baseline snapshot clients. A new
storage encoding needs restored-copy migration/rollback evidence and fault tests; a public contract
change needs paired TS/Swift models, fixtures and documentation. Do not add identity downloads,
review caches or a capability handshake to ordinary editing.
