# CLI
*Part of the [Arbor spec](../spec.md): the intended command surface. Implementation status belongs in [plan.md](../plan.md).*

Every operand that names content is an Arbor [locator](locators.md). Commands resolve locators through arbord and use its ordinary REST, mutation, and wire contracts; the CLI has no private storage API.

## Porcelain

These are the small commands people are expected to use directly:

- **`arbor browse <locator>`** — open TreeHopper at any resolvable live or historical locator.
- **`arbor sync <source> <destination> [-<mode>]`**:
  - if source is a local path and destination an arbor:// URL, this makes the dir available for syncing on other machines plus possibly published and visible to other people. mode is `private`, `public-read`, or `public-write`;
  - if source is a canonical URL and destination a local path, starts syncing a to b. If the source has a revision suffix, the placement is pinned read-only; otherwise it follows the live tip.
- **`arbor unsync <local-path>`** — remove one sync relationship without deleting its files, remote identity, or history.

## Plumbing

These commands expose explicit administration, automation, conformance, or deployment mechanisms. TreeHopper and the porcelain commands normally compose them on a person's behalf.

- **`arbor serve`** — run the authority and live-publication gateway. The reference deployment reads `ARBOR_OWNER_TOKEN`, `ARBOR_PUBLIC_ORIGIN`, and `ARBOR_HOST_DATA` (or `RAILWAY_VOLUME_MOUNT_PATH`).
- **`arbor run <locator> [--input …]`** — invoke the script export or agent named by the locator and print its result or stream. Agents do not require a separate command family.
- **`arbor status [<locator>]`** — show the personal authority, resolved identity/revision, placement, effective access, sync/conflict state, and safe diagnostics globally or for one locator.
- **`arbor invite create <locator> [--subtree …] [--rights …] [--recipient …]`** — create a revocable grant and invitation on an existing tree.
- **`arbor invite accept <descriptor> <local-path> [--read-only]`** — verify an invitation, store its credential, and create a placement with an optional stricter ceiling.
- **`arbor grant set <grant> [--subtree …] [--rights …]`** and **`arbor grant revoke <grant>`** — adjust or revoke recipient authority without renaming the tree.
- **`arbor connection set|test|remove <name>`** — administer safe database connection records while storing DSNs only in the operating-system credential store.
- **`arbor bake <locator>`** — emit a read-only ref/object snapshot for a dumb host.
- **`arbor deploy <locator> [--watch]`** — compile and deploy a custom application; this is separate from canonical live publication.
