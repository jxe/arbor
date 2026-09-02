# Arbor planning documents

Active planning is grouped either by the product outcome being changed or by
the reason cross-cutting work remains. Numbers are stable identifiers within a
workstream, not a global execution sequence; priority and real dependencies
live in each workstream index.

Outcome workstreams:

- [`roadmap.md`](roadmap.md) — the cross-workstream forward map.
- [`applications/`](applications/README.md) — authored Arbor applications and
  the execution capabilities they prove.
- [`data/`](data/README.md) — the logical node/data model, portable child
  backings, and replicated materializations.
- [`interfaces/`](interfaces/README.md) — native, web, CLI, and browser-facing
  ways people and tools use Arbor.

Cross-cutting workstreams:

- [`remove-later/`](remove-later/README.md) — compatibility readers, migration
  bridges, and recovery adapters with explicit deletion gates.
- [`overly-complex/`](overly-complex/README.md) — avoidable ownership and
  control-flow complexity awaiting a simpler proved boundary.
- [`duplication/`](duplication/README.md) — repeated invariants with concrete
  divergence risk, not merely similar-looking code.
- [`insecure/`](insecure/README.md) — injection, authorization, secrets,
  sandboxing, hostile input, and trust boundaries.
- [`correctness-and-reliability/`](correctness-and-reliability/README.md) —
  concurrency, recovery, lifecycle, and conditional correctness failures.
- [`slow/`](slow/README.md) — unnecessary rebuilding, unbounded scans, and
  measured scale costs.
- [`unverified/`](unverified/README.md) — missing or unreliable automated and
  manual evidence for important invariants.

Each cross-cutting index contains numbered executor-ready plans plus a smaller
items table for conditional, not-yet-designed, or independently minor work.
- [`history/`](history/README.md) — completed, rejected, and superseded plans,
  plus durable implementation evidence.

Deployment migrations are not plans. Each lives in its own directory under
[`migrations/`](../migrations/README.md) with the reusable procedure and tools,
and is deleted after its cutover; a plan whose change needs one links there.

An active plan should describe only work that remains. When a milestone is
completed, move its executor document to `history/` without renumbering its
historical identifier, record the outcome and verification evidence, and leave
only a short dependency link in any continuing plan.
