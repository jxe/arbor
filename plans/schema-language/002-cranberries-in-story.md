# Schema language 002: cranberries documents in Story

**Why and when:** Joe asked on 2026-10-13 whether cranberries could live in
Story, so that the MAI excellences document and supplies-remake run natively
in Story.app on the Overstory data model, whose collections are declared in
`schema.usl` ([schema language](../../docs/overstory-spec/11-schema-language.md)). The design history is in the project
thread "Cranberries in Story" and its sketch.

## Status

- **Effort:** XL, in milestones.
- **Risk:** HIGH. It needs field-level merge, which changes the merge
  protocol, and a new kind of editing surface in Story.
- **State:** PLANNED.
- **Depends on:** nothing.
- **Unblocks:** porting excellences and supplies-remake off Supabase.

## Joe's decisions

- An arrangement lives on a collection (its schema's `@@views`) and on pages
  that present collections kept elsewhere (`view "…" of path { … }`); a
  collection with neither gets a default arrangement. Views in a schema are
  defaults a page may override.
- People are Story accounts: the `Person` model, stored as profile ids.
- The editor is native (Swift and Quagmire), not cranberries' React in a web
  view.
- The merge tool and merge protocol are extended for field-level and
  database merges.
- SQLite will be the most common representation.
- Eventually a placed tree has a local copy of the data and a visitor uses the
  host, and it's hard to tell which. Not needed for this plan.

Settled on 2026-10-15 (discussion notes in the project thread "Cranberries in
Story"):

- **Ownership** is access policy, not schema: it must also work on pages
  that aren't rows (front matter `authors`). `access.yaml` gains a property
  subject, `who: {property: authors}`, matching the profiles in that property
  of the node being changed, judged on its current accepted state. One
  predicate, `unless`/`when: {property: x}` (non-empty), covers "anyone may
  edit unowned rows" and Supplies' `openToEdits`; try it and revisit.
  `@@editableBy` leaves USL. No special rule for editing `schema.usl`.
- "Anyone signed in" is the host's community group; no new subject.
- **Identity and sign-in** (people without accounts, invites, passkeys) wait
  for Overstory's own identity work.
- **Row operations** (set with the value seen, connect, disconnect, create,
  delete, move) join the source operations of spec 10, so row edits ride the
  ordinary updates route. Merge is per field by the schema's arity rules; a
  field conflict keeps both values for someone to pick.
- **Databases in tree roots** get a logical hash computed from rows, the same
  for every representation. Start with a multiset hash (LtHash): O(1) per row
  change, no tree objects; replicas catch up from row operations. A prolly
  tree only if syncing large tables ever needs tree diffs.
- `created` and `modified` stay stored, in files too: stamped by the host at
  acceptance; `created` never changes and `modified` merges to the later
  value, so they never conflict.
- A schema with several data models stored as files uses one
  `<Table>.jsonl` per table.
- A row may be its own Markdown file: a field named `content` (`Markdown`) is
  the body, `title` is the page title, everything else is front matter.
- Order of an unordered connection's members is configurable in the schema
  or view, defaulting to creation order.
- **The editor** is a separate structured-data editor in the quagmire repo,
  not record blocks inside Quagmire's block model. A view is its own kind of
  page in Story first; embedding in a Quagmire page (one opaque block) comes
  later. Share text-cell code with Quagmire only once it's needed twice.
- In a view: dragging a row to another group changes its group; a
  connection group's heading edits that row's name (choice groups and
  "Unassigned" are read-only); Delete in a connection group disconnects, in a
  flat or choice-grouped view it deletes, and "Delete row" always deletes,
  naming the other groups; a `Markdown` field in a table row expands inline,
  and a row stored as a Markdown file opens as its page.
- View state (tab, collapsed groups) is the client's own.
- No web views yet.

## Target result

A folder whose `schema.usl` has `@@views` opens in Story as an arrangement:
one line per row, grouped by each view's field, so a row appears under every
group it belongs to, with a colored bullet and chips for connections. Editing
a line changes the row; adding a line under a group connects the new row to
that group. Two people editing the same row at once merge field by field and
member by member. The excellences document and a supplies-remake game list
run this way, backed by files or SQLite, with the same content they have on
Supabase today.

## Milestones

Data first, then the screen on top of it, then the people and sites that use
it. Milestone 3 has no dependency on 2 and can run beside 1–2; milestone 5
can land any time before 6.

### 1. Row operations and field-level merge

Today a collection edit reaches the host only as a snapshot: story-sync
splices row bytes into `_store.*` (`state/collection-file-writes.ts`
`replaceCollectionFileRow`) and `folder-sync.ts` publishes `trace: null`. The
host merges whole rows (`tree-merge/src/merge-rules.ts` `collectionFileRowsV1`,
equal when `stableJSONString(properties)` matches), and a row conflict becomes
a decision on the whole collection directory (`overstoryd-merge/src/snapshot.ts`
walks the synthetic `;overstory-key=` path up to the parent). Nothing merges
`@ordered`, many-valued or `Markdown` fields.

**Spec.**
- Spec 10 §4 adds `rowInsert`, `rowDelete`, `rowSet {table, key, field,
  before, value}`, `rowConnect`/`rowDisconnect {table, key, field, member}`
  and `rowMove {table, key, field, member, after}` (an `@ordered` sequence).
  A row operation names its collection by logical path and table, never by
  bytes.
- Exact replay (10 §2) can't hold for row operations as written: the
  collection's `childSetHash` sits in the parent directory object, which no
  operation edits. Rule: replaying a row operation re-derives the collection's
  representation and descriptor deterministically (canonical encoding, as
  `encodeProtocolCollectionFile` already does), and the frame's `after` must
  equal that. The client computes the same and the host verifies it.
- Spec 01 §1.2.3 and 10 §6: a decision may be scoped to a row field.
  `Decision.affected` gains a row selector (`{path, table, key, field}`), and
  alternatives may be field values, not just text, file, directory, tree or
  absent.
- Spec 11 §7 and 06 §2.4: the data-file layout keeps `created`/`modified`.
  Today `layoutOf(…, {store: "files"})` drops every `timestamp` column
  (`packages/usl/src/layout.ts`), which also drops user-declared timestamp
  fields; only the two system columns should be special. They are host-stamped
  at acceptance, never set by an authored operation, and excluded from no-op
  detection.
- Spec 06 §2.4: a schema with several data models is stored as one
  `<Table>.jsonl` (or `.csv`/`.json`) per table; `_store.*` remains the
  single-table form. This lifts `collection-tables`.
- Spec 02/06: a row that is its own Markdown file maps a `content Markdown`
  field to the body and `title Text` to the page title (its first H1, per 02
  §4); everything else is front matter. A `content` field of another type is a
  diagnostic.

**Wire and object changes.**
- `CollectionFileDescriptor` (`packages/protocol/src/model/node-model.ts`,
  Swift `ProtocolObjects.swift`) is single-table: `source` is one of the
  `_store.*` names and it carries one `childSetHash`. It needs a form with one
  entry per table (table name, file, `childSetHash`), decoded strictly in both
  stacks, with new conformance vectors.
- `packages/fs/src/protocol-tree.ts` (which throws on a second collection
  file) and `story-sync` discovery (`state/providers/discovery.ts`) learn
  `<Table>.*` folders.
- `packages/collection-schema` returns one schema per table instead of exactly
  one (`compile.ts` enforces `collection-tables` at line ~111), and there is
  one decoder: `usl/src/verify/files.ts` already reads multi-table folders but
  duplicates the collection-schema decoder and validator. Keep
  collection-schema's and have verify use it.

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
  Row operations get their own evaluator, which decodes base, current and
  candidate rows, applies each side's operations and merges per field:
  - a single value conflicts only when both sides set different values;
  - many-valued fields merge per member;
  - `@ordered` fields merge as a sequence;
  - `Markdown` fields merge by lines, reusing `mergeLines` in `merge-rules.ts`.
- Snapshot path: `collectionFileRowsV1` becomes field-wise as a new revision,
  `collection-file-fields-v1`, so old history keeps its meaning (10 §7). There
  is no rule registry today: overstoryd's `rules()` always sends `tree-default`
  rev 1 and the sidecar accepts only that. Add the rule name to `MergeSummary`
  and to the evidence.
- Decisions: `LogDecision` (`packages/merge-protocol/src/index.ts`) and the
  engine's `IntentDecision` gain a row-field scope. Resolution guards in
  `overstoryd/src/updates/merge-history.ts` and `AlternativeBinding` accept it.
- Clients:
  - TS: story-sync's file provider emits row operations instead of splicing
    bytes and publishing a snapshot.
  - Swift: `UpdateCoordinator` gains a row-change kind beside
    `appendStructure` (`UpdateCoordinator+LocalChanges.swift`), so Story can
    send row operations once milestone 4 needs them.

**Done when:**
- Two clients edit different fields, and different members, of one row
  offline and both edits land.
- The same field edited twice gives a decision scoped to that field, which a
  resolution closes.
- A `games.usl` folder holds `Game.jsonl`, `List.jsonl` and
  `List_games.jsonl`, and passes `usl verify`.
- Conformance vectors cover the operations, the descriptor and field
  decisions in both stacks.

### 2. SQLite placements that sync

Nothing syncs SQLite between devices today. A tree carries `_store.sqlite3`
as an opaque file. story-sync's `SQLiteProjectionDriver`
(`state/providers/sqlite-provider.ts`) only reads, plus single-row updates.
apps-runtime already has the pieces:
- `SQLiteStoreBroker` (`src/observer.ts`), whose TEMP triggers write
  `__arbor_changes` with per-row before/after JSON;
- a persistent cursor, and `__arbor_mutation_receipts`;
- `setupSql(tables, "sqlite")` in usl.

**Spec.**
- 06 §1.1 and §3 forbid "a whole-database hash … by hashing all rows", and
  Postgres 002 rejects whole-database revisions because rereading is
  unbounded. A multiset hash kept up to date inside each write transaction
  answers that objection, but both texts must change explicitly:
  - a database collection's logical hash is the sum, in the LtHash group, of
    canonical CBOR row hashes per table, combined with the schema fingerprint;
  - it is never recomputed by scanning, except to recover after an external
    write.
- The same logical hash applies to file-backed collections, so a CSV, JSONL
  and SQLite holding the same rows hash the same, and 06 §7's migration keeps
  the digest. Postgres 005's representation-equivalence work should adopt it.
- This also closes spec README deferred item 5 (the database change log and
  checkpoint format): the change log is the accepted row operations, and the
  checkpoint is the logical hash.

**Code.**
- A `database` variant of the children descriptor, carrying the schema
  fingerprint and the logical hash, feeds `ModelHashes.compute`
  (`tree-merge/src/model-hash.ts`) where `childSet` goes for collection files.
- The hash is maintained in SQLite in the same transaction as each
  runtime-owned write:
  - a `__overstory_hash` table holds one 2048-lane value per table;
  - each insert, update or delete subtracts the old row's hash and adds the
    new one;
  - external writes seen by the broker's triggers are folded in the same way.
- Inserts and deletes, which the provider lacks, go through the row
  operations.
- A device applies accepted row operations from the host into its local
  SQLite. A device that has missed history rebuilds from a host-served row
  export.
- Use one published LtHash construction and specify it in conformance
  vectors, in TS and Swift.

**Done when:**
- `examples/supplies/data/_store.sqlite3` is edited on two devices; both edits
  merge per milestone 1's rules and both copies hold the same rows and hash.
- An edit made with the `sqlite3` command line is picked up and published.

### 3. Presented views

`presentPage` lives in `packages/protocol/src/documents/page-presentation.ts`,
with inverse `authorPage` and tests in `tests/unit/page-presentation.test.ts`.
Its Swift counterpart is `StoryPagePresentation` in StoryEditor, working on
Quagmire blocks. Only the TS USL checker resolves views:
`ResolvedModel.views` holds `ResolvedView {label, line: LineItem[], group,
sort}` (`packages/usl/src/check.ts`). Nothing in Swift parses `schema.usl`
(`WorkingTree.collection(for:)` only counts store-file lines).

**TS.**
- `presentView(schema, rows, view)` in `packages/protocol` (beside
  `presentPage`) takes the resolved model and layout and returns tabs, groups
  (id, heading, kind: connection, choice or unassigned), lines (row key,
  occurrence id, cells) and per-row capabilities.
- Cells are text, Markdown (first paragraph), chips (members with display
  names) and choice (with color, `@bullet`).
- The inverse maps intents to milestone 1's row operations:
  - set field;
  - connect, disconnect;
  - create in group (preset the forward field, or connect the reverse owner);
  - delete;
  - move within an `@ordered` group;
  - move to another group.
- The default arrangement: the line is the fields in order, with one grouping
  per fixed model, connection or `Person` field. The order of an unordered
  connection's members comes from the view, defaulting to creation order.
- Port from cranberries' `src/model.ts`, which is pure:
  - `groups` (flat, field and reverse-relationship grouping, "Unassigned");
  - `sortGroups`;
  - `search`;
  - `newEntity`;
  - `apply`;
  - `checkValue`/`validate`.

  `canEdit` doesn't port; ownership is milestone 5.

**Swift.** Story needs the schema natively. Port `packages/usl`'s parser,
checker and layout to StoryKit, which has no dependencies today. That's
about 2,000 lines of TS. Native offline validation of collections
(Apps 010) needs it too. Then port `presentView`. Run both stacks against
shared conformance vectors (schema, rows, view → presentation), as
`presentPage` does.

**Done when:** `games.usl` and `excellences.usl` with their data present
identically in both stacks, and every intent round-trips to row operations
that `usl verify` accepts.

### 4. The structured editor

**Product.**
- A new library target and product in the quagmire repo (`QuagmireRecords`,
  say), added to `scripts/verify.sh` and to the public-API test targets.
- It's host-neutral by Quagmire's own rule: no USL, no storage, no paths.
- Input: a presented view (milestone 3's shape, in the editor's own types),
  per-row and per-cell capabilities, and per-cell conflicts.
- Output: intents.
- Host seam: like `EditorHost` (`persistCommit` plus `flush`). The host
  applies intents as row operations and hands back the re-presented view.
- The editor reconciles the new presentation without losing the focused cell,
  selection, scroll or expanded groups.

**Behavior** (from cranberries' `src/react.tsx`, plus Joe's decisions):
- **Layout:**
  - view tabs;
  - group headings that collapse;
  - one line per occurrence, keyed by view, group and row, so the same row
    shows under several groups and edits go to the one row.
- **Adding:** a draft line under a group searches existing rows to connect,
  or creates one.
- **Cells:**
  - chips are added through a picker (cranberries' checkbox menu);
  - a `@bullet` choice is a colored dot with a menu, and also colors the line;
  - Markdown shows its first paragraph and expands inline.
- **Editing:**
  - a connection group's heading edits that row's name;
  - drag to another group changes the group;
  - drag inside an `@ordered` group writes positions;
  - Delete disconnects in a connection group and deletes elsewhere;
  - "Delete row" names the other groups first.
- **Read-only and conflicts:** read-only rows look locked; a cell with a
  field conflict shows both values to pick from.
- **Search:** a search box.
- **No longer needed:** cranberries' "Download my draft" banner, since
  conflicts are kept, not refused.

**What to share with Quagmire, when it's needed twice.** These separate
cleanly into a shared internal target:
- `EditorTheme`;
- the inline marks (`InlineMarksBridge`, `InlineAttributes`);
- `Feedback` (haptics, sounds, and its resource bundle);
- the mention trigger, search and row;
- `RowSurface` with `ReorderDropResolver`, which is deliberately
  content-agnostic.

`BlockTextEditor` (1,900 lines) and the mention orchestration are bound to
`BlockID`, `Document` and `EditorView`. They need a generic focus ID and
callbacks before a cell can reuse them, so a first version may use a plain
text field.

**Story.**
- `WorkspaceSurface.collection(kind:rowCount:)` (StoryKit
  `WorkspaceModels.swift`) gains the resolved schema and views.
- `WorkspaceSurfaceView` in `StoryRootView.swift` renders it with the new
  editor instead of two labels.
- A collection session beside `WorkspaceDocumentSession` sends row
  operations through milestone 1's `UpdateCoordinator` row-change kind.
- Release: a Quagmire minor version. Pins in `swift/project.yml` and
  `swift/Packages/StoryEditor/Package.swift`. Quagmire's `AGENTS.md` still
  names the old `native/` paths; fix it in passing.

**Done when:** Joe edits a games collection in Story on two devices, with
groups, chips, bullets, drag and inline Markdown, and the edits merge per
field.

### 5. Ownership

Today:
- Access is whole-tree for device callers. `AccessControl.canWrite` checks at
  `/` (`packages/overstoryd/src/access.ts`), and narrow operations are
  consulted only for executions.
- `resource-effects.ts` sees file paths: a collection-file row edit is
  `update-content` of the whole file, and a front-matter edit is `write`.
- `ResourcePolicyContext` (`packages/protocol/src/model/resource-policy.ts`)
  has no node or state.

**Spec 05.**
- `who: {property: authors}` matches the profiles in that property of the node
  being changed: a row, or a page's front matter. For a new child, it's the
  parent's property. It's read from current accepted state at acceptance.
  Entries that aren't profile TreeIDs or locators match nobody, and a group
  counts through its members.
- `unless`/`when: {property: x}` (non-empty) is the one row predicate.
- "Anyone signed in" is `{profile: <community TreeID>}`. The community is the
  group profile at the host's canonical `/`, and `isGroupMember` already
  counts enabled accounts.
- **Guard:** changing a property that a rule's subject or predicate names
  requires that the caller currently matches that rule, or is an
  administrator. Without it, anyone who can write a row grants access by
  editing the field. Precedent: `tree-config-policy.ts`
  `authorizePersonConfigTransition` checks each field against the base.
- Where a schema exists, a rule naming a property that isn't `Person` or
  `Person[]` is a configuration diagnostic.

**Code.**
- Parsing and validation: `parseWho`/`parseResourceRule` (which refuse
  unknown keys) and the Swift `ProtocolResourceWho` and
  `ProtocolResourceAccessRule`.
- `ResourcePolicyContext` gets a `propertyProfiles(path, name)` callback over
  current state.
- Effects become semantic: row operations give exact `(row, field)` effects,
  and front-matter edits give property effects instead of `write`. Device
  updates are then authorized by effect, not only by whole-tree `canWrite`.
- Conformance: `resource-policy.json` gains valid and invalid property rules.
- Remove `@@editableBy` from USL (`check.ts` `editableBy`, spec 11 §5), from
  `games.usl`, and from cranberries' `documentFromUsl`.

**Done when:** in a shared games tree, an author edits only their own games,
anyone in the community edits unowned ones, and nobody but an owner or
administrator changes `authors`.

### 6. Port the two sites

- An importer reads cranberries' snapshot (`GET /api/cranberries`, or the
  `remake` tables) into a tree:
  - `games.usl` with JSONL or SQLite;
  - `excellences.usl` likewise;
  - `created`/`modified` carried over from cranberries' stamps;
  - `@ordered` positions from `List_games.games_position`.
- Check with `usl verify`, then present the result next to the live site and
  compare.
- **Blocked on identity.** Most authors and leads have no Story account.
  Until Overstory's identity work gives them profiles, port `Person` fields
  as plain text, or hold the port.

### 7. Pages that present other collections

- A page carrying `view "My games" of ../Games/Game { group: status }` shows
  that view, using milestone 3 with the page's override, and edits go back to
  the source collection's tree.
- It needs relative collection resolution (06 §6) and authorization against
  the source tree.
- Embedding the structured editor in a Quagmire page as one opaque block
  that hosts a host-supplied view.
- Public and web views stay out of scope until Joe wants them.

## Invariants

- One record, many groups: grouping is never stored, and an edit made under
  any group changes the one row.
- Every edit is a row operation that the schema can validate before it is
  published.
- Presentation never changes data: a view, a page's override or a default
  arrangement only chooses what is shown.
- Data never grants access by itself: a property subject only matters
  through a rule an administrator accepted.

## Interaction with presence (Sharing 003)

Presence names a page by its logical path and a caret as a byte range in a
file object. A presented view's page is the collection folder (or the page
that presents it), so the roster works unchanged. A caret in a view is in one
field of one row, and a row in SQLite has no file object, so the editor
needs a second selection kind, such as `{ row: { table, key }, field, anchor,
head }`, with offsets into that field's text. That is easiest if Sharing 003's
phase 1 makes `PresenceSelection` extensible (a `kind`, or decoders that skip
an unknown selection) rather than fixing the byte-range shape.

## Open questions

1. Is "property non-empty" the right size for `unless`/`when`? Revisit after
   Supplies and excellences use it.
2. Exact replay for row operations: is "the host re-derives the
   representation and descriptor deterministically, and `after` must equal
   it" the right amendment to spec 10 §2, or should row operations carry no
   candidate bytes at all for collections?
3. The Swift schema: port `packages/usl` to StoryKit (proposed), or have the
   sync helper hand Story a compiled schema (layout plus resolved views)?
4. Does Postgres 002 adopt the logical multiset hash too, or stay with
   observation only?
