# Cleanup work

This theme collects bounded deletion, simplification, and deduplication work.
A plan belongs here only when the desired result is less temporary machinery or
one clearer owner—not merely because nearby code could be refactored.

## Active plans

[001 — Retire the PageID-shaped stable-key bridge](001-pageid-stable-key-cutoff.md)
is **WAITING** until its read-only data audit is complete, the compatibility
window is explicitly closed, and Joe resumes it.

[002 — Retire v1 account and legacy local-state
adapters](002-retire-v1-account-and-local-state-adapters.md) is **WAITING**
until Migration 003's rollback window ends, every supported Canopy and client
is proven current, Joe removes the retained backups, and the v1 compatibility
window is explicitly closed.

## Smaller items

| Item | Kind | State | Promote when |
|---|---|---|---|
| Split `ArborService` responsibilities | Simplification | NEEDS CHARACTERIZATION | Focused tests establish the protocol-routing, virtual-system-projection, and Canopy/Wire orchestration seams and a current change needs one independently. |
| Shared runtime protocol decoding | Deduplication | WAITING | A second trusted boundary besides Arbor Sync needs runtime decoding. Then colocate browser-safe pure decoders in `@arbor/core`; do not add schema generation solely to reduce repetition. |
| Provider scalar normalization | Deduplication | OWNED | Postgres 001 and 002 must freeze one language-neutral representation for blobs, 64-bit integers, booleans, nullability, and other provider scalars before implementations drift. |
| Bounded-placement conformance | Deduplication | OWNED | Smaller projects 001 and 003 plus Postgres 001 reuse the common placement corpus when deferred providers land; they must not create another placement algorithm. |

Private SQLite property receipts and direct-write bridges are removed under
[Postgres 002](../postgres/002-observation-and-semantic-sync.md). Temporary
whole-source query evaluation is removed under [Apps
003](../apps/003-development-compiler-and-editor-tooling.md). Web-editor
undo/history architecture remains owned by [Smaller project
005](../smaller-projects/005-web-editor.md), where its visible semantics can be
decided together.
