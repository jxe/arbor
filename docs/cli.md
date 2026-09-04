# Arbor CLI reference

The Arbor CLI opens local or remote trees and places local folders through a
Canopy. Most of the time, you only need `arbor open` and `arbor place`.
`arbor me create` is a once-per-person identity setup command and `arbor
daemon` is mainly for machine setup or troubleshooting; the remaining commands
handle less common migration and administration work.

From a checkout, run `bun run arbor -- <command>`. After `bun link`, use the
installed form shown below: `arbor <command>`.

## Quick start

```sh
# One-time macOS setup, if the Arbor app is not already managing Arbor Sync.
arbor daemon install

# Once per person, create a self-certifying profile identity.
arbor me create

# Open the current folder in Arbor.
arbor open .

# Browse a remote tree without first placing it locally.
arbor open https://garden.example/~joe/notes

# Place a local folder at a canonical Canopy URL and keep it synchronized.
arbor place ./notes https://garden.example/~joe/notes

# Place an existing remote tree in a local folder and keep it synchronized.
arbor place https://garden.example/~joe/notes ~/Documents/notes
```

If Arbor Sync is already running, skip `arbor daemon install`. Run `arbor open`
with no locator to open the current directory. Skip `arbor me create` when an
identity already exists; it refuses to replace one.

## Conventions

- Local paths may be relative on input. Output and persisted placements use
  canonical absolute paths.
- Canonical tree locations may be HTTPS URLs or `arbor://` locators.
- `--dry-run` may perform ordinary synchronization needed to establish a clean
  preflight, but does not apply the requested move or edit placement or
  canonical configuration.
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

### `arbor place`

```text
arbor place [--clear-access] [--access <subject>=<read|write|none>[,...]] <local-path> <canonical-url>
arbor place <canonical-url> <local-path>
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
arbor place --access public=read ./handbook https://garden.example/~joe/handbook
arbor place https://garden.example/~joe/handbook ~/Documents/handbook
```

## Setup and troubleshooting

### `arbor me`

```text
arbor me
arbor me create [<profile-folder>]
arbor me backup <file>
arbor me restore <file> [<profile-folder>]
```

`arbor me create` creates this person's one self-certifying profile identity.
The profile folder defaults to `~/.arbor/profile`; it must be empty or already
be the same valid person profile. Arbor writes a `type: person` root document
when needed, derives the public Profile TreeID from a new Ed25519 public key,
binds that TreeID to the local profile root, and stores the private key in
operating-system credential storage. It contacts no Canopy and refuses to
replace another identity.

`arbor me` is read-only. It prints the public Profile TreeID, local profile
folder, and whether the corresponding private key is available. Send the
public TreeID to a Canopy administrator; after they add that exact identity and
handle to the community profile, `arbor open <account-url>` presents the signed
account-claim flow. A Canopy founder supplies the same public TreeID during
bootstrap.

`arbor me backup` writes a versioned backup containing the same private key to
a newly created owner-readable file. It never prints the key and refuses to
overwrite a path. The file is a secret and must be stored accordingly.
`arbor me restore` validates the backup's public key and Profile TreeID before
restoring the private key and binding the chosen profile folder; it refuses to
replace a different local identity. This initial generation has no separate
recovery key or key rotation: losing every copy of the private key permanently
loses the ability to prove that identity to another Canopy.

```sh
arbor me create
arbor me
arbor me backup ~/Documents/arbor-me.backup
```

### `arbor daemon`

```text
arbor daemon <install|uninstall|start|stop|restart|status|logs>
```

Manage the default Arbor Sync user service. On macOS, CLI-owned installation
uses launchd; a signed Arbor app may own the same service registration instead.
`uninstall` removes only CLI-owned supervision and does not remove `~/.arbor`.
Linux and Windows supervision adapters are not implemented.

## Other commands

This command moves an exact placed tree in either the local filesystem or its
canonical Canopy namespace.

### `arbor mv`

```text
arbor mv [--dry-run] <placed-local-root> <new-local-path>
arbor mv [--dry-run] <source-canonical-url> <destination-canonical-url>
```

With two local paths, move one exact tree placement on the same filesystem.
Arbor Sync first requires the tree to be present, writable, clean, and idle. It
then closes the workspace watcher, renames the directory, atomically changes
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
arbor mv --dry-run ~/Documents/todos-f ~/Documents/todos
arbor mv ~/Documents/todos-f ~/Documents/todos
```

With two canonical URLs on the same Canopy account, rename the exact canonical
tree while leaving its local folder, `TreeID`, contents, ACL, and accepted
history unchanged. With URLs belonging to different claimed Canopy accounts,
move the placement between those accounts. A cross-Canopy move preserves the
`TreeID`, current authored snapshot, local path, and ACL, starts a new accepted
history at the destination, and retains the source Canopy copy and declaration
for recovery.

Canonical moves require a present, idle local placement and administrator
access to the destination account. The destination must be vacant or an exact
resumable match. Separately placed local or canonical descendants are rejected;
`mv` never creates two simultaneous writable placements. Mixed local and
canonical operands are rejected: use `arbor place` to add a local or canonical
placement.

```sh
arbor mv --dry-run https://arb.example/~joe/todos-old https://arb.example/~joe/todos
arbor mv https://arb.example/~joe/todos-old https://arb.example/~joe/todos

arbor mv --dry-run https://old.example/~joe/todos https://arb.example/~joe/todos
arbor mv https://old.example/~joe/todos https://arb.example/~joe/todos
```

## Related executables

`canopyd` and `arborsync` are separate executables with their own process-level
options. Railway/VPS deployment procedures belong in
[`deploy/README.md`](../deploy/README.md), not in this command reference.
