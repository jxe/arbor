# Schema language 003: logical collections, projected per placement

**Why and when:** Joe, 2026-10-15, in the "Cranberries in Story" thread:
"differentiate logical tree and projection on both sides of the wire", where
the projection is "a property of a *placement*", not of `schema.usl`. It came
up because plan 002 milestone 2 put `store: "sqlite"` in the accepted tree,
which tied a device's storage choice, and then the host's history promise, to
whether a database file happened to sit in a folder. This note works through
the two questions that decide the design. Nothing here is built.

## Status

- **State:** PROPOSED, for discussion.
- **Affects:** plan 002 milestones 2 and 2a; spec 01 (representations), 02
  (projection boundary), 06 (§2.1, §3.1, §4, §7), 10 (§4.1); Postgres 002, 004
  and 005.

## The idea, and how much of it the spec already says

The spec already describes this, but only in parts and only in words:

- 01 "Representations": "A placement chooses how to materialize a tree … This
  representation choice is the child set's *backing* at that placement."
- 02 §1: the directory format "is not the Overstory ontology"; it is one
  projection.
- README: "Physical bytes, indexes, query plans, and placement projection
  choices are not application semantics."
- 06 §4 and Postgres 004 already do it for Postgres: a placement's
  `projection: { driver: sqlite, mode: bidirectional }` materializes "the
  Overstory logical data tree", which is canonical, and "SQLite pages and WAL
  remain private materializations".

What the spec does *not* do is make the accepted tree logical. A root commits
to a representation: a directory object whose entries are file bytes, plus a
`childrenSource` descriptor saying how to read them. The model hash is
derived from that. The proposal inverts this **for collections**: the
accepted tree holds the collection's logical state, and every representation,
on a device or on the host, is that placement's projection of it.

- **In the tree, on the wire, in history:** the collection's schema and its
  rows in one canonical logical encoding, plus the row operations that change
  them.
- **Per placement, never synchronized:** whether the rows appear as
  `_store.sqlite3`, `<Table>.jsonl`, a CSV, a folder of Markdown records, or
  nothing at all (the host until something queries it).

Pages are left out of this, because a page's bytes are the content people
write and spec 02's byte-exact round trip is relied on by Quagmire and by
external editors.

## Question 1: what is the logical form of a collection?

Today the two USL layouts *are* two representations: the database layout has
every n:m connection as a join table, `created`/`modified` columns and
`<field>_position` numbers, while the file layout folds `@fold` connections
into arrays and drops timestamps. Whichever we pick becomes what roots hash,
what row operations name, and what merge works on, so every projection must be
able to read from it and write back into it without loss.

### Options

1. **The database layout.** Tables and columns as `layoutOf(…, database)`
   gives them.
2. **The file layout.** As `layoutOf(…, files)` gives them.
3. **A layout-free record form.** Each model's rows by field, a reference as
   the target's key, an n:m connection held once (`records.ts` already has
   most of this as `recordsFromRows`), ordered connections as sequences.

### What each choice drives

- **Row operations name tables.** 10 §4.1 operations carry `table`, and for
  an n:m connection that is a join table (`List_games`) in the database layout
  but a field (`games` on `List`) in the file layout. With (1), a connect is
  a `rowCreate` on the join table; with (2) and (3) it is a field edit on one
  row. Field-level merge differs accordingly: join rows merge as a set of
  rows, an array field merges as a set or sequence.
- **Order.** The database layout stores order as `_position` numbers, so two
  devices inserting at the same place pick different numbers and merge
  cleanly as two field sets, but the numbers are an artifact a CSV projection
  has to carry or invent. A sequence (2 or 3) is the honest logical fact but
  needs a sequence merge. Fractional positions inside the logical form,
  hidden by file projections, is the practical middle.
- **Timestamps.** Since operations carry `at` (decided 2026-10-15), `created`
  and `modified` are deterministic results of accepted operations, so they can
  be logical without anyone inventing them. Replay already stamps `modified`
  from `at` when the table has the column. With (2) they would live only in
  history, and a SQLite projection, or any view sorted by `modified`, would
  need history to fill them in.
- **Join tables with their own fields** (a connection model like `Item` or
  `Contribution`) are rows in every option; only plain n:m connections
  differ.
- **Content.** A Markdown-records projection (one `.md` per row) gives each
  row content as well as properties. The logical form needs a place for it:
  a `Markdown` field the schema names as the row's body. That makes Markdown
  rows and SQLite rows the same logical thing, which is what 06 §7 migration
  promises.
- **Hashing.** Whatever the form, the hash must come from rows alone, so any
  placement can compute it from its projection. The per-table canonical text
  the branch uses works now; chunking by key range keeps it from growing with
  table size.

### Recommendation

**(1), the database layout, as the logical form**, with order kept as
positions and `created`/`modified` derived from accepted operations. It is
the most explicit form, every other projection is a lossless view of it
(folding join tables into arrays, dropping timestamps and positions), row
operations and merge already work on it, and the host's projection is then a
plain copy. (3) is cleaner on paper, but it needs a new merge for arrays and
sequences, and the database layout is the one that has to exist somewhere
anyway.

## Question 2: what happens to collection files people write by hand?

Today a hand-made `games.csv` is tree content: its exact bytes are in the
tree, and merge and replay *splice* changed rows into it (`spliceCollectionFile`
in `row-replay.ts`), so its column order, quoting, line endings and unchanged
rows survive edits from other devices. Only the branch's database tables are
rewritten canonically. So formatting really is preserved across devices
today, and that is what is at stake.

### Options

1. **Two kinds.** Authored collection files stay representation (bytes in the
   tree, spliced as now). Only collections a placement projects as a database
   become logical. Smallest change; but a placement's choice then changes what
   the tree holds, which is the coupling this proposal set out to remove, and
   two placements of one tree could not choose differently.
2. **All logical, canonical projections.** Every collection is logical; a
   file projection is written canonically. Uniform, but every device rewrites
   your file into canonical form, so formatting is lost everywhere.
3. **All logical, projections that keep their own formatting.** Every
   collection is logical. A placement that projects as a file keeps that file
   as its private state and applies accepted changes by splicing changed rows
   into it, as merge does today; it rewrites nothing else. A placement
   creating a projection from scratch writes canonical form.

### What each choice drives

- **Whose formatting survives.** Under (3), the formatting you choose survives
  on your placements; another device shows the same rows in its own
  projection's formatting. Under (1) it survives everywhere; under (2)
  nowhere.
- **Git and shared folders.** A git checkout or a Dropbox folder is a
  placement. Under (2) and (3) two checkouts of one tree can hold different
  bytes for the same rows, which is right if the folder is a view and
  surprising if people treat it as the data.
- **Equality.** Under (2) and (3), reformatting a CSV changes nothing in the
  tree: no update, no history entry. That matches "placement owns
  representation", but it's a visible behavior change.
- **What isn't data is lost when it crosses a placement:** columns outside the
  schema, JSON key order, YAML comments in a Markdown row's front matter. The
  schema becomes the whole contract for a collection. A Markdown row is then a
  projected record, not a page, so spec 02's byte-exact promise doesn't cover
  it; Story should present such a folder as a collection, not as pages, so the
  difference is visible.
- **Reading a projection back.** Every projection needs a tolerant read (any
  valid edit becomes row operations against the last applied state) and a
  minimal write (only changed rows). That discipline exists for SQLite on the
  branch and for files in today's splicing; (3) makes it the rule for all of
  them.
- **The daemon fighting your editor.** If a projection rewrites a file you're
  editing, you lose your edit or your formatting. Splicing only changed rows,
  and only after the editor's save is read in, keeps that to genuine
  conflicts.

### Recommendation

**(3).** It removes the representation from the tree, so placements really can
choose, while keeping what (1) protects for the people who wrote the file,
using the splicing that already exists. (2) throws away a working guarantee
for no gain, and (1) keeps the coupling.

## Where placement choices live

- **Device:** the local placement map (`~/.story/placements.yaml`, which
  already anticipates `{ tree, projection }`), per collection path, for
  example `"/games": { driver: sqlite }`. Private, never synchronized
  (04 §4). On first sight of a collection with no entry, Story Sync records
  what it finds on disk (a database, a CSV, Markdown records) as that
  placement's choice, so nothing changes for existing folders.
- **A default for new placements:** something has to pick when a placement
  doesn't say. Either each implementation's own default, or a hint carried in
  the tree (for example in the collection's `_index.md`) that placements may
  override. A hint keeps a new device looking like the old one; it must never
  be read as truth.
- **Host:** its projection (a SQLite file for queries and mutations, plan 002
  §2a) is the host's operational choice, like 06 §4's host activation.

## The history promise follows

With representation per placement, retention is per placement too:

- a device keeps the current state and its unsent operations;
- a host keeps collection states under a retention policy, full by default,
  or a horizon by time and count, always keeping row operations and the
  alternatives of open decisions. Because a host's retention is a promise to
  every reader, it's set by the host operator and requested by the tree's
  administrators in the tree configuration (like `access.yaml`), not by a
  device's placement.
- Pruning changes what a host can serve, never what a root means: an old root
  stays a valid name, and reading its pruned rows gets a distinct "pruned"
  answer (spec 01), not a 404.

## What it changes on the plan 002 branch

- `store: "sqlite"` leaves the descriptor; a collection's descriptor names its
  logical tables only. The canonical table encoding stays, as the logical
  encoding rather than "the database's checkpoint".
- Story Sync's choice between database and files comes from the placement,
  not from which file is present.
- Merge and replay write the logical encoding; splicing moves from merge into
  the file projections' write path.
- 06 §3.1 is rewritten as "collections are logical; placements project them",
  and §2.1's description of authored collection files moves to the
  projection side. Postgres 002's "canonical logical checkpoint" and Postgres
  004's logical data tree become this one encoding.

## Open questions

1. Pages: keep them representation-first for good, or later give a page the
   same split (front matter as properties, body as content)?
2. Does a collection that some placement projects as Markdown records need
   its schema to name a body field, or can rows carry content outside the
   schema?
3. Ordered connections: positions in the logical form, or a sequence with its
   own merge?
4. Chunking: before or after the first large table?
