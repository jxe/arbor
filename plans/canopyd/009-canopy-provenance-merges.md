# canopyd 009: Remaining canopyd provenance and policy work

Historical identifier: **Reliability 009**. The filename number is preserved; this plan now belongs to canopy.

Status: PARTIAL. The eight-operation authority integration is on main and deployed.
See [the merge tool](../../docs/canopyd/merge-tool.md) and
live cutover (migration 010, deleted after cutover; see git history) for completed work.
This plan contains only remaining work.

[008](../swift/008-complete-native-move-copy-undo-capture.md) owns client capture/submission;
[010](../swift/010-client-conflict-review.md) owns review. The tool's operation/language
milestone is 013 (completed plan, deleted; see git history).

## Remaining policy and storage work

- Add canopyd-wide and per-tree rule selection with retained configuration evidence.
  Keep format policy in the tool; clients must not reproduce merge policy.
- Measure on-demand worker latency, history growth and memory before adding supervised
  persistent workers or caching. Preserve bounded jobs, durable retries and exact
  receipts across tool upgrades.
- Complete the [server refinement release gate](../verification/release-and-soak.md#server-refinements)
  for implemented source-range inspection, preserving format coupling and whole-file policy.
- Before garbage collection or packing, pin accepted/authored semantic roots, all
  transitive hidden/undo dependencies, staged inputs and results awaiting commit.
  Coordinate with [packfiles](001-pack-object-storage.md) and
  [fragment storage](002-composable-conflict-fragments.md).

Keep the portable spec ahead of implementation. Record implementation restrictions
in status/docs, not by weakening the contract. Unknown operations remain invalid; server execution support precedes new client emission.

## Remaining source-transfer policy work

- Extend the [prose-transfer rule](../../docs/canopyd/merge-tool.md#format-support-contract)
  to list/table transfers and document-relative/reference links only with explicit structural/binding proofs.
- Evaluate same-anchor transfer ordering separately from plain edit insertions;
  do not silently order ambiguous destinations or competing moves.
- Add format-specific transfer proofs for keyed JSON/YAML and code declarations;
  source identity and valid syntax alone do not prove those operations commute.
- The implemented Markdown transfer and insertion refinements share the server
  release gate above. No wire/schema change or coordinated client update is required.
