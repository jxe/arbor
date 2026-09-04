# Arbor plans

Active planning is organized around substantial projects with one shared outcome. Cross-cutting themes hold independent maintenance work. Numbers are stable identifiers within each directory, not a global execution sequence; priority and dependencies live in each index.

For what works now, use [status.md](../status.md). For portable behavior, use the [specification](../spec.md). The [documentation map](../docs/README.md) explains the remaining document types.

## Major projects

- [`apps/`](apps/README.md) — executable applications, compiler/tooling, Canopy-hosted presentation, agents, and the later portable-deployment outcome.
- [`postgres/`](postgres/README.md) — the Postgres child provider, observation, and local SQLite materializations.
- [`canopy-storage/`](canopy-storage/README.md) — measurement-gated physical storage of Canopy objects and accepted history.

## Smaller projects

- [`smaller-projects/`](smaller-projects/README.md) — bounded product/model outcomes and product gaps that do not yet justify a top-level project.

Promote a cluster only when several related plans share one durable outcome. Do not create a one-file top-level directory merely to avoid the smaller-project index.

## Cross-cutting themes

- [`cleanups/`](cleanups/README.md) — bounded deletion, simplification, and deduplication.
- [`security/`](security/README.md) — authorization, secrets, hostile input, sandboxing, and trust boundaries.
- [`speed/`](speed/README.md) — measured unnecessary rebuilding, scans, and response costs.
- [`reliability/`](reliability/README.md) — concurrency, recovery, lifecycle, and conditional correctness.
- [`testing/`](testing/README.md) — missing or unreliable evidence for important invariants.

Each theme contains executor-ready numbered plans plus a smaller-items table for conditional, not-yet-designed, or independently minor work. Continuous quality work belongs in those indexes rather than in a parallel roadmap checklist.

## Open questions and completed work

- [`open-questions.md`](open-questions.md) — unresolved design questions. An open question is not implementation status or an accepted executor plan.
- [`_done/`](_done/README.md) — completed, rejected, and superseded plans plus durable implementation evidence.

Deployment migrations are not plans. Each lives in its own directory under [`migrations/`](../migrations/README.md) with reusable procedure and tools, and is deleted after its cutover; a plan whose change needs one links there.

## Planning rules

- An active plan describes only work that remains. When completed, move its executor document to `_done/`, preserve the identifier used by old commits and discussions, and record verification evidence.
- **Implemented** means the focused behavior and acceptance checks pass in current source. **In progress** means source is incomplete. **Planned** has an accepted outcome and executable design. **Backlog** or **needs design** is not ready for implementation.
- Product priority is stated explicitly; filename order does not imply dependency order.
- Keep path-scoped access as a nested-tree boundary, groups as authored trees, and server history private unless an accepted product requirement changes those choices.
- Do not add a generic store, transport, credential, deployment, SDK-generation, replay, or production-HA framework without a second concrete implementation that needs it.
- Implement the smallest end-to-end system that proves visible behavior while preserving durable acknowledgement, conflict safety, deterministic protocol behavior, and cross-language agreement.
- Inspect source, tests, and `git status` before trusting any status label. Do not rewrite partial implementation as future work or weaken a future-facing specification to match a staged UI.
