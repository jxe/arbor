# Remove-later work

This workstream inventories code that is intentionally temporary: compatibility
readers, migration bridges, recovery adapters, and other bounded transition
machinery. Numbers, when assigned, are stable local identifiers rather than an
execution order.

An item belongs here only when the desired end state is deletion. Every item
must name the evidence and retention condition that make deletion safe; this is
not a general technical-debt queue.

## Active plans

[001 — Retire the PageID-shaped stable-key bridge](001-pageid-stable-key-cutoff.md)
is a deferred executor plan. It remains **WAITING** until its read-only data
audit is complete, the compatibility window is explicitly closed, and Joe
resumes it.

## Smaller items

There are no smaller unplanned removal items.

Private SQLite property receipts, whole-table revision stand-ins, and temporary
whole-source query evaluation are not duplicated here: their replacement and
deletion gates belong to [Data 005](../data/005-database-observation-and-semantic-sync.md)
and [Application 003](../applications/003-development-compiler-and-editor-tooling.md).
