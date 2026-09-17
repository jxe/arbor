# Reliability 009: Retain, forward and validate operation intent in Canopy

Status: READY for contract design and incremental implementation on main. Priority:
P1. This plan owns the authoritative envelope, durable retention, worker integration
and acceptance. [008](008-enable-source-operations.md) owns client capture/submission;
[010](010-client-conflict-review.md) owns review. Operation interpretation, source
correspondence and language rules belong to Reliability 013
(`plans/_done/reliability/013-merge-operations-and-formats.md` on `codex/merge-tool`).

The merge process and shared immutable store are implemented at `7d30066` on
`codex/merge-tool`, not on main or deployed at this checkpoint. Inspect its implementation
before integrating it; do not rebuild another rule engine on main. Existing behavior
is recorded in [source execution](../../docs/exact-source-execution.md),
[accepted conflicts](../../docs/accepted-entry-conflicts.md) and
[the source queue](../../docs/source-admission-queue.md). Read source/tests first.

## Outcome

Canopy can durably accept and forward intent before a merge rule understands its
operation-specific meaning, without treating unverified client claims as trusted
semantic evidence. It owns authorization, accepted identity, retention, guards and
atomic commits. The tool owns execution and reconciliation proposals. Clients and
rules can then improve independently after the common retention contract is deployed.

## 1. Specify the retention contract before changing acceptance

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

## 2. Retain and authorize without interpreting every operation

- Validate tree scope, submitting authority, envelope shape and declared references;
  retain the exact operations, candidate and dependency bindings with accepted state.
  Never drop unknown-but-retainable payloads during decoding, retries or forwarding.
- Record authored claims separately from validation evidence, including the rule
  identity/revision/configuration and exact material used when verification occurs.
  Persist failed or unavailable validation appropriately without promoting a claim.
- Preserve candidate, accepted identity, conflict state, origins, observations and
  retained intent atomically. Cover accepted updates with unchanged roots and cases
  where retained intent must survive an otherwise unchanged submission.
- Keep accepted receipts immutable. A later tool may validate old intent for a new
  reconciliation or record additional evaluation evidence, but must not retroactively
  rewrite historical results, clear choices or change exact retry responses.
- Preserve historical reads and authorization of hidden alternatives. Missing ancestry
  is explicit; unavailable context never authorizes guessing correspondence.
- Specify retention for operation outputs, copies, deleted material, inverse fragments,
  undo activity and alternative dependencies. Rehearse any required schema migration
  on a backup; do not reset accepted history.

## 3. Integrate the merge executable as the semantic engine

- Bring the reviewed process/object-store implementation from `codex/merge-tool` onto
  main separately from these plans. Forward exact operations and immutable material
  through the normal base/current/incoming request; Canopy need not interpret each
  format-specific payload. Pass unresolved alternatives and complete dependency
  context when relevant, rather than only the visible projection.
- Resolve and authorize references at the Canopy boundary; let the tool validate
  operation execution and produce correspondence, merge results and decision proposals.
  Do not duplicate format or operation algorithms in Canopy as new families arrive.
- Validate returned object hashes, graph closure, request/input binding, scope,
  decision dependencies and allowed dispositions. Canopy assigns durable identities
  and checks user resolution guards and configured automatic-resolution policy.
  Existing choices survive omission. Coupled decisions commit atomically.
- Provide collection-only and shadow evaluation stages: store intent first; compare
  tool proposals against normal acceptance without committing them; then enable
  selected validated rules. Treat shadow output as diagnostics, not accepted truth.
- Preserve ordinary accepted ambiguity and continued publishing on safe worker
  failure paths. Where snapshot material is insufficient, retain work and report
  the specific failure rather than fabricate a result. Preserve account authorization.
- Configure Canopy defaults and per-tree rule selection, retaining rule/configuration
  evidence. Do not make clients mirror merge policy. Unknown/unavailable rules preserve
  evidence and use the explicitly specified fallback behavior.

## 4. Own process lifetime and durable conflict lifecycle

- Keep on-demand workers initially; measure latency and memory before adding supervised
  persistent workers. Enforce concurrency, queue, IO, deadline and cancellation bounds;
  clean up staging only after the worker exits and needed results are safely retained.
- Shared immutable storage needs no migration merely to split processes. Before GC or
  packing, pin active-job inputs, staged objects, outputs awaiting commit and historical
  alternative/provenance roots. Coordinate leases, recovery and pruning with
  [packfiles](../canopy-storage/001-pack-object-storage.md) and
  [fragment storage](../canopy-storage/002-composable-conflict-fragments.md).
- Integrate finer-grained tool decisions through the fragment-storage plan when ready;
  preserve exact source, nested dependencies, selected/hidden continuation, guarded
  partial resolution and unchanged-root transitions. Whole-entry choices remain a
  valid conservative result; finer storage is not an early-retention prerequisite.
- Extend authoritative inspection when new decisions require it, pairing TS/Swift
  DTOs and fixtures before clients use them. Keep format-specific evidence open within
  the shared contract and do not expose private database structure.

## Rollout and verification

Order: specify the retention semantics; deploy retention/forwarding support; enable
008's broader client submissions; install and shadow-evaluate tool improvements;
activate individual semantic rules. Tool development against fixtures can proceed
throughout. This is ordered compatibility, not a coordinated per-capability cutover.

Test unknown retained payload round trips, false claims, missing/unauthorized
references, output bindings, causal batches, exact replay, unchanged projections,
transaction rollback, restart, worker crash/timeout and upgrades between receipt and
retry. Verify validation cannot silently resolve accepted alternatives. Exercise live
Swift/TS clients against retain-only and semantically enabled configurations.

Use the existing [fragment proof](../../docs/conflict-fragment-storage.md) as evidence,
not a production migration shortcut. Run focused acceptance/storage tests, shared
conformance and [development gates](../../DEVELOPMENT.md). Measure incorrect automatic
resolutions separately from merge coverage. Record shipped behavior in status/docs;
remove completed tasks here. Keep implementation details out of the portable spec.
