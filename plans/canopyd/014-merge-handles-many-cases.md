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
  Everything below is a menu. Promote an item into `soon/` once its proof is
  sketched and a real edit has asked for it.

## The goal

When two people or agents change the same tree at the same time, the merge
should combine them whenever doing so provably means what both authors meant.
It should ask for review only when there is a real choice to make. Each review
the merge could have avoided costs the user attention; each wrong merge costs
trust, and costs more. So the rule stays as it is: **every automatic case has an
explicit commutation proof** (the change means the same in the combined file,
whichever side arrived first). Source identity, valid syntax and "the result
parses" are never proof. Where a proof fails, the merge keeps review and never
guesses.

Today's automatic subsets are in the
[format support contract](../../docs/architecture/canopyd/merge-tool.md#format-support-contract);
this plan is about widening them.

## Rules for every item

- **Server first.** The tool accepts and reconciles a form before any client
  emits a new capture of it. No wire or schema change is expected; unknown
  operations stay invalid.
- **Byte preserving.** Rules apply verified source spans. They never re-print
  or normalize, and they never write bytes neither side authored. A proposal
  that wants a normalization (renumbering a list, sorting imports) instead
  records it as an explicit, reviewable alternative.
- **Both orders agree.** Differential tests run both arrival orders and must
  give one result. They include a case where the proof fails and review is
  kept, and a replay check of the recorded question.
- **Rule revisions.** [Source intent §7](../../docs/overstory-spec/10-source-intent.md#7-format-aware-merge-rules-and-explicit-automatic-resolution)
  requires evidence to name a rule's identity and revision. A change to what a
  rule decides bumps that rule's revision. **Open:** the first round changed the
  decisions of the Markdown, JSON, YAML and TS/JS rules without bumping them
  from `revision: 1`; decide whether to bump them now. Replay aligns to recorded
  decisions, so history is not reinterpreted either way.

## Start by measuring

**0. Count what actually goes to review.** Accepted history records each
decision's rule and policy reason. Add a canopyd report (counts only, no
content) of unresolved decisions by format, rule and reason over a tree or the
whole host. Run it on the live host with Joe's go-ahead. Rank the items below by
what users actually hit, not by what is interesting to prove.

## Candidates

Each item gives the case, a sketch of why it could be sound, and what still
keeps review.

### A. Ordering and anchors (correctness of the ones already shipped)

1. **Anchor-adjacent edits.** You move a paragraph to just after "Intro." while
   I delete that full stop. If my edit arrives first, the anchor cannot be
   found, so that order reviews while the other order merges. Define the anchor
   by piece identity with a side (after this piece, before that one) so a
   neighbouring edit does not remove it, and both orders agree. *This is first
   in line: an order-dependent outcome is the one inconsistency in the current
   rules.*
2. **Competing moves of the same material.** Two people move the same paragraph
   to different places. This is genuinely a choice, but the review can say so
   precisely ("moved here or here") instead of showing byte ranges. It belongs
   with [Native 010](../swift/010-inline-choice-context.md)'s presentation.

### B. Markdown and prose

3. **Links into another document.** A moved `[see below](#setup)` or `[spec][1]`
   is admitted today only within one document. Admit it across documents when
   the destination's heading slugs or reference definitions bind it to the same
   target text as the source's did.
4. **Heading renamed while someone links to it.** You rename `## Setup` to
   `## Installing`; I add `[see setup](#setup)` elsewhere. The heading edit and
   the new link are disjoint, but the combination is a broken link. Detect it
   (the new link's fragment bound in my base and is unbound in the result) and
   review, or offer the rewritten link as an alternative. Heading text is in
   Markdown's automatic subset, so this probably merges silently today; check
   that first, because a silent broken link is worse than a review. Related:
   [Filesystem 025](../filesystem/025-folder-link-healing.md) heals links after
   folder moves.
5. **Richer lists.** Ordered lists (a move changes nothing when the source uses
   the same number on every item, `1.`, or when the numbering is rendered
   anyway; otherwise offer the renumbered result as an alternative), nested
   items moved with their children as one unit, multi-line and loose items, and
   task items where one side ticks the box and the other edits the text.
6. **Table columns.** One side adds or reorders a column while the other edits
   cells. Map cells by header name instead of position when the header names
   are unique.
7. **Footnotes and definitions.** Moving text that carries `[^1]` together with
   its definition, and two sides adding footnotes that both chose the label
   `[^1]` (keep both only by relabelling, so review with a proposed relabel).
8. **Frontmatter.** Frontmatter is YAML, so it gains everything in section C.
   Two sides adding different tags to `tags: [a, b]` is probably the single
   most common structured conflict in notes.

### C. Structured data

9. **Different new keys in the same object.** Today key creation reviews. Two
   sides adding `"lodash"` and `"zod"` to `dependencies` in `package.json`, or
   different keys to a YAML map, commute trivially when the keys differ: the
   result has both, each at its author's anchor, with same-anchor ordering for
   ties. *Likely the largest win in this plan for config files.*
10. **Set-like arrays and sequences.** Scalar arrays whose order does not
    matter (`tags`, `keywords`, `files`) take a union of additions and
    removals. Order-insensitivity cannot be read from the file, so it needs a
    declaration: a collection schema annotation, a per-format default for known
    keys, or a configured path. Without that, keep review.
11. **Keyed arrays.** Arrays of objects with a unique identifying member (`id`,
    `name`, `key`), such as GitHub workflow `steps` or docker-compose-like
    lists. Treat them as keyed maps for edits and moves when every element has
    a unique key in all four versions.
12. **Structured moves between files.** A keyed member moved from `config.json`
    to `db.json` while the other side edits it: relocate the edit with the
    member. Needs the cross-file replay that item 16 also needs.
13. **Appends to logs.** JSONL and CSV where both sides append records or rows
    with distinct keys: keep both in contribution order. Plain-text journals and
    changelogs could opt in the same way Markdown's `preserve-both` does.
14. **CSV columns.** One side adds a column while the other edits cells or
    appends rows; map by header name, as in item 6.

### D. Code

15. **Declaration moves in more languages.** Where position does not change
    meaning, a move is sound:
    - **Swift outside `main.swift`**: top-level declarations in ordinary files
      are order-independent. Only `main.swift` and scripts run top to bottom.
    - **Go**: package-level functions, types and methods are order-independent.
      Package-level `var` initialization follows dependency order, and within
      that declaration order, so `var` moves need the dependency check.
    - **Rust**: items in a module are order-independent, except
      `macro_rules!`, which is scoped by text order.
    - **Python**: a `def` can move when its decorators, default values and
      annotations are absent or literals, and no module-level statement between
      the old and new positions refers to the name.
16. **Moves between files in code.** A function moved from `a.ts` to `b.ts`
    while the other side edits it. Prove the moved code binds the same names in
    its new file (imports present, nothing shadowed) and that the old file's
    remaining uses are imported back. Hard; do it after item 12.
17. **Imports.** Two sides add different imports to the same import block, or
    different names to one `import { … }` list. The result is the union, placed
    by same-anchor ordering. Removals commute only when the other side adds no
    use of the removed name.
18. **Additions at the same place.** Both sides add a new function at the end of
    a file, a new `case` to a `switch`, or a new member to an enum. These are
    plain insertions at one anchor; they are sound where order does not matter
    (hoisted declarations, enum members without explicit or implicit values
    that depend on position, `case` blocks without fallthrough).
19. **Formatter versus edit.** One side runs a formatter (whitespace and layout
    only) while the other edits a line. Compare tokens rather than bytes, and
    re-apply the edit's tokens into the formatted layout when every changed
    token maps uniquely. The result then contains bytes neither side wrote
    exactly, so this is at most an alternative, not an automatic merge, unless
    the formatter's own rules can be shown to reproduce it.
20. **Rename versus new use.** One side renames a function; the other adds a
    call to the old name. Detect it (a new unbound identifier that the other
    side renamed) and review with the renamed call as the proposed alternative.
    Never apply it silently.

### E. Formats not supported yet

21. **BibTeX**: entries keyed by citation key, fields as keyed members. A good
    fit for research notes.
22. **Jupyter notebooks** (`.ipynb`): JSON with cell IDs. Treat cells as a keyed
    ordered list and cell source as text. Execution outputs and counts conflict
    constantly; offer "keep the newer outputs" as an explicit alternative
    rather than merging them.
23. **LaTeX**: paragraphs as prose, environments as protected hosts, the same
    shape as Markdown.
24. **iCalendar and vCard**: components keyed by `UID`, properties as keyed
    members.
25. **INI and `.env`**: flat keyed lines, like TOML's simple subset.
26. **`.gitignore` and similar line sets**: the union of added lines, except
    that negations (`!pattern`) make order meaningful, so lines on both sides
    of a negation keep review.
27. **SVG**: XML with element IDs. The XML rule's strict subset plus keyed
    elements.
28. **Org-mode**, **reStructuredText**, **AsciiDoc**: prose formats that could
    reuse the Markdown rule's shape if anyone keeps notes in them.

### F. Reviews the merge still asks for

29. **Suggested resolutions.** Where a rule can compute a likely combination
    but not prove it (items 4, 5, 7, 19 and 20), record it as an additional
    alternative marked as a suggestion, so review is one click instead of an
    edit. It is never accepted automatically. This needs the alternative model
    to carry a rule-provided combination; see the "rule-provided combination
    previews" candidate in the [catalog](../catalog.md#native-clients).
30. **Explaining automatic merges.** Show "merged: your move and Alex's edit,
    because function declarations are hoisted" on request, from the recorded
    evidence. Trust grows when the merge can say why it was safe.

## Verification

Per item: differential tests in both arrival orders, a case where the proof
fails and review is kept, a replay check, the rule's revision bumped, the
[format support contract](../../docs/architecture/canopyd/merge-tool.md#format-support-contract)
updated, and the release gate recorded in
[release and soak](../verification/release-and-soak.md#server-refinements)
before any client relies on it.
