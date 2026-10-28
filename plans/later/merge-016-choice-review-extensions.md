# overstoryd 016: richer choice review

**Why and when:** Story's choice review (`swift/StoryApp/StoryConflictReview.swift`) lacks
several things a real review may need. These were a "product design needed" item in
[candidates](../candidates.md); Joe made them a plan in later on 2026-10-28. Take each when a real review
needs it.

## Status

- **Effort:** S to M each.
- **Risk:** LOW for previews and display; MEDIUM for the freshness policy and offline
  resolution, which change when a guarded resolution is accepted.
- **Relates to:** [overstoryd 015](../when-needed/merge-015-resolve-reconciled-choices.md)
  (clearing choices later work has reconciled, and explaining automatic outcomes), and
  [overstoryd 014](../when-needed/merge-014-merge-handles-many-cases.md) item 33 (suggested
  resolutions).

## The extensions

1. **Safe binary previews.** Bounded, inert previews of non-text alternatives (images first);
   never parse binary bytes as text.
2. **Richer directory browsing** for directory-level choices.
3. **Long sources.** Comparison beyond the 4,000 highlighted lines
   (`highlightedLineLimit`).
4. **Visible whitespace and line-ending differences**, so alternatives that look the same
   can be told apart.
5. **A freshness policy**, so an unrelated accepted update need not force a renewed review.
6. **Explanations** of verified moves and deletions in an alternative.
7. **Rule-provided combination previews** (with 014 item 33).
8. **Bulk and offline resolution.**

## Close out

Record each extension in `status.md` as it lands, and delete this plan when the list is empty.
