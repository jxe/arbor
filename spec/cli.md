# Arbor CLI
*Part of the [Arbor spec](../spec.md): the portable command surface. Implementation status and operator procedures live elsewhere.*

Every content operand is an Arbor [locator](locators.md). The CLI resolves through arbord or the wire and does not manipulate guessed private-state files.

## Workspace and synchronization

- `arbor browse <locator>` opens the selected local, remote, live, historical, or `system:` location in the configured human client.
- `arbor status [<locator>]` reports resolved tree/path, live or historical root, placement, effective/public access, pending synchronization, conflicts, diagnostics, and active safe account/community identity.
- `arbor sync [--access <subject>=<level> ...] [--clear-access] <local-path> <canonical-locator>` promotes or reconciles a local directory and canonical boundary. A new boundary without access arguments is private; an existing boundary retains its ACL unless access arguments change it.
- `arbor sync <tree-locator> <local-path>` places and follows a live Arbor tree. Historical revision locators are rejected for persistent placement.
- `arbor unsync <local-path> [<canonical-locator>]` removes only the matching placement. It never deletes local files, remote identity/history, ACLs, or canonical boundaries.
- `arbor connect <community-url>` activates an already-issued account/device credential using the isolated Arbor data home.
- `arbor connection set|test|remove <name>` manages safe `system:connections` metadata while secrets remain in the credential facility.

`--access` accepts repeated or comma-separated complete assignments. `public` means `everyone`; `~<handle>` means a person/group profile in the destination community. Levels are `read`, `write`, and `none`. `--clear-access` removes every explicit entry before applying following assignments. New-tree promotion compiles the complete initial audience and commits it atomically with identity/boundary creation.

## Serving and authored programs

- `arbor serve [data-directory] [--community <handle>] [--first-writer <handle>] [--url <origin>] [--hostname <host>] [--port <port>]` runs one community authority and live HTTP projection. A fresh unattended host requires a community and reserved first writer; an existing host restarts from durable state without recreating identity.
- `arbor run <script-or-agent-locator>[#handle] [--input <json>]` invokes the resolved script handle or agent after validation, confinement, and any required consent. Machine-readable results go to stdout; diagnostics go to stderr.
- `arbor bake <locator> [--output <directory>]` emits a self-contained static ref/object/public projection that preserves links and Arbor crosslinks without live mutation handlers.
- `arbor deploy <locator> [--watch] [--target <name>]` publishes the portable application/tree manifest to a configured adapter while preserving the same access and handler contracts.

Commands return nonzero on unresolved locators, conflicts, rejected consent, incomplete durability, or partial deployment. `status`, `run`, `bake`, and `deploy` are normative even before a reference implementation ships them.

Tutorials, compatibility aliases, provider detection, migration environment variables, credential reset procedures, and host-specific deployment recipes are not CLI contract. Reference deployment documentation may define them without changing this surface.
