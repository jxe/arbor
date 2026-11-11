# Apps 017: bots

**Why and when:** later. Joe, 2026-11-11: code with effects on shared data won't be a host
plugin at all. Like a Telegram bot, a bot is a program someone runs on their own cloud
machine that talks to overstoryd over the ordinary Overstory API. Beetle stays code-free,
and overstoryd never runs anyone's code. Client-side code is
[Apps 014](apps-014-client-plugins.md); common value types (dates, durations, numbers)
should be Beetle built-ins rather than plugins.

## Status

**SKETCH · no timing.** Absorbs the old "pure plugins" (Apps 016, deleted) and "host
plugins" sketches. Probably after [Apps 010](apps-010-activation-and-lending.md)'s authority
model.

## What bots do

- **Feed data in.** Poll a weather service, import a calendar, mirror an RSS feed: the
  bot writes rows by calling mutations or sending row updates.
- **Act on changes** (the old "sinks"). Send an email when a row appears, post to a chat:
  the bot watches a view or collection and reacts.
- **Compute what Beetle can't.** Derived values (word counts, extracted images, embeddings,
  rankings) written back as ordinary fields, so views filter and sort on them like any data.

## The shape (to decide)

- **Identity:** a bot is an account (or an agent of one) with its own device key, so access
  control grants it trees like a person, and consent is just sharing with it.
- **Listening:** the ordinary watch API over views and collections; perhaps a webhook
  form for bots that can't hold a stream open.
- **Writing:** the views and mutate routes, like any client; its writes show its identity.
- **Hosting:** someone's own machine at first; a template (like the self-hosted community
  template) later.

## Open questions

- Whether a mutation or schema can name a bot to call after acceptance, or bots only watch.
- How a reader sees that a bot keeps a field up to date, and what happens when it's offline.
- Rate and size limits for bot writes on the host.

## Completion

When decided, it moves into the spec and a build plan. Delete this sketch when nothing
undecided is left in it.
