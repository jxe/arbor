# Reliability 009: Remaining Canopy provenance and policy work

Status: PARTIAL. The eight-operation authority integration is on main and deployed.
See the [integration checkpoint](../../docs/merge-authority-integration.md) and
[live cutover](../../migrations/010-merge-state/live-cutover.md) for completed work.
This plan contains only remaining work.

[008](008-enable-source-operations.md) owns client capture/submission;
[010](010-client-conflict-review.md) owns review. The tool's operation/language
milestone is [013](../_done/reliability/013-merge-operations-and-formats.md).

## Remaining policy and storage work

- Add Canopy-wide and per-tree rule selection with retained configuration evidence.
  Keep format policy in the tool; clients must not reproduce merge policy.
- Measure on-demand worker latency, history growth and memory before adding supervised
  persistent workers or caching. Preserve bounded jobs, durable retries and exact
  receipts across tool upgrades.
- Deploy and verify the implemented source-range inspection policy; independent
  choices, fragment reads, guarded replacement and range relocation are tested.
  Keep format-required coupling and whole-file policy available.
- Before garbage collection or packing, pin accepted/authored semantic roots, all
  transitive hidden/undo dependencies, staged inputs and results awaiting commit.
  Coordinate with [packfiles](../canopy-storage/001-pack-object-storage.md) and
  [fragment storage](../canopy-storage/002-composable-conflict-fragments.md).

Keep the portable spec ahead of implementation. Record implementation restrictions
in status/docs, not by weakening the contract. Unknown operations remain invalid; server execution support precedes new client emission.

## Source-transfer policy follow-up

The client copy-capture tests demonstrate that plain-text copies reconcile with
independent edits to their source. The current Markdown rule can retain a review
choice because copying changes host structure even when transfer replay succeeds.
Evaluate explicit source-transfer evidence when refining that format rule; retain
review for coupled host/embedded structure and ambiguous destinations. The client
capture slice intentionally does not bypass this policy.
