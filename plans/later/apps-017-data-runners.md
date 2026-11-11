# Apps 017: runners for data work

**Why and when:** later. Joe, 2026-11-11: code with effects on shared data won't run in
the host. Like a Telegram bot, it is a program someone runs on their own machine that talks
to overstoryd over the ordinary Overstory API, and that is what a **runner** already is
([Agents 002](../../status.md#agents-002-run-tasks-from-anywhere--2026-11-07),
[Agents 005](../features/agents-005-webhook-runners.md)). So there is one concept: a runner
is a device of your account that runs somewhere and does work for you. An agent runner
handles run requests; this plan lets runners handle data events too. Beetle stays code-free
and overstoryd never runs anyone's code. Client-side code is
[Apps 014](apps-014-client-plugins.md); common value types (dates, durations, numbers) should
be Beetle built-ins.

## Status

**SKETCH · no timing.** After Agents 005 (the Runners list and webhook delivery). Replaces
the old "pure plugins" (Apps 016, deleted) and "host plugins" sketches.

## What runners do with data

- **Feed data in.** Poll a weather service, import a calendar, mirror an RSS feed: the
  runner writes rows by calling mutations or sending row updates.
- **Act on changes** (the old "sinks"). Send an email when a row appears, post to a chat.
- **Compute what Beetle can't.** Derived values (word counts, extracted images, embeddings,
  rankings) written back as ordinary fields, so views filter and sort on them like any data.

## Built on runners as they are

- **Identity.** A runner is a device of your account in `runners.yaml`; revoking the device
  removes it. Its writes show as you, as your agents do in presence. Access is whatever
  your account has.
- **Delivery, two ways.** A present runner gets a message while connected; a webhook runner
  gets a POST with a secret. A runner that can't hold a stream open uses webhooks.
- **Requests, more kinds.** Besides a run request: rows changed in a view the runner
  watches, a mutation accepted, a schedule fired. A runner's entry says which it handles.

## Open questions

- How a runner subscribes: an entry in `runners.yaml` naming views or collections, or the
  ordinary watch API while it is present.
- Whether a mutation or schema can name a runner to call after acceptance, or runners
  only watch.
- How a reader sees that a runner keeps a field up to date, and what happens when it's
  offline.
- Whether a community's shared runner (not one person's device) is needed, and whose it is.

## Completion

When decided, it moves into the spec and a build plan. Delete this sketch when nothing
undecided is left in it.
