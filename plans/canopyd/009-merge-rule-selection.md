# canopyd 009: Merge rule selection per host and per tree

Historical identifier: **Reliability 009**, formerly "Remaining canopyd provenance and
policy work". The provenance-merge authority it built is deployed (see
[the merge tool](../../docs/architecture/canopyd/merge-tool.md)); its source-transfer
policy work moved to [canopyd 014](014-source-transfer-proofs.md), and its
garbage-collection pinning requirement to [canopyd 001](001-pack-object-storage.md).

## Status

- **Priority:** P3 — no tree needs different merge behaviour yet
- **State:** PLANNED, not started
- **Trigger:** the first tree whose content needs a policy the default rules
  don't give (for example, concatenating concurrent plain-text insertions
  instead of holding them for review, or reviewing prose the default combines)

## Today

Every merge request carries `rules: { id: "tree-default", revision: 1 }`, and
the merge tool applies its built-in format rules: Markdown prose insertions and
identity-verified transfers combine; plain text is held for review unless a
rule opts in; structured formats cannot opt into concatenation. The rule
identity is recorded in each merge's evidence, but nothing lets a host or a
tree choose another.

## Work

1. **Where rules live.** A host-wide default plus a per-tree override, kept in
   governed configuration (the account configuration tree or the tree's own
   policy), so a change to them is an accepted, attributable update like any
   other. Decide which before building.
2. **What a rule set may say.** Only choices the tool already implements:
   per-path or per-format concatenation opt-ins and review requirements. The
   format logic itself stays in the merge tool; a rule set selects, it never
   defines merge behaviour, and clients never reproduce it.
3. **Evidence.** Each merge records the exact rule set (id, revision, content
   hash) it ran under, so a later reader can tell why two edits combined.
   Changing a tree's rules never re-evaluates past merges.
4. **Upgrades.** A rule revision the running tool does not know is refused
   before evaluation, with a typed error, never silently defaulted.

## Verification

Tests: the same concurrent edits merge differently under two rule sets and
each result's evidence names its rules; an unknown revision is refused; a rule
change between two merges leaves the first merge's evidence intact.
