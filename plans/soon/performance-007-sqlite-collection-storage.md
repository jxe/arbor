# Performance 007: the host's database holds a collection's rows, the tree its log

**Why and when:** Joe, 2026-10-28, while settling the execution sidecar: it is more
efficient for overstoryd to work with a collection's SQLite file than with table and rows
objects. Joe, 2026-11-12, while Beetle's host copies were being built (Apps 015): "I don't
know if, in the long run, we really want to keep two copies of all rows, one in db and one
in tree". He chose the design below the same day and asked for it now ("I think we should
do Performance 007 now"). Built on branch `claude/project-thread-kn7ley`, which merges after
the Protocol 003 flag day.

## Status

**DECIDED · spec written, building.** Read [the Beetle host](../../docs/architecture/overstoryd/beetle-host.md)
first.

Today the host keeps a SQLite copy of each collection a Beetle program binds, beside the
tree's table and rows objects. Views and mutations read the copy; a mutation submits row
operations as an ordinary update, and the copy catches up from the chunks that changed.
Every row is held twice, and each accepted change is written as chunk objects and then
again as SQLite rows.

## The design

The host's SQLite database is where a collection's rows live. The tree no longer holds them
as table and rows objects. It holds a small `collection` reference naming the collection's
**log**: its accepted row operations, in order, each entry an object that names the one
before it. The log is what is versioned, synced and merged. The database is the log
applied.

### The reference

The reference names the log's head entry and carries a **rows hash**: a hash of the rows
that can be kept up to date per changed row, without a pass over the table (a homomorphic
multiset hash such as LtHash over each row's canonical encoding: take out a row's old hash,
add its new one). The rows hash is defined over canonical row encodings, never a store's
bytes, so any replica, in any store, can check it. It catches replicas that applied the
same operations differently, and lets two placements compare state without comparing rows.
(Joe, 2026-11-12: "ok".)

### Log entries

An entry is an object: the previous entry's hash, the update it was accepted with, its row
operations, and the rows hash after it. Entries never change. They travel like any other
object: an accepted update's watch frame carries its new entries as it carries new objects
today, and catching up after a gap is `watch?after=` as now. No new route.

### Snapshots

A snapshot is the SQLite file itself (`VACUUM INTO`, one sequential write), stored as one
object. Only the tree's host takes snapshots, since two machines writing the same rows get
different bytes; everyone else copies the host's. The host records each one as a log entry
with no row operations, naming the file's hash and the rows hash it must hold, so walking
objects from the root reaches the snapshot and every entry after it: backups, peer sync and
a host taking over a tree work by walking objects as now. (Joe, 2026-11-12: whole-tree
copies must not need anything beyond objects; SQLite is the efficient form.)

The host snapshots when the log since the last snapshot outgrows the database, and keeps
only the newest snapshot and the entries after it. The log is kept for the host's page
history budget; an old root whose entries were dropped answers "not retained", which the
spec already allows for databases. A replica that starts from a snapshot checks it against
the rows hash once.

Existing collections need a snapshot made once at the switch, plus an empty log.

**Catching up compacted.** A replica far behind may ask for the net change per row since
its head instead of every entry (a row edited 50 times arrives once), checked against the
head's rows hash. This is Litestream's compaction levels in row terms.

**Prior art: Litestream / LiteFS (LTX).** Joe asked, 2026-11-12. Same shape: a snapshot
plus a transaction log, restarted from a new snapshot ("generation") when continuity
breaks; a whole-database checksum kept per change by combining per-page checksums (our rows
hash, per row); compaction levels. Not reusable as the log itself: it ships pages, which
only replicate byte-identical files, and we need row operations for merging, access,
projections and Story Sync's base.

### Reading

A path read of a collection (`snapshots/{root}/path/{path}`) answers the reference, the
snapshot it starts from and the entries after it. A client without SQLite never needs the
file: views and row answers come from the host as now.

### Clients

Only the wire form changes. A client keeps the rows it pulls however it likes (SQLite,
Beetle's in-memory store, IndexedDB, or not at all in Browse mode). (Joe, 2026-11-12.)

**Story Sync and a local `_store.sqlite3`.** The projection is a replica kept from the log:

- **Starting, or after missed history:** download the host's snapshot, check its rows
  hash, and use it as the database when the layout matches; when Story Sync adopted a
  database with other names, attach the file and copy across with one `insert … select` per
  table. Then apply the entries after it.
- **Staying current:** apply each entry's row operations in one transaction (spec 2.2 §5).
- **Edits by other programs:** Story Sync keeps a **base**: the snapshot file with every
  accepted entry applied to it too, which is exactly the state last applied to the
  projection. A committed change is found by diffing the projection against the base in
  SQL (`except` per table), with no triggers, and it survives any tool. (Joe chose this,
  2026-11-12.)
- **Its own edits merged differently or refused:** it keeps the operations it sent until
  their entry comes back, and on a difference undoes them and applies the accepted ones.

### Mutations commit with their update

A Beetle mutation becomes one SQL transaction on the host's database, held open while its
update is submitted:

1. Each line's reads run as `insert into temp facts select …`, before any write, so every
   line reads the state from before the mutation (spec 1.5 §4).
2. Conflicting facts are one query over the facts table: two values for the same row and
   field fail the mutation with `conflict`. The checker flags the cases it can see
   statically.
3. The writes apply from the facts; their changed rows (`RETURNING`) become the row
   operations.
4. The operations are appended to the log as an update guarded on the head. Accepted: the
   transaction commits. Not: it rolls back and the mutation runs again at the new head.

The host serializes each collection's writes already.

### The host holds only the log form

After the switch a collection is never held as table and rows chunks on the host. (Joe,
2026-11-12: "sure, ok".)

## What has to keep working

- **The logical hash across placements** (changing a projection changes nothing in the
  tree): the reference holds the log head and rows hash, the same at every placement.
- **Merges and provenance.** Merging row operations is what derived candidates already do;
  text-level merge of collection files and chunk-hash skipping go for collections.
- **Access.** Per tree, as now.

## Steps

The spec is written ([status](../../status.md#performance-007-spec-collections-as-a-log-of-row-changes--2026-11-12));
conformance vectors follow the host.

1. Host: the rows hash, the log store and the database as the working form; accepting an
   update of row operations appends and applies in one step; snapshots; the current copies
   and chunk catch-up are deleted.
2. Mutations as SQL transactions, checked against the in-memory evaluator on every Supplies
   mutation.
3. Story Sync: projections as replicas with a base; Replica mode pulls entries.
4. Switch: each existing collection becomes a snapshot plus an empty log.
