# Arbor CLI
*Reference command surface for the current Arbor implementation.*

Every content operand is an Arbor [locator](../spec/04-locators.md) or a local
arborsync address. The CLI resolves
through arborsync or a server and never edits guessed private `.state` files.

## Workspace, account, and synchronization

- `arbor open <locator>` opens a local, remote, live, historical, or safe
  `system:` location in the configured client.
- `arbor status [<locator>]` reports explicit resolved tree/path, historical
  state, placement, access, synchronization/activation, conflicts, diagnostics,
  and safe account identity.
- `arbor connect <community-url>` installs an already-issued local credential
  reference for this isolated data home; it is bootstrap, not a steady-state
  account mutation.
- `arbor sync [--access <subject>=<level> ...] [--clear-access] <local-path>
  <canonical-locator>` generates a `TreeID`, adds a `trees.yaml` declaration,
  and adds the current device's filesystem placement. Activation is the tree's
  first update, submitted with a null base.
- `arbor sync <tree-locator> <local-path>` adds or changes the current device's
  placement for an existing tree. A pathless-placement option creates a durable
  private writable replica. Historical locators cannot be placed.
- `arbor rehome [--check] <local-path|canonical-locator|arbor://TreeID>
  <destination-canonical-locator>` switches one present, idle tree placement to
  another already-claimed Canopy account. It preserves the `TreeID`, current
  authored snapshot, local path, and ACL while beginning a new accepted history
  at the destination. `--check` performs the complete preflight without writing.
  The source Canopy copy and declaration are retained for recovery; rehome does
  not migrate history or permit two local writable placements. Trees with nested
  placed boundaries are rejected until closure moves are implemented.
- `arbor unsync <local-path-or-tree-locator>` removes only the current device's
  placement entry. It never deletes files, identity, history, ACLs, canonical
  boundaries, or another device's placement.
- Access, group creation, canonical-boundary changes, administrator changes,
  device revocation, and community/profile connection are YAML transformations
  of `trees.yaml`, `account.yaml`, or an authorized device file.
- `arbor connection set|test|remove <name>` manages safe private connection
  metadata while credentials remain in the OS credential store.

Until the explicit offline account-layout migration, `connect`, `sync`, and
`unsync` remain the named v1 singleton compatibility surface. Fresh plural
account claims and account-qualified pairing are available through Arbor Sync's
REST, web, and native account surfaces; the CLI must not guess an account when
several configuration TreeIDs are present.

## Local daemon lifecycle

`arbor daemon install|uninstall|start|stop|restart|status|logs` is the
platform-neutral lifecycle surface for the one local daemon that owns the
default Arbor data home. The command vocabulary is stable across operating
systems; each platform supplies its own user-service adapter.

On macOS, CLI-only installations use a per-user launchd agent. The signed
native Arbor app registers the same label and bundled executable through
`SMAppService`. The two registration paths are alternatives beneath the same
CLI contract, never two daemons. `start`, `stop`, and `restart` control either
loaded agent. `uninstall` removes a CLI-owned agent without removing
`~/.arbor`; app-owned registration remains owned by the app.

An explicit `ARBOR_DATA_HOME` is an isolated foreground context and is not
silently registered as the user's default service. Linux and Windows service
adapters are not implemented yet; an existing `arborsync --control` process is
still a compatible daemon there.

All CLI-authored configuration edits are guarded exact UTF-8 writes through
arborsync's `writeText` operation. They preserve unrelated YAML comments and
mapping order. The CLI obtains a fresh ID from `POST /v1/tree-ids`; arborsync does
not insert IDs or normalize files. A raw access-link secret is generated
locally, displayed once, and only its digest is added to an ACL.

`--access` accepts repeated or comma-separated assignments. `public` means the
`everyone` subject; `~<handle>` resolves to a stable profile `TreeID`. Levels
are `read`, `write`, and `none`, where `none` removes the semantic rule and is
never stored. `--clear-access` removes all explicit rules before following
assignments. A new declaration and placement may be separate accepted edits;
private activation status reports the intermediate pending state.

Device listing is enumeration of `devices/*.yaml`, including every device's
account-visible placements. Ordinary devices may edit only their own file.
Administrator revocation deletes the selected device file; Canopy
atomically revokes its credential when accepting the configuration update.

## Serving and authored programs

- `canopyd [data-directory] [--community <handle>] [--first-writer
  <handle>] [--url <origin>] [--hostname <host>] [--port <port>]` runs one
  community server. Startup performs restart-idempotent account-config
  migration before retiring legacy state.
- `arbor run <script-or-agent-locator>[#handle] [--input <json>]` invokes a
  validated, explicitly scoped script or agent.
- `arbor bake <locator> [--output <directory>]` emits a self-contained public
  projection preserving Arbor identity and links.
- `arbor deploy <locator> [--watch] [--target <name>]` publishes a portable
  application/tree manifest without changing its access model.

Commands return nonzero on invalid configuration, unresolved locators,
conflicts, rejected policy, incomplete durability, or partial deployment.
Tutorial aliases, host-specific migration environment variables, credential
recovery procedures, and deployment recipes are outside this reference command surface.
