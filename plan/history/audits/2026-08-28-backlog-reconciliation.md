# Technical-debt backlog reconciliation — 2026-08-28

This record maps every item from the former mixed
[`hardening/backlog.md`](2026-08-28-technical-debt-backlog.md) to one current
owner. It is not an active queue.

## REST protocol and clients

| Former item | Disposition |
|---|---|
| Access-link secrets in local navigation | Promoted to [Insecure 004](../../insecure/004-access-link-secrets.md). |
| Mixed `removeTreePlacement` mutation batches | Superseded: placement removal is now a client configuration action that edits one device YAML document, not a protocol mutation operation. |
| One-pass percent decoding | Existing [Insecure 002](../../insecure/002-path-decoding.md). |
| Expose the old v0.8 `system:` shape | Superseded by the reviewed narrow system projection (`credentials`, `visited`, and `diagnostics`) plus ordinary account-configuration trees and `system:connections/...` locators. |
| Copied-subtree identity and link semantics | Folded into [Interface 002](../../interfaces/002-web-editor.md#structural-and-lifecycle-constraints). |
| Share runtime protocol decoding | Kept as a conditional item and admission rule in [Duplication](../../duplication/README.md). |
| Remove pre-Canopy readers | Moved to [Remove later](../../remove-later/README.md) with explicit deployment and retention gates. |

## Data 002 continuations

| Former item | Disposition |
|---|---|
| PageID-shaped compatibility bridge | [Remove later](../../remove-later/README.md). |
| Native offline rollup rows | Existing [Data 006](../../data/006-native-offline-rollup-row-projection.md). |
| Postgres child provider | Existing [Data 004](../../data/004-postgres-child-provider.md). |
| Representation equivalence | Existing [Data 003](../../data/003-representation-equivalence.md). |
| File-provider exact-source cache invalidation | Smaller item in [Slow](../../slow/README.md). |
| Shared SQLite read/observation boundary | Existing [Data 005](../../data/005-database-observation-and-semantic-sync.md). |
| Lossless scalar projection | Added to Data 005's invariants and tracked as a cross-provider seam in [Duplication](../../duplication/README.md). |
| Relational names versus logical child segments | Added to Data 003 and already required by Data 004. |
| Whole-table SQLite revision stand-in | Existing Data 005 paging/observation work. |
| Compiler and editor tooling | Existing [Application 003](../../applications/003-development-compiler-and-editor-tooling.md). |
| Whole-source portable query evaluation | Added as Application 003's bounded portable-execution requirement. |
| SQLite direct-write receipt bridge | Existing Data 005 mutation/receipt deletion gate. |
| Untracked file-rollup transaction lifecycle | Promoted to [Correctness and reliability 003](../../correctness-and-reliability/003-untracked-rollup-transactions.md). |
| Legacy mutation-journal effect decoder | [Remove later](../../remove-later/README.md). |
| Canopy application-code isolation | Smaller gated item in [Insecure](../../insecure/README.md). |
| Exact rollup formatting through semantic merge | Added to Data 003's provider/exact-source continuation. |

## Editing, autosave, browser, and verification

| Former item or cluster | Disposition |
|---|---|
| Workspace-scoped undo, inverse metadata, and exact non-contiguous reorder undo | Folded into Interface 002's structural constraints. |
| Deferred-provider bounded placement | Added to Data 003 and tracked as a shared corpus in Duplication. |
| Web unload draining | Smaller ready item in [Correctness and reliability](../../correctness-and-reliability/README.md). |
| Native control-text draining | Reverification item in Correctness and reliability because the native host changed after the original note. |
| Frontmatter conflict semantics | Smaller ready item in Correctness and reliability. |
| Bounded/persisted editor history | Folded into Interface 002. |
| Deterministic stale async sequences | Smaller ready item in [Unverified](../../unverified/README.md). |
| Minimal changed-document reconciliation | Conditional measured item in Slow. |
| Pointer drag, keyboard movement, context-menu focus, and anchor scroll restoration | Folded into Interface 002's interaction constraints. |
| Developer browser smoke harness | Smaller ready item in Unverified. |
| Parallel integration isolation | Promoted to [Unverified 002](../../unverified/002-parallel-integration-isolation.md). |

The separate July audit remains preserved as
[`2026-07-31-hardening-audit.md`](2026-07-31-hardening-audit.md). Its resolved,
rejected, and direction findings remain historical evidence; current live
follow-ups appear only in the category indexes.
