# Apps 013: one plan per view, not per input

**Why and when:** later (Joe, 2026-11-08). The host learns what a view reads by running it
once over stand-in rows; that record is the plan the SQLite engine runs. Today that run uses
the real input, so the input's values are baked into the plan as constants:
`listOwner({id: A})` and `listOwner({id: B})` are two plans, each traced and cached. Answers
are right, but every new input pays for a trace, and the cache grows with inputs rather
than views. Split from Apps 005.

## Status

**PLANNED · M effort · low risk.** After
[Apps 005](../../status.md#views-on-the-host-and-declared-views--2026-11-08).

## 1. Trace with tagged inputs

- Trace with tagged stand-ins for the input's values, so a plan holds parameters that each
  request fills in.
- Code that branches on an input's value (`if (input.id === …)`, string operations) makes
  the trace notice and fall back to a plan per input for that view, the way a missed read
  widens.

**Verify:** two inputs to `listOwner` reuse one plan and give the same answers as now; a view
that branches on its input still answers correctly.

## Completion

Run `bun run typecheck`, `bun run test` and `bun run check:links`. Record evidence in
`status.md` and delete the plan.
