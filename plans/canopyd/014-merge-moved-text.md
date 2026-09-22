# canopyd 014: Merge moved and copied text beyond paragraphs

Split from canopyd 009 on 2026-09-22. (Plan numbers are separate from
migration numbers: this is not migration 014.)

## Status

- **Priority:** P3 — Markdown prose is what gets edited today
- **State:** PLANNED, not started. The release gate for the shipped Markdown
  refinements is in [release and soak](../verification/release-and-soak.md#server-refinements).

## Today

`moveSource` and `copySource` carry text with its origin. The merge tool
reconciles an identity-verified paragraph move or copy with independent prose
edits in either arrival order (the
[prose-transfer rule](../../docs/architecture/canopyd/merge-tool.md#format-support-contract)).
Anything else — structured formats, protected Markdown structure, two transfers
into one spot — is held for review. That is safe, but it asks you to choose
more often than necessary.

## Work

Each extension needs an explicit proof that the two changes commute; source
identity and valid syntax alone are not proof.

1. **Markdown structure.** Moves and copies of list items and table rows, and of
   text containing document-relative or reference links, with structural and
   link-binding proofs.
2. **Same-anchor ordering.** Two transfers, or a transfer and a plain insertion,
   landing at the same anchor. Evaluate separately from plain insertion
   ordering, and never order ambiguous destinations or competing moves silently.
3. **Structured formats.** Keyed JSON/YAML moves and code-declaration moves, with
   format-specific proofs.

Each extension ships server-first: the tool accepts and reconciles a form before
any client emits a new capture of it. No wire or schema change is expected;
unknown operations stay invalid.

## Verification

Per extension: differential tests in both arrival orders, a case where the proof
fails and review is kept, and the release gate recorded before relying on it.
