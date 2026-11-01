# overstoryd 017: Merge Markdown as blocks

**Why and when:** on 2026-10-31 a stale Mac repeated a deletion the phone had
already made on the todos page, beside the phone's list renumbering and block
moves. The Markdown rule refused the whole file, and the choice covered 28 KB.
That was fixed with three special cases (repeated deletions, block-sized
choices, equal edits), the same pattern as every allowance before them. Joe
asked for one model instead. Do this before taking more Markdown items from
[overstoryd 014](merge-014-merge-handles-many-cases.md); it subsumes most of
its section B.

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
- **Remaining:** the rest of step 7 and step 8 below; step 6 moved to Editor 003.

## The problem with today's rule

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

Outcomes follow 014's three: **merge**, **merge with a note** (an ordered list
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

## Rules carried over from 014

Server first, byte preserving (never re-print or renumber; a renumbering is a
suggested alternative or a note), and both arrival orders agree, with a test
for each that must still go to review.

## Verification

Both orders give one result for every case; replays of recorded questions are
unchanged under the old revision; the todos regression above passes; the
format support contract in
[merge-tool](../../docs/architecture/overstoryd/merge-tool.md#format-support-contract)
describes blocks instead of the skeleton.
