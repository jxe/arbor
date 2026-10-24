# Schema language 004: logical collections, projected per placement

**Why and when:** Joe, 2026-10-15, in the "Cranberries in Story" thread:
"differentiate logical tree and projection on both sides of the wire", where
the projection is "a property of a *placement*", not of `schema.usl`. It came
up because plan 002's milestone 2 (now [005](005-collections-that-sync.md)'s
milestone 5) put `store: "sqlite"` in the accepted tree,
which tied a device's storage choice, and then the host's history promise, to
whether a database file happened to sit in a folder. This note works through
the two questions that decide the design. Nothing here is built.

## Status

- **State:** PROPOSED, for discussion. Settled by Joe (2026-10-15 11:07):
  question 2 as recommended (option 3); a device's projection lives in
  `placements.yaml`; Story Sync records what it finds on disk the first time;
  host retention belongs to the host operator and the tree configuration.
  Forks 1 to 5 of the logical form settled 2026-10-24 (see "Forks for Joe"); 6 is open.
- **Built by:** [005](005-collections-that-sync.md), milestones 1 and 3.
- **Affects:** 005 milestones 4 to 6 (002's former 1, 2 and 2a); spec 01 (representations), 02
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

### Recommendation (revised; see "Exploring the logical form")

First pass recommended (1), because row operations and merge already work on
it. Working through it further points to (3): the merge rules USL already
states ("a row is a set of tuples", many-valued fields merge member by
member, `@ordered` fields merge as sequences) are about models and
connections, not tables, and row operations already have `rowConnect`,
`rowDisconnect` and `rowMove`. Both layouts then become projections.

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

## Exploring the logical form

The logical form is the one thing every placement agrees on and every hash
names; merge, access, presence and queries work on it, and replay produces
it. So it must be total, canonical and typed, and hold nothing that is a
placement's choice. Six things decide it.

### 1. What is addressable

The logical form fixes the collection's node paths, and those are durable:
links, `NodeRef`s, locators, access rules and presence all use them.

- **Models only (recommended).** `/games/Game/g1`, `/games/List/l1`. A model
  with rows is a table; a connection model (one with fields or `@@id`, like
  `Item` or `Contribution`) is a model, so its rows are addressable too. A
  plain n:m connection is not a node set: it shows as a property on the rows
  at both ends.
- **Every layout table.** Adds `/games/List_games/…`. Join rows are facts
  about two rows, not things anyone links to, and they would appear in Story's
  browser as a folder nobody made.

Today 10 §4.1 names tables by the data-file layout while the branch's
database collections use the database layout, so the same connection has two
names; fixing the logical form removes that.

### 2. Connections

- A plain n:m connection is a **set of pairs**, held once in the encoding.
  Which end holds it is an encoding detail (the `@ordered` end, else the end
  declared first). Either end's `rowConnect`/`rowDisconnect` names the same
  fact, and acceptance records it once.
- An `@ordered` connection is a **sequence** of member keys per owner, not
  `_position` numbers. Positions are a database projection's detail: the
  SQLite projection writes and renumbers them freely, and reading back turns
  a position change into `rowMove`. Merge is the sequence merge USL already
  names. Two devices moving the same member concurrently: the later move
  wins, with a merge note (Joe, 2026-10-15).
- A 1:1 or 1:n connection is a reference on the single side, as now.
- **`@fold`, `@@fold`, `@column` and `@@table` stop shaping data.** They
  become how the schema maps the logical form into file and database
  layouts, so refolding a connection changes no data and no hash (README's
  "refold, lossless" becomes free). They become `&` attributes (see "USL syntax").

### 3. Timestamps

`created` and `modified` are **row state**, stamped only from accepted
operations' `at`, never set directly; on merge, `modified` takes the later
value. The alternative, deriving them from history, fails once a host prunes
history under its retention policy, and every database projection and every
view sorted by `modified` needs them. Cost: two rows with equal fields and
different histories are not equal states.

### 4. Values

One canonical typed encoding per USL type, so no projection's conventions
leak in: `Int` and `Number` distinct (no `1` vs `1.0`), `Bool`, `Date` as
`YYYY-MM-DD`, timestamps as RFC 3339 UTC at a fixed precision, `Text` and
`Markdown` as UTF-8 strings, references as the target's key, `Person` as a
profile id, value arrays as arrays. Absent and empty differ: an optional field
with no value is omitted, never `null`, and an empty many-valued field is
absent.

### 5. Encoding and hash

- **Canonical CBOR** like every other protocol object, rather than the
  branch's JSONL: typed values without string conventions, and readability
  comes from projections anyway.
- **Rows sorted by key and chunked at content-defined boundaries**, a table
  object listing its chunks. Define the hash this way from the start, even
  though every table is one chunk today: a one-chunk table hashes the same
  forever, so splitting big tables later changes no hashes. Doing it later
  instead means a hash migration.

### 6. What stays authored

`schema.usl` stays authored bytes beside the collection, and the logical
collection binds to its fingerprint. `_index.md` and other files in the folder
stay ordinary entries: the folder is a page that has a logical collection.
Schema changes become logical migrations (add a field with a default, widen
arity, rename); the format-only ones in README stop touching data.

## USL syntax: model, storage and presentation

Decided and written up in [003](003-layers-and-sigils.md): `@` model, `&`
storage, `~` presentation, `re` blocks, conventions rather than enforced
separation, and `usl fmt` applying them. Examples are in
[examples/layered](examples/layered).

One point there touches this plan: 003 files `@path` under storage as
`&path`. §1 above argues a row's name is its logical identity, which would
keep it `@`. If `&path` stands, a row's name is a storage detail and the
logical form identifies rows by id alone.

## Existing SQL databases and typed values

The logical value's type comes from the schema, not from what a store
happens to hold, and a projection converts at its boundary:

- An `Int` field read from SQLite must hold an integer (a REAL `2.0` reads as
  `2`; `2.5` makes the row invalid). A `Number` field reads any numeric
  value as a number. Postgres's types already say which.
- A NULL reads as absent; an empty string stays a present empty string.
- `Bool` reads 0/1 (or `true`/`false`); `Date` and timestamps read the
  store's spelling (`2026-10-15 10:00:00+00`) and normalize to the canonical
  one.
- **Normalizing is not changing.** A value that reads back equal to the
  logical value is left as stored, so an existing database is never
  rewritten into canonical spellings; only fields that actually change are
  written, in the layout's spelling.
- A row the schema can't read (text in an `Int` column) is reported for that
  row, and the rest of the collection still syncs.

## Open questions, worked through

1. **Pages.** Keep them representation-first for now, but note the same
   split would cost less than it seems: under question 2's rule a device keeps
   its own front-matter formatting, and a page's body bytes are its content,
   so they'd stay exact. What would change is that front-matter formatting no
   longer travels between devices, and front matter would merge per property.
   Revisit once collections work this way.
2. **Content in rows.** Have the schema name the body: a `Markdown` field
   marked `@body` is what a Markdown-records projection writes after the
   front matter. The schema then stays the whole contract, a SQLite
   projection has a column for it, and a row has no content outside its
   fields. Rows have no children in a logical collection; a subpage belongs in
   a separate folder that links to the row.
3. **Order.** Sequences in the logical form, positions only in database
   projections (§2 above).
4. **Chunking.** Define the hash as chunked now; build splitting when the
   first table needs it (§5 above).

## Where placement choices live

- **Device (decided):** the local placement map, `~/.story/placements.yaml`.
  It is local, machine-managed (Story Sync and the CLI write it), never
  synchronized (04 §4), and maps a placed folder to its tree. On first sight
  of a collection with no entry, Story Sync records what it finds on disk (a
  database, a CSV, Markdown records), so nothing changes for existing
  folders. Proposed shape, per collection keyed by logical path:

  ```yaml
  tr_<configuration>:
    /Users/joe/Games:
      tree: tr_<games>
      collections:
        /Games: sqlite
        /Archive: jsonl
  ```

- **Local storage mappings (decided: visible):** a placement's own `&`
  overrides live in files under a visible folder such as
  `~/.story/storage/<tree>/…`, not in `placements.yaml` and not in private
  state, since they are a person's decisions about their own databases. They
  can't live in the placed folder, because everything there synchronizes.
  Proposed: found by convention, and written by Story Sync when it adopts an
  existing database, recording its real table and column names.
- **Shared storage defaults** that every placement starts from are `&`
  attributes in the tree's `.usl` files (in the `model`, or a `re` block).
- **A default for new placements:** something has to pick the format when a
  placement doesn't say: each implementation's own default, or a hint in the
  tree that placements may override. A hint must never be read as truth.
- **Host:** its projection (a SQLite file for queries and mutations, 005
  milestone 6) is the host's operational choice, like 06 §4's host activation.

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

## What it changes on the branch `claude/project-thread-6kt6l8`

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

## Forks for Joe

Settled by Joe on 2026-10-24, as recommended:

1. Only models are addressable; a plain n:m connection is a property on the
   rows at both ends.
2. Order is a sequence of member keys; positions exist only in database
   projections. A concurrent move of the same member: the later move wins.
3. A row's name is its logical identity, not a storage detail: `path` leaves
   003's storage layer.
4. `created` and `modified` are row state, stamped from accepted operations'
   `at`.
5. The logical form is canonical CBOR with a chunked hash from the start,
   replacing the branch's JSONL.

Open:

6. Content in rows: a field named `content` (002's convention), or a
   `Markdown` field the schema marks as the body?
