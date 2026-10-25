# Schema language 002: cranberries documents in Story

**Why and when:** Joe asked on 2026-10-13 whether cranberries could live in
Story, so that the MAI excellences document and supplies-remake run natively
in Story.app on the Overstory data model, whose collections are declared in
`schema.usl` ([schema language](../../docs/overstory-spec/11-schema-language.md)). The design history is in the project
thread "Cranberries in Story" and its sketch. On 2026-10-22 Joe split the
data half out as Schema language 005: collections that sync ([status](../../status.md#collections-that-sync--2026-10-24)),
to do first; this plan keeps the database views (presenting, editing and
embedding collections in Story), ownership and the two site ports, for later.
On 2026-10-24 Joe made the [People directory](people-001-directory-and-go-to.md)
this plan's first customer: People is presented and edited with these views
rather than hand-built screens, so the database views get proven on something
Joe uses daily. Milestones 3, 3a, 4 and 7 come first, each built with what the
directory needs (listed in each); ownership (5) and the site ports (6) follow.

## Status

- **Effort:** XL, in milestones.
- **Risk:** HIGH. A new kind of editing surface in Story, and access rules
  that read row data.
- **State:** milestone 3 mostly done (read-only views on the Mac, 2026-10-25,
  [status](../../status.md#collections-in-story-on-the-mac--2026-10-25)); 3a is
  [Schema language 007](../soon/schema-language-007-edit-rows-in-story.md), in soon; 4 to 7
  are not started. Milestones 1, 2 and 2a moved to 005 (as
  its milestones 4, 5 and 6); the numbers here are kept so earlier references
  hold.
- **Depends on:** 005 ([status](../../status.md#collections-that-sync--2026-10-24)), on main since 2026-10-24:
  row operations, field-level merge, logical collections, the layered USL and
  its StoryKit port.
- **Order:** 3, 3a, 4 and 7 for the directory, then 5 and 6.
- **Unblocks:** [People 001](people-001-directory-and-go-to.md) (after 3, 3a, 4
  and 7); porting excellences and supplies-remake off Supabase.

## Joe's decisions

The decisions about data (row operations, merge, hashing, timestamps,
multi-table folders, SQLite) were 005's and are now in the spec. These are about views, editing and
access:

- An arrangement lives on a collection (its schema's `@@views`, `~views` in
  003's syntax) and on pages that present collections kept elsewhere
  (`view "…" of path { … }`); a collection with neither gets a default
  arrangement. Views in a schema are defaults a page may override.
- People are Story accounts: the `Person` model, stored as profile ids, or as
  `contact:<key>` placeholders for people without one (spec 11 §3, Joe 2026-10-24).
- The editor is native (Swift and Quagmire), not cranberries' React in a web
  view.
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

A folder whose `schema.usl` has views opens in Story as an arrangement:
one line per row, grouped by each view's field, so a row appears under every
group it belongs to, with a colored bullet and chips for connections. Editing
a line changes the row; adding a line under a group connects the new row to
that group. Two people editing the same row at once merge field by field and
member by member (005). The excellences document and a supplies-remake game
list run this way, backed by files or SQLite, with the same content they have
on Supabase today.

## Milestones

The screen first, then the people and sites that use it. Milestone 5 can land
any time before 6; 7 needs only 3 and 4. The directory needs 3, 3a, 4 and 7.

### 3. Presented views

**Done in part (2026-10-25,
[status](../../status.md#collections-in-story-on-the-mac--2026-10-25)):** Schema language 006 built the TS
`presentView` and its StoryKit port on main, the shared vectors, and Story's read-only view on
the Mac. What is left here: the directory's needs below (an arrangement menu, `sort` on a date,
read-only groups the host supplies), and fields a client styles today that a schema can't set
(the bullet tinting the title, Markdown as a note). `PresentedView` doesn't say which chips
and groups are people, so Story guesses from a TreeID or the placeholder flag; give cells and
groups their field's target type in both stacks and the vectors. The iPhone reads with
[Schema language 007](../soon/schema-language-007-edit-rows-in-story.md) step 0, and editing is
007 and milestone 4. The history below predates that.

`presentPage` lives in `packages/protocol/src/documents/page-presentation.ts`,
with inverse `authorPage` and tests in `tests/unit/page-presentation.test.ts`.
Its Swift counterpart is `StoryPagePresentation` in StoryEditor, working on
Quagmire blocks. This milestone is where Story.app (Mac and iOS) first shows
a collection's rows: 005 only makes Story carry collections intact (Joe,
2026-10-24). On main, only the TS USL checker resolves views:
`ResolvedModel.views` holds `ResolvedView {label, line: LineItem[], group,
sort}` (`packages/usl/src/check.ts`). Nothing in Swift parses `schema.usl`
(`WorkingTree.collection(for:)` only counts rows: from a one-table
collection reference on the 005 branch, else from store-file lines).

**TS.**
- `presentView(schema, rows, view)` in `packages/protocol` (beside
  `presentPage`) takes the resolved model and layout and returns tabs, groups
  (id, heading, kind: connection, choice or unassigned), lines (row key,
  occurrence id, cells) and per-row capabilities.
- Cells are text, Markdown (first paragraph), chips (members with display
  names) and choice (with color, `@bullet`).
- The inverse maps intents to 005's row operations:
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

Note that `packages/protocol` depends only on `@noble/hashes` and `yaml`, not
on `@ovst/usl`. Either protocol takes that dependency, or `presentView` lives in
`packages/usl/src/present.ts` and protocol keeps only the presentation types.
The second keeps protocol free of the schema language.

**Swift.** Port `presentView` to StoryKit, on top of 005's StoryKit port of
`packages/usl`. Run both stacks against shared conformance vectors (schema,
rows, view → presentation), as `presentPage` does.

**For the directory:** an arrangement with several groupings chosen from a
menu (By group, Recent, By host), a `sort` on a date field (Recent), and
read-only groups the host supplies alongside the rows (each host community,
collapsed, never copied), shown with the same line shape.

**Done when:** `games.usl` and `excellences.usl` with their data present
identically in both stacks, and every intent round-trips to row operations
that `usl verify` accepts.

### 3a. Rows in Story on Mac and iPhone

Being built first as [Schema language 007](../soon/schema-language-007-edit-rows-in-story.md)
(Joe, 2026-10-24); what it leaves folds back here.

Moved from People 001's phase 0 on 2026-10-24 (before that, from 005
milestone 5), and now needed: the structured editor sends row operations from
Story itself, and the directory must work on the iPhone, which has no Story
Sync.

- Story on Mac and iPhone reads and writes logical collections offline with no
  Story Sync in the path: a native projection (SQLite, which iOS has) built
  from the logical form, validated with the StoryKit USL port, and fed by a
  row-change kind in `UpdateCoordinator` beside `appendStructure`
  (`UpdateCoordinator+LocalChanges.swift`). 005 milestone 3 already makes
  native working trees keep a collection's tables and rows.
- It covers [Apps 010](apps-010-native-offline-collection-file-projection.md)
  (rows readable offline on native), which can then be deleted.

**Done when:** a collection edited offline on the iPhone and on the Mac merges
when both reconnect.

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

**Hard parts, from Quagmire's text editing.**
- **Focus across cells.** Quagmire mounts one live text view per page; every
  other row is `Text` (`EditorView.swift:813`). Tab from cell to cell needs
  its keep-the-keyboard-up handoff (`iosTransitioningEditorID`), keyed by
  occurrence and cell, and macOS Tab arrives as keyCode 48 while iOS uses key
  commands and the accessory bar.
- **Host updates while typing.** On an external change `BlockTextEditor`
  reloads the text storage wholesale and drops the caret; only undo maps the
  caret (`caretRangeAfterTextReplacement`). The cell editor must map the caret
  for every host update, and the focused cell's live text wins until its
  checkpoint commit (about 750 ms, or blur). Keep Quagmire's
  `lastKnownBindingPlain` and `textStorageDirty` guards, which exist for
  exactly this echo. `sort: modified` mustn't move the row being edited until
  you leave it.
- **Stable ids.** `RowSurface` caches heights by id, so occurrence ids must
  be stable across re-presentations or the scroll position jumps.
- **Undo** is the inverse intent from the `before` values the host already
  has, not Quagmire's snapshot undo.
- **Per-row locks** are new: Quagmire's read-only is one page-level boolean,
  so tap, focus, Tab-skip and drag all need gating.

**Story.**
- `WorkspaceSurface.collection(kind:rowCount:)` (StoryKit
  `WorkspaceModels.swift`) gains the resolved schema and views.
- `WorkspaceSurfaceView` in `StoryRootView.swift` renders it with the new
  editor instead of two labels.
- Routing: `StoryAppModel.load` (around `StoryAppModel.swift:2460`) treats a
  collection as a sidebar base and leases an editor only for document
  surfaces. It needs a collection branch that leases the view session, a
  field on its cached `PagePresentation`, and a branch in
  `StoryRootView.pageFrameContent` before the `WorkspaceSurfaceView`
  fallback. `WorkingTree.collection(for:)` and `WorkingTreeProvider` detect
  `schema.usl`. `InMemoryWorkspaceProvider` already fakes a collection for
  previews.
- View tabs and the search box sit in Story's chrome. The selected tab and
  collapsed groups are the client's own state.
- A collection session beside `WorkspaceDocumentSession` sends row
  operations through milestone 3a's `UpdateCoordinator` row-change kind.
- Release: a Quagmire minor version. Pins in `swift/project.yml` and
  `swift/Packages/StoryEditor/Package.swift`. Quagmire's `AGENTS.md` still
  names the old `native/` paths; fix it in passing.

**For the directory:** Option-drag (Mac) to add a row to another group while
keeping it in this one; locked headings for groups the viewer can't edit;
unsynced changes shown dimmed; a draft line under a group that can also add a
*new* person as a placeholder; and per-row actions the host supplies (Copy
invite link, Send invite…) with a status cell (not invited, invited, joined).

**Done when:** Joe edits a games collection in Story on two devices, with
groups, chips, bullets, drag and inline Markdown, and the edits merge per
field; and forms a group by dragging three people in the directory on the
Mac and sees it on the iPhone.

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
- No snapshot edits of fine-grained data (Joe, 2026-10-15). A snapshot that
  changes a schema-governed collection, or a SQLite database, is authorized
  only as `write` on that collection's path. A caller whose access there comes
  from a property rule, `unless`/`when`, or a narrower grant must send row
  operations. Clients turn edits made outside Story into row operations
  before publishing: story-sync's folder sync diffs the decoded rows locally
  instead of publishing `trace: null`. So the host never authorizes
  ownership from a row diff, and needs no tree-level mode switch.
- Conformance: `resource-policy.json` gains valid and invalid property rules.
- Remove `@@editableBy` from USL (`check.ts` `editableBy`, spec 11 §5), from
  `games.usl`, and from cranberries' `documentFromUsl`.

- Readers can't read `access.yaml` (spec 05 §4), so Story learns locks from
  an advisory per-node answer: fill `NodeCapabilities.*.writable`
  (`protocol/src/model/node-model.ts:28`), which today only the local
  filesystem and app projections set, from the host's evaluation.
- Every place `@@editableBy` appears today:
  - `packages/usl/src/check.ts`: the attribute list, `editableBy` and the
    `editable-by-person` code;
  - `packages/usl/README.md` and the highlight-query comments;
  - `tests/unit/usl-stores.test.ts` and the `invalid/model-attributes.usl`
    expectation;
  - spec 11's example and attribute table;
  - `packages/usl/examples/games.usl` and `supplies.usl`;
  - `examples/supplies/data/schema.usl`;
  - `plans/soon/schema-language/README.md` and `status.md`;
  - cranberries `src/usl.ts`, which maps it to `owners`. Hand-written
    configs keep `owners`.
- Supplies' rule, `requireListEditor`
  (`examples/supplies/scripts/mutations.ts`: owner, or `openToEdits`),
  becomes two access rules: `{property: owner}`, and the community with
  `when: {property: openToEdits}`.
- `resource-policy.json` covers grammar only today. Add evaluation vectors
  (rule, caller, node properties → allowed) so both stacks agree.

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
- Cranberries has no export command. `readDocument` returns the whole
  snapshot, so a small `cranberries export` that writes it through
  `@ovst/usl`'s `rowsFromRecords` would serve both sites. The games sandbox
  (2026-10-24) was filled this way by a one-off script from the public
  `GET /api/cranberries?document=games`: ids and `modified` kept, `created`
  not carried, people's names, avatars and bios dropped (no Person rows).
- Use excellences' own `lib/schema.usl`, which has the `@fold`s;
  `packages/usl/examples/excellences.usl` has drifted from it, so
  replace the example.
- Check with `usl verify`, then present the result next to the live site and
  compare.
- **People without accounts** become `contact:<key>` placeholders (spec 11
  §3), keyed by their source id, as the games sandbox does; they show by name
  once the directory (People 001 phase 1) holds them.

### 7. Pages that present other collections

- A page carrying `view "My games" of ../Games/Game { group: status }` shows
  that view, using milestone 3 with the page's override, and edits go back to
  the source collection's tree.
- `view "…" of path` is parsed by USL (`ViewDecl`, `ast.ts`) but dropped by
  the checker and specified nowhere, including how a Markdown page carries
  it (a fenced block, or front matter). That's a spec decision first.
- It needs relative collection resolution (06 §6) and authorization against
  the source tree.
- Embedding the structured editor in a Quagmire page as one opaque block
  that hosts a host-supplied view.
- **Groups that are other trees** (for the directory): a grouping whose
  groups are group profile trees and whose members are each tree's
  `members`, edited there. Dragging a contact under a group heading adds the
  person to that group's tree; removing takes them out. The directory keeps
  no copy of membership. This is the same "edits go back to the source"
  rule, with a tree's member list as the source.
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

## Interaction with presence (Live 001)

Presence names a page by its logical path and a caret as a byte range in a
file object. A presented view's page is the collection folder (or the page
that presents it), so the roster works unchanged. A caret in a view is in one
field of one row, and a row in SQLite has no file object, so the editor
needs a second selection kind, such as `{ row: { table, key }, field, anchor,
head }`, with offsets into that field's text. That is easiest if Live 001's
phase 1 makes `PresenceSelection` extensible (a `kind`, or decoders that skip
an unknown selection) rather than fixing the byte-range shape.

## Open questions

1. Is "property non-empty" the right size for `unless`/`when`? Revisit after
   Supplies and excellences use it.
Settled 2026-10-15: replay re-derives the collection's representation and
descriptor deterministically and `after` must match; multi-table folders get a
new descriptor form; `packages/usl` is ported to Swift in StoryKit; Postgres
002 doesn't adopt the multiset hash (revisit with Postgres 004/005).
