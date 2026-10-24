# Schema language 005: publish USL 0.3.0 and move the sites

**Why and when:** collections that sync landed on main on 2026-10-24
([status](../../status.md#collections-that-sync--2026-10-24)), with the layered
USL as `@ovst/usl` 0.3.0 in `packages/usl`. The package is not published, and
the three sites that read USL through cranberries still use the 0.2.0 syntax.
Joe deferred both on 2026-10-24 to focus on Overstory and Story. Take it when
one of the sites is next worked on, or before Schema language 002's site ports.

## Status

- **Effort:** S to M (the sites' deploys are most of it).
- **Risk:** LOW for publishing; MEDIUM for each site, whose schema change ships with a deploy.
- **Depends on:** Joe's npm OTP.

## What is left

The live sites keep working meanwhile: cranberries pins `@ovst/usl` `^0.2.0`,
whose `documentFromUsl` maps `@@editableBy` to `owners`.

1. **Publish.** `npm publish --access public` in `packages/usl` (Joe's OTP), or
   let the next `tools/release.sh` do it.
2. **cranberries.** Move to `^0.3.0`. `documentFromUsl` must stop reading
   `@@editableBy`, which 0.3.0 rejects; decide where a site's owners come from
   instead (cranberries config, as `owners` already is). Rewrite its tests'
   schemas with `usl fmt`. Tag a v0.4.x release.
3. **excellences** (its `lib/schema.usl`; the unpushed `link-auth` branch on
   Joe's Mac is the port to cranberries 0.4) and **supplies-remake**. Rewrite
   each schema in the layered form, bump the cranberries pin, deploy, and check
   that each site reads and writes as before.

## Close out

Record the published version and the sites' commits in `status.md` and delete
this plan.
