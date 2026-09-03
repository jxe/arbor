# Arbor plans

Active planning is organized first around substantial projects with a shared
outcome. Cross-cutting themes hold independent maintenance work that does not
belong to one project. Numbers are stable identifiers within each folder, not
a global execution sequence; priority and dependencies live in each index.

## Major projects

- [`roadmap.md`](roadmap.md) — the forward product map across projects.
- [`apps/`](apps/README.md) — executable applications, their compiler and
  runtime, and Canopy-hosted agents.
- [`postgres/`](postgres/README.md) — the Postgres child provider, observation,
  and local SQLite materializations.
- [`canopy-storage/`](canopy-storage/README.md) — efficient physical storage of
  Canopy objects and accepted history, including packfiles.

## Smaller projects

- [`smaller-projects/`](smaller-projects/README.md) — bounded outcome work that
  does not yet justify a top-level project: representation equivalence, locator
  grammar, native offline collection rows, external-agent access, and the web
  editor backlog.

Promote a cluster from `smaller-projects` when it accumulates several related
plans with one durable outcome. Do not create a one-file top-level directory
merely to avoid the smaller-project index.

## Cross-cutting themes

- [`cleanups/`](cleanups/README.md) — bounded deletion, simplification, and
  deduplication.
- [`security/`](security/README.md) — authorization, secrets, hostile input,
  sandboxing, and trust boundaries.
- [`speed/`](speed/README.md) — measured unnecessary rebuilding, scans, and
  response costs.
- [`reliability/`](reliability/README.md) — concurrency, recovery, lifecycle,
  and conditional correctness.
- [`testing/`](testing/README.md) — missing or unreliable evidence for
  important invariants.

Each theme contains executor-ready numbered plans plus a smaller-items table
for conditional, not-yet-designed, or independently minor work.

## Completed work

- [`_done/`](_done/README.md) — completed, rejected, and superseded plans plus
  durable implementation evidence. The underscore keeps it adjacent to the
  active plans while sorting it out of the project list.

Deployment migrations are not plans. Each lives in its own directory under
[`migrations/`](../migrations/README.md) with the reusable procedure and tools,
and is deleted after its cutover; a plan whose change needs one links there.

An active plan describes only work that remains. When it is completed, move
its executor document to `_done/` without erasing the identifier used by old
commits and discussions, record the outcome and verification evidence, and
leave only a short dependency link in any continuing plan.
