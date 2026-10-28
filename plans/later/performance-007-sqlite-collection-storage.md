# Performance 007: keep collections in SQLite on the host

**Why and when:** Joe, 2026-10-28, while settling the execution sidecar
([Apps 005](../soon/apps-005-source-resolution-and-sidecar.md)): it is more efficient for
overstoryd to work with a collection's SQLite file than to keep the equivalent table and
rows objects around. Later, after the sidecar.

## Status

**PLANNED · not started.** A direction, not a design. Read `status.md`, the
[execution sidecar](../../docs/architecture/overstoryd/execution-sidecar.md) and
`packages/overstoryd/src/collections.ts` before relying on it.

## The idea

Today the canonical table and rows objects are what overstoryd stores and retains, and the
SQLite materialization beside them is a disposable cache. This plan turns that round. The
SQLite file becomes overstoryd's working form of a collection, and replaying a row-only
update applies it to SQLite instead of rebuilding chunk objects. That matches what
[Filesystem 026](../soon/filesystem-026-pages-as-logical-nodes.md) settled for pages: a
host may store any logically equivalent form, and only the hashed canonical encoding is
shared.

## What has to keep working

- **Clients still sync canonical objects.** Story Sync and the merge sidecar read table
  and rows objects. The host produces them from SQLite on demand, byte for byte the same
  as today's encoding (spec 06 §2), and the collection reference's hash must not change.
- **History.** Old roots name old table objects. Joe: SQLite collections may get a lower
  history budget, or none, or history kept some other way (row versions in SQLite, for
  example). Decide which before building, and what an old root that can no longer be
  rebuilt answers.
- **Merges and provenance.** Field-level merge, [Performance 004](../soon/performance-004-provenance-index.md)
  and chunk-hash skipping all assume objects. Each needs a path that reads SQLite.

## Decide first

1. The history model for SQLite collections.
2. Whether encoding on demand is fast enough for large tables, or chunk objects are
   cached once produced.
3. Backups: the SQLite files stop being a cache and must be backed up and checked like
   the object store.
