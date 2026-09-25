# canopyd 014: The merge handles many cases brilliantly

Formerly "Merge moved and copied text beyond paragraphs", split from canopyd
009 (merge rule selection, since deleted; see git history) on 2026-09-22. (Plan
numbers are separate from migration numbers: this is not migration 014.)

## Status

- **Priority:** P3. Prose, the common case, already merges well.
- **State:** IDEAS AND CANDIDATES. The first round (Markdown list, table and
  link transfers, same-anchor ordering, keyed JSON/YAML moves, TS/JS function
  moves) is implemented and not deployed; see [status](../../status.md), the
  [transfer rules](../../docs/architecture/canopyd/merge-tool.md#transfers) and
  the [release gate](../verification/release-and-soak.md#server-refinements).
  Everything below is a menu. Promote an item into `soon/` when a real edit has
  asked for it.

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
  it. It never blocks anything.
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
[format support contract](../../docs/architecture/canopyd/merge-tool.md#format-support-contract).
Most of its "requires review" column is cases that lose nothing and keep the
syntax, and would become merges or merges with a note.

## Before the candidates

- **Notes need a home.** [Source intent §7](../../docs/overstory-spec/10-source-intent.md#7-format-aware-merge-rules-and-explicit-automatic-resolution)
  already requires an automatic resolution to record its justification, and lets
  each rule define extra evidence fields. A note needs a portable shape that
  clients can show without knowing the rule: a short message, the affected range
  or path, and whether someone has seen it. Specify it in §7, carry it in the
  log entry's decision evidence, and show it in the editor's margin beside
  [Native 010](../swift/010-inline-choice-context.md)'s choices. Until clients
  show notes, a merge with a note behaves as a plain merge.
- **Say the three outcomes in the spec.** Add the three constraints and three
  outcomes to source intent §7 as what any merge tool may do. The spec should
  permit all three and require only the first two constraints for an automatic
  outcome. How eagerly a tool merges is its own choice.
- **Count what reaches review.** Accepted history records each decision's rule
  and policy reason. Add a canopyd report (counts only, no content) of
  unresolved decisions by format, rule and reason, over a tree or the whole host.
  Run it on the live host with Joe's go-ahead, and rank the candidates by what
  users actually hit.
- **Rule revisions.** §7 requires evidence to name a rule's identity and
  revision, so a change to what a rule decides bumps its revision. **Open:** the
  first round changed the Markdown, JSON, YAML and TS/JS rules' decisions
  without bumping them from `revision: 1`. Replay aligns to recorded decisions,
  so history is not reinterpreted either way.

## Rules for every candidate

- **Server first.** The tool accepts and reconciles a form before any client
  emits a new capture of it. Unknown operations stay invalid.
- **Byte preserving.** Rules apply source spans that both sides wrote. They never
  re-print or normalize. A combination that would need bytes neither side wrote
  (renumbering a list, relabelling a footnote) is offered as a suggested
  alternative in a review, not merged.
- **Both orders agree.** The same two changes give one outcome and one result
  whichever arrives first. Tests run both orders, check the recorded question
  replays, and include a case that must still go to review.

## Candidates

Each item names the case and the outcome it would get: **merge**, **note** (a
merge with a note) or **review**.

### A. Ordering and anchors

1. **Anchor-adjacent edits** — *fix first.* You move a paragraph to just after
   "Intro." while I delete that full stop. If my edit arrives first the anchor
   cannot be found, so that order reviews while the other merges. Anchor a
   transfer by piece identity with a side (after this piece, before that one) so
   a neighbouring edit does not remove it: **merge** in both orders.
2. **Two moves of the same text.** You move a paragraph up, I move it down. A
   real choice: **review**, presented as "moved here, or here" rather than byte
   ranges (with [Native 010](../swift/010-inline-choice-context.md)).
3. **A move and a delete.** You move a paragraph while I delete it. Deleting
   loses your move, so **review**, which is today's behaviour. Keep it.

### B. Markdown and prose

4. **Links into another document.** A moved `[see below](#setup)` or `[spec][1]`
   lands in a different document. **Merge** when the destination binds it to
   the same target; otherwise **note** ("this link no longer resolves here").
5. **Heading renamed while someone links to it.** You rename `## Setup` to
   `## Installing`; I add `[see setup](#setup)` elsewhere. **Note**, with the
   rewritten link as a one-click fix. Heading text is in Markdown's automatic
   subset, so this probably merges silently today; check that first. Related:
   [Filesystem 025](../filesystem/025-folder-link-healing.md) heals links after
   folder moves.
6. **Richer lists.** Moves and insertions in ordered lists, nested items (moved
   with their children), multi-line and loose items: **merge**. When a move
   leaves ordered-list numbers out of sequence, **note**; renumbering would write
   bytes neither side wrote.
7. **Task items.** One side ticks the box, the other edits the text: **merge**.
8. **Table columns.** One side adds or reorders a column while the other edits
   cells: **merge** by header name when the header names are unique.
9. **Footnotes.** Moving text with its `[^1]` and its definition: **merge**. Both
   sides adding a different `[^1]`: **review**, with a relabelled suggestion.
10. **Frontmatter.** It is YAML, so it gains everything in section C. Two sides
    adding different tags is probably the most common structured edit in notes.

### C. Structured data

11. **Different new keys in the same object.** Two sides adding `"lodash"` and
    `"zod"` to `dependencies`, or different keys to a YAML map: **merge**, each
    key at its author's position. The largest likely win for configuration
    files. The same key added with different values: **review**.
12. **Key removed while edited.** One side deletes a key, the other changes its
    value: **review** (the edit would be lost).
13. **Arrays.** Both sides add elements to one array: **merge** keeping both in
    contribution order. When the array is declared or known to be set-like
    (`tags`, `keywords`), a removal on one side and an addition on the other
    also merge. Otherwise edits to different elements by index: **note**.
14. **Arrays of objects with an identity.** Elements keyed by a unique `id`,
    `name` or `key` (workflow `steps`, service lists): **merge** edits and moves
    as if the array were a keyed map.
15. **Structured moves between files.** A member moved from `config.json` to
    `db.json` while the other side edits it: **merge**, carrying the edit.
16. **Appends to logs.** JSONL and CSV rows appended on both sides: **merge** in
    contribution order. Plain-text journals and changelogs can opt in the same
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
    [catalog](../catalog.md#native-clients).
34. **Why it merged.** On request, show "merged: your move and Alex's edit" from
    the recorded evidence.

## Verification

Per candidate: tests in both arrival orders giving one result, a case that must
still go to review, a replay check, the rule's revision bumped, the
[format support contract](../../docs/architecture/canopyd/merge-tool.md#format-support-contract)
updated, and the release gate recorded in
[release and soak](../verification/release-and-soak.md#server-refinements)
before any client relies on it.
