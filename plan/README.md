# Arbor planning documents

Active planning is grouped by the outcome or interface being changed. Numbers
are stable identifiers within a workstream, not a global execution sequence;
priority and real dependencies live in each workstream index.

- [`roadmap.md`](roadmap.md) — the cross-workstream forward map.
- [`applications/`](applications/README.md) — authored Arbor applications and
  the execution capabilities they prove.
- [`data/`](data/README.md) — the logical node/data model, portable store
  representations, and replicated materializations.
- [`interfaces/`](interfaces/README.md) — native, web, CLI, and browser-facing
  ways people and tools use Arbor.
- [`hardening/`](hardening/README.md) — correctness, security, performance, and
  delivery work that cuts across product milestones.
- [`history/`](history/README.md) — completed, rejected, and superseded plans,
  plus durable implementation evidence.

An active plan should describe only work that remains. When a milestone is
completed, move its executor document to `history/` without renumbering its
historical identifier, record the outcome and verification evidence, and leave
only a short dependency link in any continuing plan.
