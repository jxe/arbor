# CLI
*Part of the [Arbor spec](../spec.md): the command surface. Names and flags are provisional; each command notes the [plan](../plan.md) phase where it lands.*

## Development

- **`arbor dev <path>`** — run the dev server over a local subtree: watcher, index, browser (read-only in phase 1, editing from phase 2, islands from phase 3, agent chat from phase 4). The subtree is the whole world until arbord (phase 5) generalizes it to the workspace.
- **`arbor run <script>.tsx#<export> [--input …]`** — invoke a query or mutation through the same compiled handle a component uses, and print the JSON the component would see. *(phase 3)*
- **`arbor agent run <path>`** — run an agent file against the subtree with only its declared tools and context; from phase 5, inside a purpose-built namespace assembled from mounts. *(phases 4–5)*
- **`arbor status`** — workspace overview: watched roots, index freshness, mounts, sync state, and `system:diagnostics`.

## Publication

- **`arbor deploy [--watch]`** — compile a subtree into an ordinary website (Vercel/Cloudflare adapters); mints the subtree's `TreeID` on first deploy and emits dormant crosslinks. *(phase 6)*
- **`arbor bake`** — emit a shared-tree snapshot as a static ref/object directory for any dumb HTTP host ([wire.md](wire.md) §7). *(phase 9)*

## Sync and sharing

- **`arbor serve`** — host shared trees on a live reference endpoint (ref/obj/push/watch). *(phase 8)*
- **`arbor pull`** — fetch and verify a shared tree from an endpoint; the conformance and debugging client. *(phase 8)*
- **`arbor share <path>`** — create a shared tree from a folder, leave a mount at the same path, issue a scoped grant, and produce an invitation descriptor. Refuses or warns when the subtree is under foreign replication ([wire.md](wire.md) §5). *(phase 9)*
- **`arbor accept <descriptor>`** — validate an invitation, store the credential reference, choose a mount path, and create the `system:mounts` record. *(phase 9)*
- **`arbor mount`** — inspect and edit `system:mounts` from the CLI; equivalent to editing the records directly ([system.md](system.md) §1). *(phase 5)*

Every command is a client of arbord's localhost API plus the materialized files — the CLI has no private capabilities.
