# overstoryd 017: merge as blocks and elements, and the cases still open

**Why and when:** on 2026-10-31 a stale Mac repeated a deletion the phone had
already made on the todos page, beside the phone's list renumbering and block
moves. The Markdown rule refused the whole file, and the choice covered 28 KB.
That was fixed with three special cases (repeated deletions, block-sized
choices, equal edits), the same pattern as every allowance before them. Joe
asked for one model instead. The model now covers Markdown and the data
formats; the rest of this plan is the menu of cases that still go to review,
taken when a real edit asks for one.

Absorbed **overstoryd 014** ("the merge handles many cases", soon since
2026-10-28) on 2026-11-01 (Joe): its menu is "Cases still open" below, keeping
014's item numbers; its text is in git history before that date. Items 6, 11 and
13 are done for the formats step 7 covers, and the Markdown items 4, 5, 7 and 10
became block checks or Filesystem 026's page properties.

## Status

- **State:** IN PROGRESS. The block model is the Markdown rule since
  2026-11-01: `packages/overstoryd-merge/src/markdown-blocks.ts` (parser,
  identity and the check), `markdownBlocksEvidence` in `format-rules.ts`, and
  block-sized choices in `coupledGroups`. The skeleton check and its
  allowances (`proseTransferShape`, `markdownLayout`, list-edit and heading
  insertion guards) are deleted. Replaying the 2026-10-31 todos versions, the
  Mac's repeated deletion merges and the sync batch is one choice of about
  450 bytes instead of two of 28 KB.
- **Recorded merges need nothing.** Replay re-asks a recorded question and
  then aligns to the recorded root and decisions, so accepted results stand
  whatever a newer rule would answer (merge-tool, "Cache and replay"). The
  plan's earlier "run both revisions side by side" step is dropped.
- **Remaining:** the rest of step 7 and step 8 below; step 6 moved to Editor 003. Then the
  cases still open, one at a time.

## What a good merge does

When two people or agents change the same tree at the same time, the merge tool
combines their changes. It works to three constraints, in order:

1. **Lose nothing.** Every contribution from both sides is present and reachable
   in the result. A value that one side overwrites while the other edits it, or
   a duplicate JSON key that readers will collapse, counts as loss even when the
   file parses. This constraint is absolute.
2. **Keep the syntax.** Where the format has a syntax, the combined file is
   valid in it, and each side's change keeps its structure: a moved list item is
   still a list item, and an added key is still a key. Unstructured text passes
   trivially.
3. **Keep the meaning, as far as we can.** Ideally the result still works: the
   program still runs, the links still resolve, the configuration still
   configures the same things. This can only be approached, never guaranteed.
   Where both authors' intent is well understood (a moved paragraph, a changed
   value), the merge preserves that intent exactly.

A merge tool may give any of three outcomes:

- **Merge.** The result meets all three constraints as far as the rule can
  tell. Nothing is shown.
- **Merge with a note.** The result meets the first two constraints, but the
  rule knows of a way the meaning may have changed: "merged automatically; the
  link to `#setup` no longer points anywhere" or "this function moved while it
  was being edited". The note stays with the document until someone has seen
  it. It never blocks anything. Notes are
  [Editor 003 part 3](../features/editor-003-suggestions.md#part-3-merge-notes);
  until clients show them, a merge with a note behaves as a plain merge.
- **Review.** For when a merge would lose something or break the syntax. Both
  versions are kept as alternatives and a person chooses. Reviews already never
  block synchronization or further editing
  ([source intent §6](../../docs/overstory-spec/10-source-intent.md#6-accepted-decisions-and-continued-editing)).

Review costs the user attention, so **ours should rarely call for review**. It
biases towards the two merge outcomes and uses review for real loss or broken
syntax. The first round held the automatic cases to a stricter bar (a proof
that each change means the same in the combined file); under this plan such a
proof decides only between a plain merge and a merge with a note.

Today's automatic subsets are in the
[format support contract](../../docs/architecture/overstoryd/merge-tool.md#format-support-contract).
Most of its "requires review" column is cases that lose nothing and keep the
syntax, and would become merges or merges with a note.

## The problem with the old rule (replaced 2026-11-01)

`evaluateFormat` (`packages/overstoryd-merge/src/format-rules.ts`) decides
Markdown with a line **skeleton**: each line reduced to its marker and inline
syntax (`markdownLayout` in `markdown-format.ts`). Base, current, incoming and
the proposed result must have the same skeleton, or else match one of a
growing list of allowances: prose transfer shape, list edits, heading
insertions, prose insertions, same-anchor ordering. Anything else refuses, and
a refusal couples edits that have nothing to do with each other.

So the rule answers "did the page keep its shape?", when the question that
matters is "did each side's change to each block survive?". A renumbered list
changes the shape, and so does a moved heading, so an unrelated edit three
screens away goes to review. Each new real case then needs another allowance.

## The model

Merge a Markdown document as a sequence of **blocks**, with the engine's piece
identity telling which block is which. Story's editor already works in these
terms (it edits blocks and sends moves of blocks), so the server would merge in
the same units the person edits in.

1. **Parse each version into blocks.** Use one CommonMark block parser
   (tree-sitter-markdown, already loadable through `createParser`, or a small
   in-house block scanner held to the CommonMark block rules): front matter,
   headings, paragraphs, list items (with their nesting and marker), block
   quotes, fenced code, tables (rows, cells), HTML blocks, thematic breaks.
   Each block has a **container** path (which list item or quote it sits in), a
   **kind with attributes** (heading level, list marker and number, task state,
   fence language) and **content** (its inline source span).
2. **Identify blocks across versions by pieces,** not by text. A block in
   current or incoming is the base block whose content pieces it holds;
   otherwise it is new and owned by its author. Moves then show up as a block
   with a new position, which is what they are.
3. **Diff each side against base into block operations:** insert, delete, move
   (new position or container), set attribute (marker, level, task state,
   indent) and edit content. A side's change to a block is the set of those
   operations on it.
4. **Merge per block.** Operations on different blocks commute, and so do
   operations on different properties of one block (one side renumbers an item
   while the other edits its text). Two content edits to one block merge by the
   existing inline rules (byte-disjoint edits outside atomic inline tokens:
   links, code spans, emphasis runs). The order of insertions at one position
   uses the existing contribution-key ordering.
5. **The conflict unit is one block property,** never larger: the same block's
   content edited in overlapping places, the same attribute set to different
   values, a block moved to two places, or deleted on one side and edited on
   the other. A choice covers that block (or one table cell, or the front
   matter key, delegated to the YAML rule) and nothing else. Every other
   operation applies.
6. **Validate the result by re-parsing it,** not by comparing skeletons. Every
   block must come out with the kind, attributes and container that its last
   editor gave it. If a merged neighbor changes how a block parses (an
   inserted line without a blank line swallowing the next paragraph, an
   indent that moves an item under a different parent), that pair of blocks
   becomes the choice. That's still block-sized, and it is the only
   cross-block conflict.
7. **Equal results are not conflicts.** Where both sides' operations on a
   block property give the same value (both deleted it, both ticked it, both
   typed the same text), keep current's.

Outcomes are the three above: **merge**, **merge with a note** (an ordered list
left out of sequence, a link whose `#anchor` heading was renamed or moved
elsewhere) and **review**, which steps 5 and 6 confine to blocks.

## What it replaces

- The skeleton comparison and its allowances (`proseTransferShape`,
  `markdownListEdit`, `markdownHeadingInsertion`, the prose-insertion guard)
  become cases of steps 4 to 6.
- The engine's whole-file fallback for refused Markdown (`coupledGroups`, the
  block-sized grouping added on 2026-10-31) and the repeated-deletion and
  equal-edit checks (`unrepeated`) fold into steps 5 and 7.
- `markdown-source-transfer` (moves within and between documents) becomes
  block moves in step 3. A move between documents is a delete in one and an
  insert in the other with one identity.

## Steps

1. ~~Parser and block identity.~~ Done.
2. ~~Block diff and merge.~~ Done as a check on the identity-merged result
   rather than a separate block diff: the engine's piece merge already places
   every edit, and the block check decides whether the result keeps each
   side's blocks.
3. ~~Measure before switching.~~ Dropped; see Status.
4. ~~Switch the default.~~ Done.
5. ~~Transfers as block moves.~~ Done 2026-11-01. A Markdown transfer, replayed
   or not, is judged by the block check, which also keeps each block in the
   section (nearest heading) its last editor gave it. Links that depend on
   their document still review (`linksBound` in `format-rules.ts`), and so do
   replay failures the block check does not judge: two moves of one text and
   same-anchor insertions the insertion policy refuses. A moved nested item
   beside an edit to its text now merges (014 item 6).
6. **Notes.** Deferred to
   [Editor 003](../features/editor-003-suggestions.md#part-3-merge-notes) on 2026-11-01:
   a note is the host's own suggestion and shares its UI.
7. **Every structured format as elements.** Done for JSON, YAML, TOML and
   CSV/TSV on 2026-11-01: `elements.ts` is the format-neutral check, Markdown
   is one reader (`markdown-blocks.ts`) and the data formats are others
   (`data-elements.ts`). New keys and array items on both sides now merge,
   at one place in contribution order. **Remaining:** JSONL (records as
   elements by `recordKey`), XML/HTML/CSS, and code declarations, which keep
   their rules for now: merging two edits in one function needs the notes of
   [Editor 003](../features/editor-003-suggestions.md#part-3-merge-notes)
   (a rename beside a new use) before it is safe to do silently.
8. **Choices named by what they cover.** A decision's subject stays a byte range, which
   works for every file. Where a reader can parse the base, the sidecar adds labels for the
   blocks or elements the range covers ("Take pills, in Before 7pm"), read from the base
   text alone, so it needs no identity: a snapshot from folder sync gets labels too. A
   file no reader parses (binary, an unknown format) keeps the range or the whole file.

## Rules for every rule and case

- **Server first.** The tool accepts and reconciles a form before any client
  emits a new capture of it. Unknown operations stay invalid.
- **Byte preserving.** Rules apply source spans that both sides wrote. They never
  re-print or normalize. A combination that would need bytes neither side wrote
  (renumbering a list, relabelling a footnote) is offered as a suggested
  alternative in a review, not merged.
- **Both orders agree.** The same two changes give one outcome and one result
  whichever arrives first. Tests run both orders, check the recorded question
  replays, and include a case that must still go to review.

## Before taking a case

- **Count what reaches review.** Accepted history records each decision's rule
  and policy reason. Add an overstoryd report (counts only, no content) of
  unresolved decisions by format, rule and reason, over a tree or the whole host.
  Run it on the live host with Joe's go-ahead, and rank the cases below by what
  people actually hit.
- **Rule revisions.** Spec 10 §7 requires evidence to name a rule's identity and
  revision, so a change to what a rule decides bumps its revision. **Open:** 014's
  first round and this plan's steps changed the Markdown, JSON, YAML and TS/JS
  rules' decisions without bumping them from `revision: 1`. Replay aligns to
  recorded decisions, so history is not reinterpreted either way; decide whether to
  bump them now, and add a test that fails when a rule's decisions change without
  a bump. (Moved here from overstoryd 015 step 0.)

## Cases still open

Each names the case and the outcome it would get: **merge**, **note** or
**review**. Numbers are 014's. Take one when a real edit has asked for it.


### A. Ordering and anchors

1. **Anchor-adjacent edits** — *fix first.* You move a paragraph to just after
   "Intro." while I delete that full stop. If my edit arrives first the anchor
   cannot be found, so that order reviews while the other merges. Anchor a
   transfer by piece identity with a side (after this piece, before that one) so
   a neighbouring edit does not remove it: **merge** in both orders. The same
   holds for a move anchored on material an earlier move in the change carried
   into another document (Move to Document of blocks apart from each other):
   the engine executes it, but a peer's edit to that text reconciles only when
   the peer arrives first (`tests/unit/overstoryd-merge/source-moves.test.ts`).
   Native copies such a selection until it merges in both orders.
2. **Two moves of the same text.** You move a paragraph up, I move it down. A
   real choice: **review**, presented as "moved here, or here" rather than byte
   ranges through the portable [accepted-state review contract](../../docs/overstory-spec/09-client-synchronization.md#accepted-state-review).
3. **A move and a delete.** You move a paragraph while I delete it. Deleting
   loses your move, so **review**, which is today's behaviour. Keep it.

### B. Markdown and prose

Most of 014's section B is covered by the block model. Still open:

8. **Table columns.** One side adds or reorders a column while the other edits
   cells: **merge** by header name when the header names are unique.
9. **Footnotes.** Moving text with its `[^1]` and its definition: **merge**. Both
   sides adding a different `[^1]`: **review**, with a relabelled suggestion.
- Links into another document (4) and a heading renamed while someone links to
  it (5) still review through `linksBound`; they become **notes** once notes
  exist. An ordered list left out of sequence (part of 6) is a **note** too.

### C. Structured data

12. **Key removed while edited.** One side deletes a key, the other changes its
    value: **review** (the edit would be lost).
13. **Arrays.** (Additions on both sides merge since step 7.) When the array is declared or known to be set-like
    (`tags`, `keywords`), a removal on one side and an addition on the other
    also merge. Otherwise edits to different elements by index: **note**.
14. **Arrays of objects with an identity.** Elements keyed by a unique `id`,
    `name` or `key` (workflow `steps`, service lists): **merge** edits and moves
    as if the array were a keyed map.
15. **Structured moves between files.** A member moved from `config.json` to
    `db.json` while the other side edits it: **merge**, carrying the edit.
16. **Appends to logs.** JSONL rows appended on both sides: **merge** in
    contribution order (CSV does since step 7; JSONL is step 7's remainder). Plain-text journals and changelogs can opt in the same
    way Markdown's `preserve-both` does.
17. **CSV columns.** One side adds a column while the other edits cells or
    appends rows: **merge** by header name.
18. **YAML's excluded constructs.** Sequences, block scalars, comments, and
    anchors with aliases: **merge** where the constructs themselves are unchanged
    around the edits. An edit to an anchor that aliases elsewhere depend on
    changes every alias: **note**, listing them.

### D. Code

19. **Declaration moves while edited.** A function moved on one side and edited
    on the other: **merge** in TS/JS (hoisted), Swift outside `main.swift`, Go
    functions and types, Rust items. **Note** where position can matter: Python
    (definitions run in order), Go package-level `var`, Rust `macro_rules!`,
    `main.swift`.
20. **Moves between files.** A function moved from `a.ts` to `b.ts` while edited:
    **merge**, with a **note** when the new file lacks an import the function
    uses.
21. **Imports.** Different imports added on both sides: **merge**. An import
    removed on one side while the other adds a use of it: **note**.
22. **Additions at the same place.** Both sides add a function at the end of a
    file, a `case` to a `switch`, or a member to an enum: **merge** in
    contribution order; **note** where the order changes meaning (enum members
    with position-based values, `case` fallthrough).
23. **Edits to different lines of one function.** Today reviewed unless both are
    literal edits. **Merge** when the edits are in different statements and the
    result parses; **note** when one side changes a name the other side's lines
    use.
24. **Rename while someone adds a use.** One side renames a function; the other
    adds a call to the old name. **Note**, with the renamed call as a one-click
    fix. Never rewrite it silently.
25. **Formatter against an edit.** One side reformats (layout only) while the
    other edits a line. Reapplying the edit into the new layout writes bytes
    neither side wrote: **review** with that combination as the suggestion.

### E. Formats not supported yet

26. **BibTeX**: entries keyed by citation key, fields as keyed members.
27. **Jupyter notebooks** (`.ipynb`): cells as a keyed list by cell ID, cell source
    as text. Competing execution outputs: **merge** keeping the newer, with a
    **note**; outputs are regenerable and conflict constantly.
28. **LaTeX**, **Org-mode**, **reStructuredText**, **AsciiDoc**: paragraphs as
    prose and environments as protected hosts, like Markdown.
29. **iCalendar and vCard**: components keyed by `UID`, properties as keyed
    members.
30. **INI and `.env`**: flat keyed lines, like TOML's simple subset.
31. **`.gitignore` and similar line sets**: **merge** added lines; **note** when
    an addition lands on the other side of a `!negation` from where its author
    put it.
32. **SVG**: XML keyed by element IDs.

### F. Presentation

33. **Suggested resolutions.** Where a review has a likely combination (items 2,
    9 and 25), offer it as an alternative marked as a suggestion, so a review is
    one click. See the "rule-provided combination previews" candidate in the
    [overstoryd 016](../later/merge-016-choice-review-extensions.md).
34. **Why it merged.** On request, show "merged: your move and Alex's edit" from
    the recorded evidence. This is a note's job:
    [Editor 003 part 3](../features/editor-003-suggestions.md#part-3-merge-notes).

## Verification

Per step and per case: tests in both arrival orders giving one result, a case that
must still go to review, a replay check, the rule's revision bumped, the
[format support contract](../../docs/architecture/overstoryd/merge-tool.md#format-support-contract)
updated, and the change on main (which deploys it) before any client relies on it.
For the block model: both orders give one result for every case; replays of recorded questions are
unchanged under the old revision; the todos regression above passes; the
format support contract in
[merge-tool](../../docs/architecture/overstoryd/merge-tool.md#format-support-contract)
describes blocks instead of the skeleton.
