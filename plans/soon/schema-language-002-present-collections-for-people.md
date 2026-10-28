# Schema language 002: show collections the way People needs

**Why and when:** Joe asked on 2026-10-13 whether cranberries could live in Story, so that
the MAI excellences document and supplies-remake run natively in Story.app on Overstory
collections declared in `schema.usl` ([schema language](../../docs/overstory-spec/11-schema-language.md)).
The design history is in the project thread "Cranberries in Story" and its sketch. Its first
customer is the [People directory](../features/people-001-groups-sharing-and-go-to.md) (Joe,
2026-10-24): People is presented with these views rather than hand-built screens. The data
(Schema language 005) and the read-only view (006,
[status](../../status.md#collections-in-story-on-the-mac--2026-10-25)) are done. On 2026-10-28
Joe split the work by editing and presenting: editing, including the structured editor, is
[Schema language 007](schema-language-007-edit-collections-in-story.md); this plan is what a
view shows and where it can appear; row ownership is
[Schema language 010](../later/schema-language-010-row-ownership.md) in later.

Formerly "the collection editor, ownership and pages that show collections". Its old
milestone 3 is milestone 1 here (its inverse went to 007 step 6), 3a and 4 are 007, 5 is
010, 6 is [Schema language 008](../later/schema-language-008-port-excellences-and-supplies.md),
and 7 is milestone 2 here.

## Status

- **Effort:** M.
- **Risk:** MEDIUM. Milestone 2 needs a spec decision (how a page carries a view of another
  collection) and authorization against the source tree.
- **State:** TODO. Built so far: Schema language 006's `presentView` in TS and StoryKit with
  shared vectors (`presented-views.json`), Story's read-only view on the Mac and iPhone, and
  People 001 phase 1's summaries over facts.
- **Unblocks:** [People 001](../features/people-001-groups-sharing-and-go-to.md) phase 2, with
  007's editor.

## Joe's decisions

- An arrangement lives on a collection (its schema's `~views`) and on pages that present collections kept elsewhere
  (`view "…" of path { … }`); a collection with neither gets a default
  arrangement. Views in a schema are defaults a page may override.
- People are Story accounts: the `Person` model, stored as profile ids, or as
  `contact:<key>` placeholders for people without one (spec 11 §3, Joe 2026-10-24).
- Order of an unordered connection's members is configurable in the schema
  or view, defaulting to creation order.
- View state (tab, collapsed groups) is the client's own.
- No web views yet.
- Eventually a placed tree has a local copy of the data and a visitor uses the
  host, and it's hard to tell which. Not needed for this plan.

## Milestones

### 1. Arrangements, people cells and styling

Built (2026-10-25): Schema language 006's `presentView` in TS and StoryKit with shared vectors
(`presented-views.json`) and Story's read-only view on the Mac and iPhone; People 001 phase 1's
summaries over facts (spec 11 §8: `rows: field`, `re Person` views, paths through connections,
`~latest`, `~earliest`, `~count`, `~ago`), whose lines are read-only. Left:

- **For the directory:** an arrangement with several groupings chosen from a menu (By group,
  Recent, By host), read-only groups the host supplies alongside the rows (each host
  community, collapsed, never copied) shown with the same line shape, and a label for
  "Unassigned".
- **Fields a client styles today that a schema can't set:** the bullet tinting the title,
  Markdown as a note.
- **People in cells.** `PresentedView` doesn't say which chips and groups are people, so Story
  guesses from a TreeID or the placeholder flag; give cells and groups their field's target
  type in both stacks and the vectors.

**Done when:** `games.usl`, `excellences.usl` and the directory's schema with their data
present identically in both stacks, with the directory's groupings, host groups and people
cells in the vectors.

### 2. Pages that present other collections

- A page carrying `view "My games" of ../Games/Game { group: status }` shows
  that view, with the page's override, and edits go back to the source
  collection's tree (through 007's editor).
- `view "…" of path` is parsed by USL (`ViewDecl`, `ast.ts`) but dropped by
  the checker and specified nowhere, including how a Markdown page carries
  it (a fenced block, or front matter). That's a spec decision first.
- It needs relative collection resolution (06 §6) and authorization against
  the source tree.
- Embedding the view (and, once 007 step 8 exists, the structured editor) in
  a Quagmire page as one opaque block that hosts a host-supplied view.
- **Groups that are other trees** (for the directory): a grouping whose
  groups are group profile trees and whose members are each tree's
  `members`, edited there. Dragging a contact under a group heading adds the
  person to that group's tree; removing takes them out (the drag is 007's
  editor; the grouping and where edits go are this milestone). The directory keeps
  no copy of membership. This is the same "edits go back to the source"
  rule, with a tree's member list as the source.
- Public and web views stay out of scope until Joe wants them.

## Invariants

- One record, many groups: grouping is never stored, and a row shows under every group it
  belongs to.
- Presentation never changes data: a view, a page's override or a default arrangement only
  chooses what is shown.
