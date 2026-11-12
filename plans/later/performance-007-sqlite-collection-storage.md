# Performance 007: the host's database holds a collection's rows, the tree its log

**Why and when:** Joe, 2026-10-28, while settling the execution sidecar: it is more
efficient for overstoryd to work with a collection's SQLite file than with table and rows
objects. Joe, 2026-11-12, while Beetle's host copies were being built (Apps 015): "I don't
know if, in the long run, we really want to keep two copies of all rows, one in db and one
in tree", and the tree's role (access, hash and version sequencing) "could be handled in a
different way". He chose the design below over keeping canonical chunk objects. Later:
after Apps 015 and the Protocol 003 flag day.

## Status

**PLANNED · not started.** For Joe's review: a direction with a first design, not a spec
change yet. Read [the Beetle host](../../docs/architecture/overstoryd/beetle-host.md) first.

Today (branch `claude/project-thread-kn7ley`) the host keeps a SQLite copy of each
collection a Beetle program binds, beside the tree's table and rows objects. Views and
mutations read the copy. A mutation writes into an overlay and submits row operations as
an ordinary update. The copy then catches up from the chunks that changed. That works,
but every row is held twice, and each accepted change is written as chunk objects and then
again as SQLite rows.

## The idea

The host's SQLite file is where a collection's rows live. The tree no longer holds them as
table and rows objects. It holds a small `collection` reference that names the
collection's **operation log**: the accepted row operations, in order, each entry chained
to the one before by hash. The log is what is versioned, synced and merged. The database
is the log applied, kept by the host and by each replica.

| Job the tree does for collections today | How it is done instead |
| --- | --- |
| Versioning: each accepted state has a hash; updates chain | The reference names the log's head entry; the root's hash covers it. |
| Sync: devices fetch chunks by hash | Devices pull log entries after their last head into their own SQLite replica (the Replica client mode). |
| Merging offline edits | Already row operations: Story sends row-only updates and the host replays them (derived candidates, spec 10 §2.2). |
| Access | Per tree, as now. Later, the host could filter which rows a replica pulls. |
| Projections (Markdown rows, CSV, SQLite on disk) | Unchanged in kind: spec 2.2 §4 already turns projection changes into row operations and applies accepted operations in one transaction per update. Story Sync reads them from the log instead of deriving them from changed chunks. |

## Mutations commit with their update

A Beetle mutation becomes one SQL transaction on the host's database, held open while its
update is submitted:

1. Each line's reads run as `insert into temp facts select …`, before any write, so every
   line reads the state from before the mutation (spec 1.5 §4).
2. Conflicting facts are one query over the facts table: two values for the same row and
   field fail the mutation with `conflict`. The checker flags the cases it can see
   statically (the same row expression set twice to different values).
3. The writes apply from the facts. Their changed rows (`RETURNING`) become the row
   operations.
4. The operations are appended to the log as an update guarded on the head. If the update is
   accepted, the transaction commits. If not, it rolls back and the mutation runs again at
   the new head.

The host serializes each collection's writes already, so the transaction holds no lock
anyone else is waiting on for longer than one accept.

## History

Joe, 2026-10-28: database collections may have a weaker history guarantee than pages. The
log is kept for a history budget. An old root whose log entries were dropped answers "not
retained", the same as any old root past the host's budget. A replica that has missed
dropped entries rebuilds from a snapshot of the host's rows (spec 2.2 already says a
placement that missed history rebuilds its database from the host's rows).

## What has to keep working

- **Verification.** A replica must be able to check what it pulled. The log's hash chain
  does that for operations. Whether the reference should also carry a hash of the rows
  themselves (which costs a pass over changed rows per update, maintained incrementally) is
  open.
- **The logical hash across placements** (spec 06 §7: changing a projection changes nothing
  in the tree). With a log, the logical hash is the log head's, which is the same at every
  placement.
- **Merges and provenance.** Field-level merge, the
  [provenance index](../../docs/architecture/overstoryd/provenance-index.md) and chunk-hash
  skipping assume table objects. Merging row operations is already what derived candidates
  do; text-level merge of collection files is no longer needed for collections.
- **Backups.** The database stops being a cache: it is backed up and checked like the
  object store, or rebuilt from the log plus a periodic snapshot.

## Decide first

1. The reference's shape: log head only, or log head plus a rows hash.
2. The history budget, and whether snapshots are tree objects (so a new replica can start
   from one) or a host-only file.
3. Whether a collection can still be held as chunk objects (small collections, or hosts
   without SQLite), or the log is the only form after a flag day.

## Steps (once decided)

1. Spec: collections chapter (06) and placements on disk (2.2 §4) describe the log and
   replicas; Beetle 1.5 §4 describes mutations as one transaction.
2. Host: the log store and the database as the working form; accepted updates of row
   operations append and apply in one step; the host's current copies and chunk catch-up
   are deleted.
3. Mutations as SQL transactions (above), checked against the in-memory evaluator on every
   Supplies mutation.
4. Clients: Replica mode pulls log entries; Story Sync's projections read operations from
   the log.
5. Migration: each existing collection's rows become a snapshot plus an empty log.
