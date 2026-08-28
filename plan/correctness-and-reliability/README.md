# Correctness and reliability work

These plans address behavior that becomes wrong or loses durability under
concurrency, recovery, lifecycle, or unusual input conditions. Numbers are
stable identifiers within this workstream, not an execution order.

## Active plans

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-link-healing.md) | Heal links whose fragments contain ordinary `s` characters | P1 | TODO | — |
| [002](002-journal-append.md) | Serialize write-journal counters and appends per document | P1 | TODO | — |
| [003](003-untracked-rollup-transactions.md) | Make untracked file-rollup mutations and receipts restart-safe | P1 | TODO | 002 for shared journal safety |

## Smaller items

| Item | State | Promote when |
|---|---|---|
| Explicit web-editor unload drain | READY | Define application-level navigation and `beforeunload` behavior for admitted and pending generations instead of starting an unawaited save from component cleanup. |
| Commit native control text before flush | REVERIFY | Confirm the current Quagmire host can still hold text outside `ArborDocumentBinding` at background/navigation/close boundaries. If so, add a commit-then-flush lifecycle operation and visible checkpoint-pending state. |
| Per-key frontmatter conflict semantics | READY | Preserve independent external and local frontmatter changes, detect same-key conflicts and deletions, and test them beside block three-way merge. |
| Recovery repair versus concurrent writes | REVERIFY | Characterize `WorkspaceFS.read()` recovery writes under the current coordinator and CAS boundaries before extracting a locking-safe repair path. |
| Background synchronization versus local mutation | REVERIFY | Confirm current tree synchronization and snapshotting cannot materialize or publish a torn local transaction; retain actionable errors rather than classifying programming failures as offline state. |

Structural undo, inverse metadata, exact reorder restoration, pointer lifecycle,
keyboard access, context-menu focus, bounded history, and scroll restoration are
owned together by [Interface 002](../interfaces/002-web-editor.md).
