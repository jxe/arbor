# Schema language 005: collections that sync

**Why and when:** Joe, 2026-10-22, splitting [002](../../later/schema-language-002-cranberries-in-story.md):
part of the database-views work is only getting the schema language updated,
getting SQLite to work and sync correctly, and fixing what is wrong or
preliminary in how collections are implemented, above all the difference
between a tree's logical content and the files a placement writes. That part
comes first, and soon, because [People 001](../../later/people-001-directory-and-go-to.md)
keeps its directory as collections and needs it. Presenting and editing
collections as views in Story stays in 002, for later.

This plan is the build plan. The designs it builds are
[003](003-layers-and-sigils.md) (the model, storage and presentation layers in
USL) and [004](004-logical-collections.md) (logical collections, projected per
placement); the decisions it carries over from 002 are below.

## Status

- **Effort:** XL, in milestones.
- **Risk:** HIGH. It changes what a tree root holds for a collection, the
  merge protocol (field-level merge) and how SQLite is hashed and synced.
- **State:** IN PROGRESS. Row operations, field-level merge, multi-table
  folders, SQLite syncing as rows, and the StoryKit port of `packages/usl` are
  built on branch `claude/project-thread-6kt6l8` (the Swift is untested), not
  on main. They were built before 004, so part of that work is reworked here
  (milestone 2). 003's syntax is decided but not implemented. 004's forks are
  open.
- **Depends on:** nothing.
- **Unblocks:** [People 001](../../later/people-001-directory-and-go-to.md);
  [002](../../later/schema-language-002-cranberries-in-story.md)'s presented views
  and structured editor; host queries and mutations for
  [Apps 005](../../later/apps-005-source-resolution-and-sidecar.md) and
  [Apps 006](../../later/apps-006-durable-authoring.md) (milestone 6). Rows readable
  offline on native ([Apps 010](../../later/apps-010-native-offline-collection-file-projection.md))
  moved with the native step to People 001's phase 0.

## What is wrong or preliminary today

On main:

- A collection is whatever files sit in its folder. A root commits to their
  bytes, and the model hash comes from them, so the placement's choice of
  representation is part of the tree. A `_store.sqlite3` "absorbs its
  enclosing folder" (spec 06 §3) because a file is present.
- A collection holds one table (`_store.*`); the `collection-tables` check in
  `packages/collection-schema` (`compile.ts`) refuses more, while
  `usl verify` already reads multi-table folders with its own duplicate
  decoder.
- Edits reach the host as snapshots: story-sync splices row bytes into
  `_store.*` and publishes `trace: null`. The host merges whole rows, and a
  row conflict becomes a decision on the whole collection directory.
- SQLite doesn't sync. A tree carries `_store.sqlite3` as an opaque file, and
  story-sync's `SQLiteProjectionDriver` only reads, plus single-row updates.
- The file layout drops every `timestamp` column, including user-declared
  ones, so `created` and `modified` aren't kept in files.
- The two USL layouts name the same connection differently (a join table
  `List_games` in the database layout, a field `games` in the file layout),
  and spec 10 §4.1 uses one while the branch's database collections use the
  other.
- USL mixes the model with storage and presentation (`@fold`, `@@table`,
  `@@views` on one level), and can't say that storage belongs to a placement.
- Nothing in Swift reads `schema.usl`.

On the branch, as 004's "What it changes on the plan 002 branch" lists:
`store: "sqlite"` sits in the accepted tree's descriptor, a synced database is
held as canonical JSONL per table, merge and replay write a representation,
and row operations name layout tables.

## Decisions carried over from 002

Settled with Joe on 2026-10-15 (discussion in the project thread "Cranberries
in Story"), and still in force:

- SQLite will be the most common representation.
- The merge tool and merge protocol are extended for field-level and
  database merges.
- **Row operations** (set with the value seen, connect, disconnect, create,
  delete, move) join the source operations of spec 10, so row edits ride the
  ordinary updates route. Merge is per field by the schema's arity rules; a
  field conflict keeps both values for someone to pick.
- Replaying a row operation re-derives the collection's state
  deterministically; the frame's `after` must equal it (spec 10 §2 amended).
- `created` and `modified` are stored, stamped from accepted operations' `at`;
  `created` never changes and `modified` merges to the later value, so they
  never conflict.
- A schema with several data models stored as files uses one
  `<Table>.jsonl` per table.
- A row may be its own Markdown file: a field named `content` (`Markdown`) is
  the body, `title` is the page title, everything else is front matter. (004
  open question 2 proposes marking the body field `@body` instead.)
- Story gets USL natively: `packages/usl`'s parser, checker and layout port to
  StoryKit.
- A device's projection lives in `placements.yaml`; Story Sync records what it
  finds on disk the first time. Host retention belongs to the host operator
  and the tree configuration (004).
- The multiset hash (LtHash) of 002's first draft is replaced by a chunked,
  canonical hash over rows (002 §2a, 004 §5).

## Milestones

Settle the logical form first, because every later milestone writes it. Then
the language, then the data and its sync. Milestones 3 and 4 rework what the
branch built; the branch is the starting point, not a separate thing to land
first.

### 1. Settle the logical form, and write it into the spec

- Settle 004's forks with Joe (done 2026-10-24): only models addressable,
  order as sequences, a row's name as logical identity, timestamps as row
  state, canonical CBOR with a chunked hash, and a row's body as a storage
  choice. 003's syntax was revised the same day (model keywords, `@` for
  storage, keys in the header, `enum`).
- Spec: 01 (representations), 02 (the projection boundary), 06 §2.1, §3, §3.1,
  §4 and §7 ("collections are logical; placements project them"), 10 §4.1
  (row operations name models and fields, not layout tables) and 11 (003's
  layers). Spec README deferred item 5 (the database change log and
  checkpoint format) closes: the change log is the accepted row operations,
  and the checkpoint is the logical hash.

**Done when:** the spec says what a root holds for a collection, and Joe has
answered 004's forks.

Written 2026-10-24: chapter 11 in the new syntax (layers, `enum`, header keys,
fingerprints), 06 §1.1, §2, §3 and §7 (logical collections and projections),
01 (the `collection` reference, table and rows objects, field decisions), 02,
03, 04 §4, 10 §2, §4.1 and §7.1, and the README. Choices made while writing,
confirmed by Joe the same day: `schema.usl` is the only schema file in the
tree; the logical form keeps no undeclared members; chunks end at a 1-in-512
row hash after at least 512 rows, or at 8,192; at most one end of a
connection is `ordered`. The schema names a `main` model whose rows are the folder's
children, and other models nest under their names, so adding a model moves no
rows. The chunk rule is fixed for everyone, because devices compute roots
too. The conformance vectors still bind the old form
until milestones 2 and 3.

### 2. USL layers

003's steps 1 to 6: spec 11, the TS parser and checker, `usl fmt`, the
StoryKit port, the editor grammars, and the examples rewritten. No old spellings are kept (Joe, 2026-10-24: no
collections are live), and `@@editableBy` goes with them. The new syntax ships
as `@ovst/usl` 0.3.0; cranberries pins `^0.2.0`, whose `documentFromUsl` maps
`@@editableBy` to `owners` for the live sites, so they keep working until
they move.

**The StoryKit port** (moved here from 002 milestone 3; built on the branch for
the old syntax): `packages/usl`'s parser, checker and layout in StoryKit,
which has no dependencies today, about 2,000 lines of TS. Run both stacks
against shared vectors. Story needs it to validate rows offline and to send
row operations.

**Done when:** every `.usl` in the repo, cranberries, excellences and
supplies-remake is in the layered form and checks the same in TS and Swift.

**Status (2026-10-24):** the TS side is on main: parser, checker, `usl fmt`,
`modelLayer`, the editor grammars, and every `.usl` and inline schema in the
repo, with `@ovst/usl` at 0.3.0 (not yet published). The StoryKit port is
written on `claude/project-thread-6kt6l8`, untested. Left: build and test the
port on Joe's Mac, publish 0.3.0, and move cranberries, excellences and
supplies-remake.

### 3. Logical collections

004 built:

- The accepted tree holds a collection's schema fingerprint and its rows in
  the logical encoding; the descriptor names logical tables only, and
  `store: "sqlite"` leaves it.
- Rows sorted by key, chunked at content-defined boundaries, a table object
  listing its chunks; one chunk per table today. `ModelHashes.compute`
  (`tree-merge/src/model-hash.ts`) takes the logical hash where `childSet`
  goes for collection files, so a CSV, JSONL and SQLite holding the same rows
  hash the same, and 06 §7's migration keeps the digest.
- `CollectionFileDescriptor` (`packages/protocol/src/model/node-model.ts`,
  Swift `ProtocolObjects.swift`) is replaced by the logical form, decoded
  strictly in both stacks, with conformance vectors.
- `packages/collection-schema` returns one schema per model, and `usl verify`
  uses its decoder instead of its own; `collection-tables` goes.
- **Projections per placement.** Each placement writes the collection as its
  `placements.yaml` entry says (SQLite, `<Table>.jsonl`, CSV, Markdown
  records), with a tolerant read (any valid edit becomes row operations
  against the last applied state) and a minimal write (only changed rows).
  Splicing moves from merge into the file projections' write path, so a
  person's own file keeps its formatting on their placements. Typed values
  convert at the projection's boundary (004 "Existing SQL databases and typed
  values"); normalizing never rewrites a stored value.
- **Storage mappings** (003 step 7): per-collection formats in
  `placements.yaml`, mapping files under `~/.story/`, written when Story Sync
  adopts an existing database.
- `packages/fs/src/protocol-tree.ts` (which throws on a second collection
  file) and story-sync discovery (`state/providers/discovery.ts`) learn
  multi-table folders.

- **Story.app carries collections, without showing them** (Joe, 2026-10-24).
  Swift decodes the collection reference and its table and rows objects,
  every graph walk follows them, and a native working tree keeps them in its
  overlay, so a collection survives a round trip through Story on Mac and iOS.
  Story.app shows a collection folder only as it does today (a kind and a row
  count); listing or editing its rows waits for 002's presented views.

**Done when:** one tree placed twice, once as SQLite and once as JSONL, holds
the same root; reformatting the CSV of a placed collection publishes nothing.

### 4. Row operations and field-level merge

**State (2026-10-24, on the branch):** built in the logical form. Row
operations replay on logical tables (`collection-schema/src/row-replay.ts`),
`collection-fields-v1` merges by row and field, field choices are kept and
resolved, the host refuses an `at` too far ahead, and Story Sync emits row
operations for edits made anywhere (`row-diff.ts`). Operations name a
`model` and field choices a `{model, key, field}`, as the spec spells them,
in TS and Swift with vectors. Tests: `tests/integration/overstoryd/row-acceptance.test.ts`,
`tests/unit/protocol-updates/row-operations.test.ts`, and the games example
in `tests/integration/collection-placements.test.ts`. Not done:
- A change whose trace mixes row frames with text frames (10 §4.1 allows
  separate frames) is refused by the sidecar as unsupported. No client sends
  one yet.
- Swift's row-change kind went to People 001's phase 0 with the native step.
- Presented-view edits (`usl/src/present.ts`, StoryKit `PresentedView`) still
  name layout tables; they are 002's to rework.

What it does:

**Spec.**
- Spec 10 §4 adds `rowInsert`, `rowDelete`, `rowSet {table, key, field,
  before, value}`, `rowConnect`/`rowDisconnect {table, key, field, member}`
  and `rowMove {table, key, field, member, after}` (an `@ordered` sequence).
  A row operation names its collection by logical path and model, never by
  bytes or layout table.
- Spec 01 §1.2.3 and 10 §6: a decision may be scoped to a row field.
  `Decision.affected` gains a row selector (`{path, table, key, field}`), and
  alternatives may be field values, not just text, file, directory, tree or
  absent.
- `created`/`modified` are host-stamped at acceptance, never set by an
  authored operation, and excluded from no-op detection; only those two are
  special, so user-declared timestamp fields are kept.

**Code.**
- Types and grammar: `packages/protocol/src/updates/authored-contract.ts`
  (`AuthoredOperation`, the `operation()` switch) and Swift
  `ProtocolAuthoredContract.swift`'s `validate` switch.
- Replay: a collection evaluator beside the source edits in
  `protocol/src/updates/source-trace.ts`, shared by client and host.
  `overstoryd`'s fast path (`checkPlainTrace`) may accept traces of only row
  operations on uncontested collections.
- The sidecar: `overstoryd-merge/src/intent-model.ts` `checkTrace` has a
  hard-coded allow-list, and `intent-engine.ts` treats `_store.csv` as text.
  Row operations get their own evaluator, which merges per field:
  - a single value conflicts only when both sides set different values;
  - many-valued fields merge per member;
  - `@ordered` fields merge as a sequence; a concurrent move of the same
    member takes the later move, with a merge note;
  - `Markdown` fields merge by lines, reusing `mergeLines` in `merge-rules.ts`.
- Snapshot path: `collectionFileRowsV1` becomes field-wise as a new revision,
  `collection-file-fields-v1`, so old history keeps its meaning (10 §7). Add
  the rule name to `MergeSummary` and to the evidence.
- Decisions: `LogDecision` (`packages/merge-protocol/src/index.ts`) and the
  engine's `IntentDecision` gain a row-field scope. Resolution guards in
  `overstoryd/src/updates/merge-history.ts` and `AlternativeBinding` accept it.
- Clients:
  - TS: story-sync emits row operations, including for edits made outside
    Story (it diffs decoded rows locally instead of publishing
    `trace: null`).
  - Swift: a row-change kind in `UpdateCoordinator`, now in People 001's
    phase 0.

- Merge and replay cost for a large collection moved to
  [Performance 004](../../later/performance-004-provenance-index.md) step 6
  (Joe, 2026-10-24: combine it with the other merge improvements).

**Done when:**
- Two clients edit different fields, and different members, of one row
  offline and both edits land.
- The same field edited twice gives a decision scoped to that field, which a
  resolution closes.
- A `games.usl` collection projected as files holds one `<Table>.jsonl` per
  table of its file layout and passes `usl verify`.
- Conformance vectors cover the operations, the logical form and field
  decisions in both stacks.

### 5. SQLite placements that sync through Story Sync

Built on the branch as "SQLite databases sync as rows" (002's milestone 2);
rework it so the database is a projection rather than the tree's content.

- apps-runtime already has the pieces: `SQLiteStoreBroker` (`src/observer.ts`),
  whose TEMP triggers write `__arbor_changes` with per-row before/after JSON;
  a persistent cursor and `__arbor_mutation_receipts`; and
  `setupSql(tables, "sqlite")` in usl.
- A device applies accepted row operations from the host into its local
  projection, and turns local changes the broker's triggers record into row
  operations. It rereads only changed rows; a full scan stays the fallback
  after an unobserved write. A device that has missed history rebuilds from a
  host-served row export.
- Inserts and deletes, which the provider lacks, go through row operations.
- Story Sync is the device that syncs collections. Story on Mac and iPhone
  carries them intact (milestone 3) but doesn't read or write rows offline;
  that moved to [People 001](../../later/people-001-directory-and-go-to.md)'s
  phase 0, built only if its proofs still need it (Joe, 2026-10-24).

**Done when:**
- `examples/supplies/data/_store.sqlite3` is edited on two devices; both edits
  merge per milestone 4's rules and both copies hold the same rows and hash.
- An edit made with the `sqlite3` command line is picked up and published.

### 6. Rows on the host

002's §2a, unchanged in substance and now just the host's own projection
(004 "Where placement choices live"). People 001 doesn't need it; host
queries and mutations do.

**The rule:** the accepted tree stays canonical. Everything below is derived
from it, can be dropped and rebuilt from it, and never changes what a root
means.

**How overstoryd does it** (as of 2026-10-15, overstoryd keeps one WAL
SQLite, `overstoryd.sqlite3`; acceptance is serialized per tree by
`withTreeLock`; derived indexes such as `entry_metadata` and `tree_policy`
are prepared before and written inside `acceptedStore.commit`'s
`withinTransaction` hook; the `/queries` and `/mutate` routes exist but no
runtime is wired in):

1. **One file per collection, a cache of accepted state.**
   `<dataRoot>/materialized/<tree>/<collection>.sqlite3` holds the schema's
   database layout and a meta row `{ schemaFingerprint, appliedThrough }`,
   the `accepted_updates` ordinal it reflects. It is never backed up,
   retained or audited, and can be deleted at any time. It is a separate
   file because a WAL database can't commit atomically with another, and
   because it is disposable.
2. **Catch-up, not two-phase commit.** After a commit, still holding the
   tree lock, overstoryd compares the new root's collection hashes with the
   ones at `appliedThrough`: unchanged tables (or chunks) are skipped,
   changed ones are diffed row by row and applied with the new
   `appliedThrough` in one transaction. Diffing results rather than trusting
   intents covers every kind of acceptance (row operations, snapshots,
   merges, resolutions). A reader whose `appliedThrough` is behind the
   tree's ordinal catches up first; after a crash it catches up or rebuilds.
   A schema change rebuilds.
3. **Lifecycle.** Built on first use by a query, mutation or activated app
   binding; evicted when idle under a disk budget; rebuilt on next use.
4. **Queries** (07 §4, §12.1) run on the file through apps-runtime's
   `SQLiteQueryEngine`, with `observedThrough` = `appliedThrough`, and the
   catch-up's row changes drive live invalidation.
5. **Mutations** (07 §5, §12.2) take the "compute against a snapshot and
   submit an ordinary update" path: the handler runs in a transaction on
   the file at ordinal U, the broker's triggers record its effects
   (cascades included) as row operations, the transaction rolls back, and
   the operations go in as one update whose `change` comes from the request
   digest (so an exact retry is the same change), guarded on U. Accepted, it
   is caught up like any update and the receipt names it; a failed guard
   catches up and reruns, a bounded number of times. So mutations, devices
   and Story share one history, merge and authorization path. To keep
   unrelated edits from forcing reruns, the guard should be scoped to the
   rows the handler read rather than the whole tree (a spec 01/07 addition).
6. **Open field decisions:** queries see the projected value.

**Done when:**
- A named query over Supplies runs on the host without loading table files,
  and a subscriber sees a device's edit.
- A named mutation commits as an accepted update that both devices' databases
  receive, and its retry returns the same receipt.
- Dropping the host materialization and restarting rebuilds it to the same
  rows.

## Landing the branch

`claude/project-thread-6kt6l8` holds milestones 4, 5 and the StoryKit port in
their pre-004 form, plus 002's presented views (`presentView`, its StoryKit
port and `presented-views.json`). Rework on the branch and merge to main a
milestone at a time. The presented views are pure functions over rows; they can
land with milestone 4 once their vectors use the logical form, or stay on the
branch until 002 resumes.

## Invariants

- Representation is a placement's choice and never changes a root.
- Every edit is a row operation that the schema can validate before it is
  published.
- Merge follows arity (README): a row is a set of tuples, many-valued fields
  merge member by member, `@ordered` fields as sequences, `Markdown` by lines.
- A host's projection can be dropped and rebuilt from accepted state.
