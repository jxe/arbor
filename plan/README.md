# Arbor planning documents

Planning is grouped by kind of work so architecture, executor handoffs, debt,
and completed evidence do not compete in one flat queue.

- [`product/`](product/roadmap.md) — forward platform/product direction,
  concrete product implementation plans, and the editor/browser backlog. Agent
  work is split between [external CLI access](product/external-agent-cli-access.md)
  and [authority-hosted agents](product/authority-hosted-agents.md).
- [`native/`](native/README.md) — canonical native Arbor architecture plus its
  active numbered implementation handoffs.
- [`hardening/`](hardening/README.md) — known technical debt and the older
  audited defect-remediation handoffs. These plan numbers are scoped to the
  hardening workstream, not the native sequence.
- [`records/`](records/history.md) — implemented outcomes and verification
  evidence.

The former `advisor-plans/`, `execution/`, and `generated/` buckets have been
retired. Completed foundation Plan 000 is represented by its durable outcome
in history rather than by a finished executor file; native execution begins at
001 without renumbering stable plan IDs.
