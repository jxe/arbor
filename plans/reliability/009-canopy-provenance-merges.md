# Reliability 009: Remaining Canopy provenance and policy work

Status: PARTIAL. The eight-operation authority integration is on main and deployed.
See the [integration checkpoint](../../docs/merge-authority-integration.md) and
[live cutover](../../migrations/010-merge-state/live-cutover.md) for completed work.
This plan contains only remaining work.

[008](008-enable-source-operations.md) owns client capture/submission;
[010](010-client-conflict-review.md) owns review. The tool's operation/language
milestone is [013](../_done/reliability/013-merge-operations-and-formats.md).

## Future retention contract expansion

This is separate from the existing eight-operation integration. Unknown operations
remain invalid today; do not reinterpret authoritative operations as unchecked hints.

- Revise the goal specification to distinguish recording authored intent, validating
  its execution against its candidate, and using it in reconciliation. Today's
  operation array is authoritative; do not quietly reinterpret it as ignorable hints.
  Specify the transition for existing operations, pending requests and receipts.
- Define a generic operation envelope: stable kind/identity, authored basis, ordering,
  material references, result bindings, complete retention dependencies, and an opaque
  operation-specific payload. Reuse existing references and operation vocabulary.
  An unknown payload is retainable only when its dependency/authorization envelope
  is understood; arbitrary uninterpreted bytes must not conceal reference authority.
- Specify whether recorded operations describe a complete candidate or a partial
  contribution and how that coverage is represented. Never infer completeness, false
  lineage or absence of hidden changes from a matching candidate hash.
- Define deterministic identity/digest coverage, canonical encoding, duplicate-change
  handling, bounds and forward-reference/cycle rules. Bind opaque payloads and their
  dependencies to the request digest. Preserve equal-byte intent transitions.
- Specify how operation-output references can be retained before execution: bind
  supplied material immutably as an unverified claim, or require the needed prerequisite
  validation. Do not assume that retaining an output name establishes its meaning.
- Define explicit outcomes for invalid envelopes, unauthorized/unavailable material,
  unvalidated intent, invalid execution, unknown semantics, worker failure and genuine
  ambiguity. Valid snapshot candidates can use snapshot reconciliation under the new
  declared retention semantics; unsupported authoritative execution must not silently
  fall back. Invalid or unknown resolution/authorization actions never become hints.
- Keep the goal spec ahead of implementation. Update TS/Swift codecs, shared fixtures,
  client state-machine contracts and reference docs together. No versioned API or
  supported-operation advertisement. Review the concrete contract before enabling
  broader client emission.

## Remaining policy and storage work

- Add Canopy-wide and per-tree rule selection with retained configuration evidence.
  Keep format policy in the tool; clients must not reproduce merge policy.
- Measure on-demand worker latency, history growth and memory before adding supervised
  persistent workers or caching. Preserve bounded jobs, durable retries and exact
  receipts across tool upgrades.
- Adopt finer-grained inspection when clients can present it usefully. The tool
  supports source choices; initial Canopy policy exposes whole-file choices and
  enclosing structural decisions. Preserve independent review and coherent guards.
- Implement any future opaque-retention contract in TypeScript/Swift DTOs, reference
  API documentation and shared fixtures together. Exercise unknown payload round
  trips, false claims, missing/unauthorized references and operation-output bindings.
- Before garbage collection or packing, pin accepted/authored semantic roots, all
  transitive hidden/undo dependencies, staged inputs and results awaiting commit.
  Coordinate with [packfiles](../canopy-storage/001-pack-object-storage.md) and
  [fragment storage](../canopy-storage/002-composable-conflict-fragments.md).

Keep the portable spec ahead of implementation. Record implementation restrictions
in status/docs, not by weakening the contract. Additional retain-only or diagnostic
modes require their own specified semantics; they are not a second execution path
needed for this deployment.
