# Completed hardening plans

| Historical plan | Outcome | Completed |
|---|---|---|
| [003](003-harden-cbor-decoding.md) | Harden the CBOR decoder against hostile wire bytes | 2026-08-24, as part of native Plan 013 conformance work |
| Recovery repair versus concurrent writes (unnumbered reliability item) | Superseded by Native 022: the daemon's recovery path (`/v1/recovery`, `restoreRecovery` through the daemon) was deleted in Phase 7; editors keep their own working-tree recovery | 2026-09-09 |
| Background synchronization versus local mutation (unnumbered reliability item) | Superseded by Native 022: the daemon's local mutation path (`/v1/mutations`, editor admission) was deleted in Phase 7; the folder is the daemon's only local source and materialization runs inside the per-tree workspace I/O boundary | 2026-09-09 |

Completed hardening plans retain their original identifiers here. The active
taxonomy now uses separate [cross-cutting themes](../../README.md#cross-cutting-themes)
with local identifiers; those numbers do not change this historical reference.
