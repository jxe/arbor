# Arbor CLI reference

The Arbor CLI opens local or remote trees and connects local folders to a
Canopy. Most of the time, you only need `arbor open` and `arbor sync`.
`arbor daemon` is mainly for one-time setup or troubleshooting; the remaining
commands handle less common migration and administration work.

From a checkout, run `bun run arbor -- <command>`. After `bun link`, use the
installed form shown below: `arbor <command>`.

## Quick start

```sh
# One-time macOS setup, if the Arbor app is not already managing Arbor Sync.
arbor daemon install

# Open the current folder in Arbor.
arbor open .

# Browse a remote tree without first placing it locally.
arbor open https://garden.example/~joe/notes

# Publish a local folder at a canonical Canopy URL and keep it synchronized.
arbor sync ./notes https://garden.example/~joe/notes

# Place an existing remote tree in a local folder and keep it synchronized.
arbor sync https://garden.example/~joe/notes ~/Documents/notes
```

If Arbor Sync is already running, skip `arbor daemon install`. Run `arbor open`
with no locator to open the current directory.

## Conventions

- Local paths may be relative on input. Output and persisted placements use
  canonical absolute paths.
- Canonical tree locations may be HTTPS URLs or `arbor://` locators.
- `--check` may perform ordinary synchronization needed to establish a clean
  preflight, but does not apply the requested move or edit placement
  configuration.
- Commands use the persistent Arbor Sync daemon by default. `ARBOR_DATA_HOME`
  selects an isolated data home and runs a temporary foreground Arbor Sync for
  commands that need one. `ARBOR_SYNC_URL` selects an already-running compatible
  daemon.
- Successful commands exit `0`. Operational failures exit `1`; malformed usage
  exits `2` after printing the command synopsis.

## Commands you will usually use

### `arbor open`

```text
arbor open [<locator>]
```

Open a local path, canonical remote URL, or `arbor://` locator in Arbor web. The
locator defaults to the current directory. If a compatible persistent daemon is
available, the command attaches to it; an explicit `ARBOR_DATA_HOME` may instead
start a foreground server that runs until interrupted.

```sh
arbor open ~/Documents/notes
arbor open https://garden.example/~joe/notes
```

### `arbor sync`

```text
arbor sync [--clear-access] [--access <subject>=<read|write|none>[,...]] <local-path> <canonical-url>
arbor sync <canonical-url> <local-path>
```

The local-first form creates or updates a hosted tree declaration and places
that tree at the supplied local folder. A new tree receives a generated
`TreeID`; no audience options means private access. `public` selects the
everyone subject, while `~handle` resolves the profile TreeID at the target
Canopy. `--access` may be repeated or comma-separated. `none` removes a rule;
`--clear-access` removes every explicit rule before applying new assignments.

The canonical URL selects the claimed Canopy account whose account address
contains it. For example, `https://garden.example/~joe/notes` belongs to the
account at `https://garden.example/~joe`. If account addresses are nested, Arbor
uses the most specific match; equally specific matches fail instead of being
guessed. Creating a tree requires the current device to administer that account.

The canonical-first form places an existing tree declared by the matching
claimed account at a local path. It does not accept audience options. Use
`arbor open` to browse a tree outside one of your claimed account namespaces.

```sh
arbor sync --access public=read ./handbook https://garden.example/~joe/handbook
arbor sync https://garden.example/~joe/handbook ~/Documents/handbook
```

## Setup and troubleshooting

### `arbor daemon`

```text
arbor daemon <install|uninstall|start|stop|restart|status|logs>
```

Manage the default Arbor Sync user service. On macOS, CLI-owned installation
uses launchd; a signed Arbor app may own the same service registration instead.
`uninstall` removes only CLI-owned supervision and does not remove `~/.arbor`.
Linux and Windows supervision adapters are not implemented.

## Other commands

These commands are for moving placements and changing Canopies.

### `arbor mv`

```text
arbor mv [--check] <placed-local-root> <new-local-path>
```

Move one exact plural-layout tree placement on the same filesystem. Arbor Sync
first requires the tree to be present, writable, clean, and idle. It then closes
the workspace watcher, renames the directory, atomically changes
`placements.yaml`, rebinds the existing inode-aware private workspace state,
and verifies that synchronization returns to idle. The `TreeID`, Canopy,
canonical URL, ACL, contents, and accepted history do not change.

The destination must not exist. The source or destination may not overlap
another placed root; moving a nested placement closure and copying across
filesystems are not implemented. A failure rolls back both the placement record
and directory rename when possible.

`arbor mv` moves a placed root. Renaming a file or folder *inside* a placed tree
is an ordinary filesystem operation and is observed by Arbor's watcher.

```sh
arbor mv --check ~/Documents/todos-f ~/Documents/todos
arbor mv ~/Documents/todos-f ~/Documents/todos
```

### `arbor rehome`

```text
arbor rehome [--check] <local-path|canonical-url|arbor://TreeID> <destination-canonical-url>
```

Move one present, idle plural-layout tree placement to another already-claimed
Canopy account. Rehome preserves the `TreeID`, current authored snapshot, local
path, and ACL, but starts a new accepted history at the destination. The source
Canopy copy and declaration remain available for recovery.

The current device must administer the destination account. Destination paths
and TreeIDs must be vacant or agree exactly, and nested placed-tree closures are
rejected. `rehome` never creates a second simultaneous local writable placement.

```sh
arbor rehome --check ~/Documents/todos https://arb.example/~joe/todos
arbor rehome ~/Documents/todos https://arb.example/~joe/todos
```

## Related executables

`canopyd` and `arborsync` are separate executables with their own process-level
options. Railway/VPS deployment procedures belong in
[`deploy/README.md`](../deploy/README.md), not in this command reference.
