# CLI
*Part of the [Arbor spec](../spec.md): the intended command surface. Implementation status belongs in [plan.md](../plan.md).*

Every operand that names content is an Arbor [locator](locators.md). Commands resolve locators through arbord and use its ordinary REST, mutation, and wire contracts; the CLI has no private storage API.

## Porcelain

These are the small commands people are expected to use directly:

- **`arbor browse <locator>`** — open TreeHopper at any resolvable live or historical locator.
- **`arbor sync <source> <destination> [-<mode>]`**:
  - if source is a local path and destination an `arbor://` URL, this gives the directory its identity and begins self-sync. Mode is `private`, `public-read`, or `public-write`, shorthand for the tree's `everyone` access;
  - if source is a canonical URL or access link and destination a local path, it claims access when necessary and starts syncing source to destination. If the source has a revision suffix, the placement is pinned read-only; otherwise it follows the live tip.
- **`arbor unsync <local-path>`** — remove one sync relationship without deleting its files, remote identity, or history.
- **`arbor share <locator> [<person-group-or-link>] [-read|-write|-none]`** — change whole-tree access:
  - with a personal-tree or same-authority group-document locator, add, change, or remove that subject's access idempotently;
  - without a person or group, create and print a revocable single-claim access link;
  - with an existing access link and `-none`, revoke it before or after claim.

`-read` is the default for additions and new links. `everyone` is the public subject, so `arbor share <locator> everyone -write` is the explicit form of `public-write`. Sharing a path inside a tree is invalid: give that subtree its own URL first, then share the resulting nested tree.

A personal profile needs no additional command family. Syncing a profile directory to the owner's authority root with `-public-read` initializes or reconciles the personal tree, and `browse` opens its ordinary root Markdown document:

```sh
arbor sync ./alice arbor://alice.example/ -public-read
arbor browse arbor://alice.example/
arbor share arbor://joe.example/atlas arbor://alice.example/ -write
```

The personal tree's root must be a `type: person` profile and remains public-read; the mode does not apply to independently permissioned child tree boundaries. A group can use the same root-shaped convention when its single group document is the root of a dedicated tree, but groups may also be documents elsewhere.

## Plumbing

These commands expose explicit administration, automation, conformance, or deployment mechanisms. TreeHopper and the porcelain commands normally compose them on a person's behalf.

- **`arbor serve`** — run the authority and live-publication gateway. The reference deployment reads `ARBOR_OWNER_TOKEN`, `ARBOR_PUBLIC_ORIGIN`, and `ARBOR_HOST_DATA` (or `RAILWAY_VOLUME_MOUNT_PATH`).
- **`arbor run <locator> [--input …]`** — invoke the script export or agent named by the locator and print its result or stream. Agents do not require a separate command family.
- **`arbor status [<locator>]`** — show the personal authority, resolved identity/revision, placement, public access, people and links, effective access, sync/conflict state, and safe diagnostics globally or for one locator.
- **`arbor connection set|test|remove <name>`** — administer safe database connection records while storing DSNs only in the operating-system credential store.
- **`arbor bake <locator>`** — emit a read-only ref/object snapshot for a dumb host.
- **`arbor deploy <locator> [--watch]`** — compile and deploy a custom application; this is separate from canonical live publication.
