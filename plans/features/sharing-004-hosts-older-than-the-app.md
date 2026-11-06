# Sharing 004: what Story says to a host older than it

**Timing:** before the Railway template is public. Starting your own community from the
template is built ([status](../../status.md#start-your-own-community-from-a-railway-template--2026-11-05));
publishing it is in [Joe's to-do](../joe.md#sharing-004-railway-template).

**Why and when:** Joe wants a newcomer to choose between asking a friend for an account and
running their own overstoryd from a Railway template (2026-11-04). Self-hosted hosts will lag
behind Story releases: a template service keeps the `ghcr.io/jxe/overstoryd:latest` it pulled
until its owner redeploys. Running a host may stay hard (Joe, 2026-10-28), but Story should
say plainly when a host is too old for it rather than fail in odd ways.

## Status

- **Effort**: S to M
- **Risk**: LOW
- **Depends on**: nothing

## Open

- **Old hosts, new apps.** Health already advertises capabilities. Decide what Story says when
  a host is too old for it (and where: the join screen, the toolbar, Sync & Accounts), and
  what it points the owner to (the deploy README's update steps: redeploy to pull a new
  image). Then build it.
- **Other hosting.** Fly and the docker-compose VPS recipe could get the same founder-code path
  later. Railway only for now.
