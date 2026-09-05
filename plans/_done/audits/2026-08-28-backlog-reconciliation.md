# Technical-debt backlog reconciliation — 2026-08-28

This record maps every item from the former mixed
[`hardening/backlog.md`](2026-08-28-technical-debt-backlog.md) to one current
owner. It is not an active queue.

## REST protocol and clients

| Former item | Disposition |
|---|---|
| Access-link secrets in local navigation | Promoted to [Security 004](../../security/004-access-link-secrets.md). |
| Mixed `removeTreePlacement` mutation batches | Superseded: placement removal is now a client configuration action that edits one device YAML document, not a protocol mutation operation. |
| One-pass percent decoding | Existing [Security 002](../../security/002-path-decoding.md). |
| Expose the old v0.8 `system:` shape | Superseded by the reviewed narrow system projection (`credentials`, `visited`, and `diagnostics`) plus ordinary account-configuration trees and `system:connections/...` locators. |
| Copied-subtree identity and link semantics | Folded into [Smaller project 005](../../smaller-projects/005-web-editor.md#structural-and-lifecycle-constraints). |
| Share runtime protocol decoding | Kept as a conditional item and admission rule in [Cleanups](../../README.md#cleanups). |
| Remove pre-Canopy readers | Moved to [Cleanups](../../README.md#cleanups) with explicit deployment and retention gates. |

## Data 002 continuations

| Former item | Disposition |
|---|---|
| PageID-shaped compatibility bridge | [Cleanup 001](../../cleanups/001-pageid-stable-key-cutoff.md). |
| Native offline rollup rows | Existing [Smaller project 003](../../smaller-projects/003-native-offline-collection-file-projection.md). |
| Postgres child provider | Existing [Postgres 001](../../postgres/001-child-provider.md). |
| Representation equivalence | Existing [Smaller project 001](../../smaller-projects/001-representation-equivalence.md). |
| File-provider exact-source cache invalidation | Smaller item in [the active plan index](../../README.md#hardening-efficiency-polish-etc). |
| Shared SQLite read/observation boundary | Existing [Postgres 002](../../postgres/002-observation-and-semantic-sync.md). |
| Lossless scalar projection | Added to Data 005's invariants and tracked as a cross-provider seam in [Cleanups](../../README.md#cleanups). |
| Relational names versus logical child segments | Added to Data 003 and already required by Data 004. |
| Whole-table SQLite revision stand-in | Existing Data 005 paging/observation work. |
| Compiler and editor tooling | Existing [Apps 003](../../apps/003-development-compiler-and-editor-tooling.md). |
| Whole-source portable query evaluation | Added as Application 003's bounded portable-execution requirement. |
| SQLite direct-write receipt bridge | Existing Data 005 mutation/receipt deletion gate. |
| Untracked file-rollup transaction lifecycle | Promoted to [Reliability 003](../../reliability/003-untracked-collection-file-transactions.md). |
| Legacy mutation-journal effect decoder | [Cleanups](../../README.md#cleanups). |
| Canopy application-code isolation | Smaller gated item in [the active plan index](../../README.md#hardening-efficiency-polish-etc). |
| Exact rollup formatting through semantic merge | Added to Data 003's provider/exact-source continuation. |

## Editing, autosave, browser, and verification

| Former item or cluster | Disposition |
|---|---|
| Workspace-scoped undo, inverse metadata, and exact non-contiguous reorder undo | Folded into Interface 002's structural constraints. |
| Deferred-provider bounded placement | Added to Data 003 and tracked as a shared corpus in Duplication. |
| Web unload draining | Smaller ready item in [the active plan index](../../README.md#hardening-efficiency-polish-etc). |
| Native control-text draining | Reverification item in Correctness and reliability because the native host changed after the original note. |
| Frontmatter conflict semantics | Smaller ready item in Correctness and reliability. |
| Bounded/persisted editor history | Folded into Interface 002. |
| Deterministic stale async sequences | Smaller ready item in [the active plan index](../../README.md#hardening-efficiency-polish-etc). |
| Minimal changed-document reconciliation | Conditional measured item in Slow. |
| Pointer drag, keyboard movement, context-menu focus, and anchor scroll restoration | Folded into Interface 002's interaction constraints. |
| Developer browser smoke harness | Smaller ready item in Unverified. |
| Parallel integration isolation | Promoted to [Testing 002](../../testing/002-parallel-integration-isolation.md). |

The separate July audit remains preserved as
[`2026-07-31-hardening-audit.md`](2026-07-31-hardening-audit.md). Its resolved,
rejected, and direction findings remain historical evidence; current live
follow-ups appear only in the category indexes.
