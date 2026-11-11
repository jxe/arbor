# Apps 017: host plugins

**Why and when:** later. Split from the old "USL plugins" sketch (Joe, 2026-11-11): the
plugins with effects on shared data, which only a host runs.

## Status

**SKETCH · no timing.** Needs [Apps 010](apps-010-activation-and-lending.md)'s authority
model first.

## Two kinds

- **Sources over shared tables:** `table Weather = source http.poll("https://…", every: 10min)`.
  They declare the hosts they reach, and that is what consent shows.
- **Sinks:** effects run after a mutation is accepted, such as sending an email. The mirror
  image of a source. Durable runs are [Apps 006](apps-006-durable-authoring.md).

## Completion

When a part is decided, it moves into the spec and a build plan. Delete this sketch when
nothing undecided is left in it.
