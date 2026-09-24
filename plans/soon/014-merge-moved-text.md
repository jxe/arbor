# canopyd 014: Merge the remaining moved and copied text forms

Split from canopyd 009 (merge rule selection, since deleted; see git history) on 2026-09-22. (Plan numbers are separate from
migration numbers: this is not migration 014.)

## Status

- **Priority:** P3 — the common forms are implemented
- **State:** the three planned extensions are implemented in conservative
  subsets, not deployed (see [status](../../status.md) and the
  [transfer rules](../../docs/architecture/canopyd/merge-tool.md#transfers));
  their release gate is in
  [release and soak](../verification/release-and-soak.md#server-refinements).
  This plan keeps only the forms those subsets still send to review.

## Today

The merge tool replays identity-verified moves and copies and reconciles them
with independent edits in either arrival order for: Markdown paragraphs, flat
bullet-list items and pipe-table body rows; contextual links with a proven
binding; same-anchor pairs in contribution order where the prose insertion
policy allows; keyed JSON and YAML members within one file; and top-level TS/JS
function declarations within one file. Each rule's commutation proof is in
`packages/canopyd-merge/src/format-rules.ts`; tests are in
`tests/unit/canopyd-merge/transfer-extensions.test.ts`.

## Work

Each form still needs an explicit proof that the two changes commute; source
identity and valid syntax alone are not proof. Keep review where a proof does
not hold.

1. **Declaration moves in Swift and Python.** Python runs definitions in order
   (defaults, annotations and decorators evaluate at definition time) and
   Swift's `main.swift` runs top-level code in order, so the TS/JS hoisting
   argument does not carry over; each needs its own model of when position is
   irrelevant.
2. **Structured moves between files.** A keyed JSON/YAML member or a
   declaration moved to another file: relocate the other side's edits across
   files, and for code prove the binding scope and imports of both files.
3. **Cross-document fragments and references.** Admit a moved `#fragment` or
   reference link when the destination document's headings or definitions
   bind it exactly as the source's did.
4. **Richer Markdown hosts.** Ordered lists (start number), nested and
   multi-line items, loose lists, and hosts directly followed by an opaque
   region.
5. **Anchor-adjacent edits.** An edit that removes a byte beside a transfer's
   destination anchor makes the replay unlocatable in the order where the edit
   arrives first, so that order reviews while the other merges; define the
   anchor so both orders agree.

Each extension ships server-first: the tool accepts and reconciles a form before
any client emits a new capture of it. No wire or schema change is expected;
unknown operations stay invalid.

## Verification

Per extension: differential tests in both arrival orders, a case where the proof
fails and review is kept, and the release gate recorded before relying on it.
