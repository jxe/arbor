# Completed reliability plans

| Historical plan | Outcome | Completed |
|---|---|---|
| [001](001-link-healing.md) | Heal moved inline and full-row links for every valid PageID | 2026-09-07 |
| [005](005-client-synchronization-state-machines.md) | Standardize the Arbor Sync admission and direct Canopy synchronization state machines in TypeScript and Swift | 2026-09-08 |
| [007](007-reify-composable-canopy-conflicts.md) | Stabilize accepted-conflict metadata and the optional Wire extension boundary | 2026-09-13 |

Completed reliability plans retain their original identifiers here. Active
reliability work remains indexed in [`plans/README.md`](../../README.md).

## September 18 plan reconciliation

- [003](003-untracked-collection-file-transactions.md) — superseded: its
  `FilesystemService` target was removed. Future non-tree editing belongs to Native 024.
- [004](004-contextual-canopy-conflict-resolution.md) — superseded: accepted-conflict
  review, contextual mapping and crash-safety scenarios belong to active Reliability 010.
- [012](012-native-sync-progress.md) — implemented with coordinator regression evidence;
  installation/publication/restart evidence is in the native source cutover. Extended
  merge/reconnect observation remains in [release verification](../../verification/release-and-soak.md).
- [013](013-merge-operations-and-formats.md) — completed merge-operation/language
  implementation, integrated into the deployed schema-12 authority.

Archival is not a claim that transferred manual gates have passed. See each dated
archive note and its linked checkpoint; the original executor text remains historical.
