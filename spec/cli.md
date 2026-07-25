# CLI
*Part of the [Arbor spec](../spec.md): the command surface. Names and flags are provisional; each command notes the corresponding [plan](../plan.md) milestone.*

## Development

- **`arbor dev [path]`** — run the current reference server over a local subtree: watcher, index, browser, editing, collections, and the REST v1 boundary. `path` may be absolute or relative to the process working directory and defaults to `.`; shells may expand an unquoted leading `~`. Milestone 3 replaces the single physical root with the composed workspace; milestones 4–5 add islands and agent chat.
- **`arbor run <script>.tsx#<export> [--input …]`** — invoke a query or mutation through the same compiled handle a component uses, and print the JSON the component would see. *(milestone 4)*
- **`arbor agent run <path>`** — run an agent file against the workspace with only its declared tools and context, inside a purpose-built namespace assembled from mounts. *(milestone 5, using milestone 3 namespaces)*
- **`arbor status`** — workspace overview: watched roots, index freshness, mounts, sync state, and `system:diagnostics`.
- **`arbor connection set <name>`** — current bootstrap for a `_store.postgres` reference. Read a DSN interactively or from stdin, write only safe human-readable metadata to the private `system:connections` directory, and put the DSN in the operating-system credential store.
- **`arbor connection test <name>` / `arbor connection remove <name>`** — verify or remove that private connection without exposing its secret. Milestone 3 presents the same records through the complete `system:` tree; no migration is needed.

## Publication

- **`arbor deploy [--watch]`** — compile a subtree into an ordinary website for the two reference deployment targets; mints the subtree's `TreeID` on first deploy and emits dormant crosslinks. *(milestone 9)*
- **`arbor bake`** — emit a shared-tree snapshot as a static ref/object directory for any dumb HTTP host ([wire.md](wire.md) §7). *(milestone 9)*

## Sync and sharing

- **`arbor serve`** — host shared trees on a live reference endpoint (ref/obj/push/watch). *(milestone 7)*
- **`arbor pull`** — fetch and verify a shared tree from an endpoint; the conformance and debugging client. *(milestone 7)*
- **`arbor share <path>`** — create a shared tree from a folder, leave a mount at the same path, issue a scoped grant, and produce an invitation descriptor. Refuses or warns when the subtree is under foreign replication ([wire.md](wire.md) §5). *(milestone 8)*
- **`arbor accept <descriptor>`** — validate an invitation, store the credential reference, choose a mount path, and create the `system:mounts` record. *(milestone 8)*
- **`arbor mount`** — inspect and edit `system:mounts` from the CLI; equivalent to editing the records directly ([system.md](system.md) §1). *(milestone 3)*

Every authored CLI operation is a client of arbord's local [REST contract](arbord-rest.md); the CLI has no private daemon API and does not write behind arbord's back. Materialized files remain available to ordinary external tools, whose writes arbord observes as external rather than API-authored intent. The initial loopback reference has no general local authentication layer. Commands that exercise sharing, the wire, scripts, or deployed authority still present and enforce the grants declared by those features.
