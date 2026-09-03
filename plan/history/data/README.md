# Completed data and node-model plans

Completed data plans retain their local identifiers here so active plans can
depend on the delivered contract without leaving completed executor documents
in the active queue.

| Plan | Outcome | Status |
|---|---|---|
| [002](002-reconcile-node-data-model.md) | Unified files, documents, directories, collections, tables, rows, queries, mutations, observations, and Wire rollups behind the common Arbor node model | COMPLETE — closed at `450d2a4` |
| [007](007-provider-runtime-ownership.md) | Gave every projection backing one runtime owner and made Arbor Sync provider-neutral | COMPLETE — 2026-08-28 |
| [009](009-update-if-match.md) | Added `ifMatch`, `onConflict`, per-node model comparison, and merge rules | COMPLETE — 2026-09-02; migration 001 live cutover complete |
| [010](010-index-body-precedence.md) | Made `_index.md` authoritative over a sibling body with a non-blocking diagnostic | COMPLETE — 2026-09-02 |
| [011](011-collection-file-wire.md) | Separated logical child sets from their backing and migrated collection-file Wire encoding | COMPLETE — live Canopy, Mac, and iPhone cutover plus decoder closeout completed 2026-09-03 |
