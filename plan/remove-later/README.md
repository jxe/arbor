# Remove-later work

This workstream inventories code that is intentionally temporary: compatibility
readers, migration bridges, recovery adapters, and other bounded transition
machinery. Numbers, when assigned, are stable local identifiers rather than an
execution order.

An item belongs here only when the desired end state is deletion. Every item
must name the evidence and retention condition that make deletion safe; this is
not a general technical-debt queue.

## Active plans

There are no executor-ready removal plans. The remaining bridge is still inside
its declared compatibility window.

## Smaller items

| Item | State | Delete when |
|---|---|---|
| PageID-shaped stable-key bridge | WAITING | The legacy-fragment uniqueness reader has passed its retention window and Markdown identity has a provider-owned codec. Remove `pageIDStableKey`, `pageIDFromStableKey`, private PageID owner indexes, and legacy candidate translation without removing generic rename healing. |

Private SQLite property receipts, whole-table revision stand-ins, and temporary
whole-source query evaluation are not duplicated here: their replacement and
deletion gates belong to [Data 005](../data/005-database-observation-and-semantic-sync.md)
and [Application 003](../applications/003-development-compiler-and-editor-tooling.md).
