# `story` CLI reference

The `story` CLI places local folders at URLs on an overstoryd, moves them, and
gives agents on short-lived machines a synchronized checkout of chosen folders.
Four commands do most of the work: `story place`, `story mv`, and `story agent`
with its bundle. `story me create` is a once-per-person identity setup command;
`story sync` reports and steers what Story Sync is doing with a placed folder,
and `story daemon` is mainly for machine setup or troubleshooting.

From a checkout, run `bun run story -- <command>`. After `bun link`, use the
installed form shown below: `story <command>`.

## Quick start

```sh
# Create your profile identity once, and print its public TreeID.
story me create
story me

# Claim an account from the Story app (see the README), then install the
# per-user Story Sync service.
story daemon install

# Publish a local folder at a path under your claimed account, or place a
# remote tree at a local path.
story place ./notes https://garden.example/~joe/notes
story place https://garden.example/~joe/notes ~/Documents/notes

# Let an agent on another machine work in that folder: make a bundle here,
# then run the agent inside it there.
bundle=$(story agent create --place https://garden.example/~joe/notes notes)
STORY_CLOUD_BUNDLE="$bundle" story agent run -- claude -p "Tidy the notes"

# Inspect placements, or open a remote tree in the browser.
story sync status
story open https://garden.example/~joe/notes
```

## Conventions

- Local paths may be relative on input. Output and persisted placements use
  canonical absolute paths.
- Canonical tree locations may be HTTPS URLs or `overstory://` locators.
- `--dry-run` may perform ordinary synchronization needed to establish a clean
  preflight, but does not apply the requested move or edit placement or
  canonical configuration.
- Commands select Story Sync in this order: `STORY_SYNC_URL`, the active
  cloud session containing the command's local path, then the persistent
  daemon on the well-known loopback port. The CLI never starts a private
  Story Sync for a command: when none answers it fails and names the command
  that starts one (`story daemon start`, or `story-sync --control` under an
  explicit `STORY_HOME`). Reads that depend only on durable
  configuration (`story me`, the account list in `story sync status`) work without
  a daemon.
- Successful commands exit `0`. Operational failures exit `1`; malformed usage
  exits `2` after printing the command synopsis.

## Folders and agents

### `story place`

```text
story place [--clear-access] [--access <subject>=<read|write|none>[,...]] <local-path> <canonical-url>
story place <canonical-url> <local-path>
```

The local-first form creates or updates a hosted tree declaration and places
that tree at the supplied local folder. A new tree receives a generated
`TreeID`; no audience options means private access. `public` selects the
everyone subject, while `~handle` resolves the profile TreeID at the target
overstoryd. `--access` may be repeated or comma-separated. `none` removes a rule;
`--clear-access` removes every explicit rule before applying new assignments.

The canonical URL selects the claimed overstoryd account whose account address
contains it. For example, `https://garden.example/~joe/notes` belongs to the
account at `https://garden.example/~joe`. If account addresses are nested, Overstory
uses the most specific match; equally specific matches fail instead of being
guessed. Creating a tree requires the current device to administer that account.

The canonical-first form places an existing tree declared by the matching
claimed account at a local path. It does not accept audience options. Use
`story open` to browse a tree outside one of your claimed account namespaces.

```sh
story place --access public=read ./handbook https://garden.example/~joe/handbook
story place https://garden.example/~joe/handbook ~/Documents/handbook
```

A URL on another host selects your placement account there, once that
host's community has reserved your profile by its URL at your home host
(such as `https://garden.example/~joe`; [accounts §1.3](../overstory-spec/04-accounts-and-devices.md#13-placement-accounts)).
The first `story place` onto the host connects this device to that account
with its own device key; without a reservation it says what to ask the
host's administrators to reserve. Both forms then create or place the tree on that host,
under your placement root, and Story Sync syncs it there with the same device
key. The placement root's own URL, while the root is not yet active,
activates it with the folder's content; once active, place it with the
canonical-first form like any other tree. The home host is not involved:
the tree, its configuration and its history are the placement host's. The
folder is recorded in `placements.yaml` with that host
([the format](../architecture/story-sync/data-home.md#placementsyaml)).

```sh
# After orchard.example's community reserves https://garden.example/~joe as ~joe:
story place ./orchard https://orchard.example/~joe
story place ./research https://orchard.example/~joe/research
# On another device paired at your home host:
story place https://orchard.example/~joe/research ~/Documents/research
```

### `story mv`

```text
story mv [--dry-run] <placed-local-root> <new-local-path>
story mv [--dry-run] <source-canonical-url> <destination-canonical-url>
```

With two local paths, move one exact tree placement on the same filesystem.
Story Sync first requires the tree to be present, writable, clean, and idle. It
then closes the workspace watcher, renames the directory, atomically changes
`placements.yaml`, rebinds the existing inode-aware private workspace state,
and verifies that synchronization returns to idle. The `TreeID`, overstoryd,
canonical URL, ACL, contents, and accepted history do not change.

The destination must not exist. The source or destination may not overlap
another placed root; moving a nested placement closure and copying across
filesystems are not implemented. A failure rolls back both the placement record
and directory rename when possible.

`story mv` moves a placed root. Renaming a file or folder *inside* a placed tree
is an ordinary filesystem operation and is observed by Story Sync's watcher.

```sh
story mv --dry-run ~/Documents/todos-f ~/Documents/todos
story mv ~/Documents/todos-f ~/Documents/todos
```

With two canonical URLs on the same overstoryd account, rename the exact canonical
tree while leaving its local folder, `TreeID`, contents, ACL, and accepted
history unchanged; this works on a placement host as on the home host. URLs on
two different hosts, such as the home host and a placement host, are refused:
a tree stays on the host that holds it.

Canonical moves require a present, idle local placement and administrator
access to the destination account. The destination must be vacant or an exact
resumable match. Separately placed local or canonical descendants are rejected;
`mv` never creates two simultaneous writable placements. Mixed local and
canonical operands are rejected: use `story place` to add a local or canonical
placement.

```sh
story mv --dry-run https://arb.example/~joe/todos-old https://arb.example/~joe/todos
story mv https://arb.example/~joe/todos-old https://arb.example/~joe/todos

story mv --dry-run https://old.example/~joe/todos https://arb.example/~joe/todos
story mv https://old.example/~joe/todos https://arb.example/~joe/todos
```

### `story agent`

```text
story agent create [--name <label>] --place <canonical-url> <relative-path> [...]
story agent list [--json]
story agent revoke <bundle-id>
story agent run [<bundle-string>] [--root <directory>] [--timeout <duration>] [-- <command> [<argument>...]]
story agent start [<bundle-string>] [--root <directory>] [--timeout <duration>] [--json]
story agent finish [--root <directory>] [--timeout <duration>] [--json]
```

An agent bundle is one revocable string that lets an agent on another machine
work in the folders you choose. Create it on an already configured
administrator device. Each `--place` pair names the canonical tree root and
its portable relative path beneath the agent's workspace:

```sh
bundle=$(story agent create --name "Coding agents" \
  --place https://garden.example/~joe/code code \
  --place https://garden.example/~joe/project-notes notes)
```

The command creates a dedicated non-administrator account device and prints one
`arbor-cloud-v2...` string to stdout. That string contains its credential and
the complete placement manifest. It is reusable, immutable, and secret. A
bundle is limited to one claimed Overstory account on one host, every selected
tree must be writable, and the encoded string may not exceed 32 KiB. Placement
paths are relative, disjoint, and cannot escape the chosen root.

Pass the string as an argument or through `STORY_CLOUD_BUNDLE`. Supplying both
is an error. The environment form avoids putting the credential in the
operating system's process-argument list.

`story agent run` is the whole session around one command:

```sh
# On a short-lived machine:
STORY_CLOUD_BUNDLE="$bundle" story agent run --root /workspace -- claude -p "Tidy the project notes"
```

It checks the folders out under the root, waits until every tree is present,
writable, idle, and exactly equal to its accepted overstoryd root, and runs
the command with the root as its working directory. When the command exits,
however it exits, `run` sends what is left and stops Story Sync. The command
inherits standard input, output and error; everything `run` itself says goes
to standard error. `STORY_CLOUD_BUNDLE` is removed from the command's
environment.

`run` exits with the command's status (128 plus the signal number when a
signal ended it), and with `75` when the command succeeded but its last
changes could not be sent; the session is then kept for `story agent finish`.
SIGINT and SIGTERM sent to `run` are passed to the command, and the final send
still happens. With no `-- <command>`, `run` starts `$SHELL` when standard
input is a terminal and is a usage error otherwise. `--timeout` bounds the
checkout and, separately, the final send.

`start` and `finish` are the same session in two steps, for a harness that
starts the agent itself:

```sh
STORY_CLOUD_BUNDLE="$bundle" story agent start --root /workspace

# Story Sync remains running.
cd /workspace/code
story sync status

# After the agent has stopped writing:
story agent finish --root /workspace
```

`start` defaults to the current directory and a five-minute timeout. It creates
an isolated owner-only data home and a detached loopback Story Sync in its own
process group, so it outlives a caller that ends the command's group. A new
destination must be absent or empty. Failed preparation retains downloaded
files and session state for another `start`, but stops the process it launched.

`finish` performs a final scan and sync, proves every local root equals the
accepted overstoryd root, and then stops that exact Story Sync instance. If it
cannot prove completion before its five-minute default timeout, it exits
nonzero, records `needs-sync`, and leaves the daemon and private state available
for another `finish`. SIGINT and SIGTERM make the daemon attempt the same final
sync, but only `finish`, or the end of `run`, provides the complete
verification contract.

On a Mac, Story's Share panel makes the same bundle for the tree it shows:
**Use with an agent…** places that one tree at its canonical name, shows the
string once with Copy and Share, and lists the tree's bundles with **Revoke**.
Like every bundle, its credential is an account device, so the string reaches
everything the account can; the placement only chooses what is checked out.

Bundles remain active until revoked. Their safe local registry, shared by the
CLI and Story, contains labels, device IDs, and placed TreeIDs, never
credentials or placement paths:

```sh
story agent list
story agent list --json
story agent revoke cb_0123456789abcdef0123456789abcdef
```

Revocation requires a configured administrator device. It removes the bundle's
device and cuts off current watches and future requests. It cannot retract data
that an agent's machine already downloaded. Creating a replacement bundle is the
way to change placements.

## Browser, identity and sync state

### `story open`

```text
story open [<locator>]
```

Open a local path, canonical remote URL, or `overstory://` locator in Story for the web. The
locator defaults to the current directory. The command attaches to the
compatible Story Sync that owns the data home (starting the installed macOS
service if it is stopped) and fails when none is reachable; run `story-sync
<root> --port 4317` yourself for an isolated foreground data home.

```sh
story open ~/Documents/notes
story open https://garden.example/~joe/notes
```

### `story me`

```text
story me
story me create [<profile-folder>] [--name <display-name>]
story me set [--name <display-name>] [--avatar <relative-path>] [--description <text>]
story me backup <file>
story me restore <file> [<profile-folder>]
story me accounts
story me device [--account <ConfigurationTreeID>]
```

`story me create` creates this person's one self-certifying profile identity.
The profile folder defaults to `~/.story/profile`; it must be empty or already
be the same valid person profile. The command writes a `type: person` root document
when needed, derives the public Profile TreeID from a new Ed25519 public key,
binds that TreeID to the local profile root, and stores the private key in
operating-system credential storage. It contacts no overstoryd and refuses to
replace another identity.

`story me` is read-only. It prints the public Profile TreeID, local profile
folder, and whether the corresponding private key is available. Send the
public TreeID to a host administrator; after they add that exact identity and
handle to the community profile, `story open <account-url>` presents the signed
account-claim flow. A host founder supplies the same public TreeID during
bootstrap.

`story me set` updates the profile root's presentation frontmatter while
preserving its body and unknown keys. The avatar path must name an existing
PNG, JPEG, GIF, or WebP file inside the profile folder. These fields are
presentation only; the Profile TreeID remains the identity.

`story me backup` writes a versioned backup of the same private key to a newly
created owner-readable file. It asks for a passphrase of at least four
characters, twice (or reads one from standard input when that is not a
terminal; never from an argument), and encrypts the backup under it; an empty
answer writes the key unencrypted. It never prints the key and refuses to
overwrite a path. The passphrase matters: the profile key claims accounts for
the profile, so an unencrypted backup is as good as the identity to anyone who
copies it.
`story me restore`
asks for the passphrase of an encrypted backup, still restores an older
unencrypted one, and validates the backup's public key and Profile TreeID
before restoring the private key and binding the chosen profile folder; it
refuses to replace a different local identity. Losing every copy of the
private key permanently loses the ability to prove that identity to another
host.

```sh
story me create
story me
story me backup ~/Documents/story-me.backup
```

A person who has lost every administrator device asks their host's operator
for a recovery pairing code (overstoryd: `overstoryd recover <handle>`) and pairs a
new device with it as usual; that device becomes the profile's only one.

`story me accounts` lists this installation's home account and the profile's
placement accounts, each with the folders placed on it. A placement account
([accounts §1.3](../overstory-spec/04-accounts-and-devices.md#13-placement-accounts))
is made by the other host, not claimed: its community reserves your profile
by its URL at your home host, which gives you a placement root at the
account's address, and that host accepts every device your home host lists.
`story place` connects to it on first use (above).

`story me device` prints this installation's device for an account and the key
it signs in with. Every device claims an account or pairs with an Ed25519 key
kept in operating-system credential storage, and opens hour-long sessions with
it. `--account` is needed only when several accounts are connected.

### `story sync status`

```text
story sync status [<locator>] [--json]
```

`story status` is short for `story sync status`.

With no locator, report the selected Story Sync runtime, connected accounts,
and tree placements. For the persistent daemon it also reports whether the
service is installed, its PID, and why it is not running when it is not. A locator may be a local path, a canonical HTTPS URL, or
an `overstory://` locator; the focused form reports its enclosing tree and sync
condition. The command never starts or synchronizes Story Sync and never edits
cloud-session state.

Human output is intended for diagnosis. `--json` returns a versioned object
with `ready`, context and runtime state, optional cloud-session state, live
accounts and trees, an optional selection, and safe diagnostics. A valid report
exits zero even when Story Sync is stopped or degraded; scripts inspect
`ready`, `runtime.state`, and tree conditions.

```sh
story sync status
story sync status ./notes
story sync status https://garden.example/~joe/notes --json
```

### `story sync pause`, `story sync resume`, `story sync pending`

```text
story sync pause <placed-path>
story sync resume <placed-path>
story sync pending <placed-path> [--json]
```

`story sync pause` stops Story Sync publishing the placed folder that holds
the path, until `story sync resume`, including across daemon restarts; accepted updates
from other devices still arrive. `story sync status` reports the tree as `paused`.
`story sync pending` shows exactly what Story Sync would send next: the accepted
base and candidate roots, the count of whole objects and deltas, each file
delta read against its base text (unchanged spans collapse to their byte count
and lines), each changed directory's added, removed and changed entries, and
new files with their text. `--json` prints the exact update request body.
Resume publishes the change the last `story sync pending` showed.

```sh
story sync pause ~/Documents/notes
story sync pending ~/Documents/notes
story sync resume ~/Documents/notes
```

### `story sync declined`

```text
story sync declined <placed-path> [--json]
story sync declined restore <placed-path>
story sync declined resend <placed-path>
```

When the host declines a folder change, the paths that change touched are
declined: they stay on disk and unpublished while the rest of the folder keeps
syncing in both directions, and `story sync status` reports the tree as
`declined`. `story sync declined` lists where the declined work is now (including
content moved out of a declined path) and the host's reason. Make those paths
match the host and they are released on the next scan. Otherwise `restore`
puts back the host's version and keeps your other changes, and `resend`
sends them again as they are, for when the reason has gone.

```sh
story sync declined ~/Documents/notes
story sync declined restore ~/Documents/notes
```

## Setup and troubleshooting

### `story daemon`

```text
story daemon <install|uninstall|start|stop|restart|logs>
story daemon run [--control]
```

Manage the default Story Sync user service. On macOS, CLI-owned installation
uses launchd; a signed Story app may own the same service registration instead.
`uninstall` removes only CLI-owned supervision and does not remove `~/.story`.
Linux and Windows supervision adapters are not implemented; there, run
`story daemon run --control` under your own service manager. `story sync
status` reports whether the service is installed and running.

## Related executables

`overstoryd` and `story-sync` are separate executables with their own process-level
options. Railway/VPS deployment procedures belong in
[`packages/overstoryd/deploy/README.md`](../../packages/overstoryd/deploy/README.md), not in this command reference.

## From the Mac app

Story for the Mac carries the `story` command and the Bun that runs it. Choose
**Story → Install Command Line Tool…** to link it at `/usr/local/bin/story`;
macOS asks for an administrator's password when that folder needs one. The
link points into the app, so the command updates with it. No separate Bun is
needed.

## Running with bunx

Install Bun first (the release is tested with Bun 1.4.2). The CLI package keeps
Bun as a runtime prerequisite; it does not include another runtime or require Node.
The package has one command, `story`, so `bunx @ovst/cli` runs it; `npx @ovst/cli`
does the same when Bun is installed. Version-pinned examples:

```sh
bunx @ovst/cli@0.1.0 sync status --json
bunx @ovst/cli@0.1.0 daemon install
bunx @ovst/cli@0.1.0 agent create --name agent --place https://community.example/~you/notes notes
# Set STORY_CLOUD_BUNDLE to the returned secret using your agent secret store.
bunx @ovst/cli@0.1.0 agent run --root ./agent-work -- <agent command>
# Or, where the harness starts the agent itself:
bunx @ovst/cli@0.1.0 agent start --root ./agent-work --json
bunx @ovst/cli@0.1.0 sync status ./agent-work --json
bunx @ovst/cli@0.1.0 agent finish --root ./agent-work --json
```

Ordinary synchronization commands attach to an existing service and report
install/start instructions when unavailable. macOS daemon installation preserves
packaged JavaScript and watcher dependencies under `~/Library/Application Support/Story/CLI/`,
independently of the bunx cache. Bun itself remains an installed prerequisite.
Linux users run `bunx @ovst/cli@0.1.0 daemon run --control`
under their service manager. Agent sessions start their own isolated runtime
without installing a persistent daemon. Headless identity operations can opt into
`STORY_CREDENTIAL_STORE=file`; this stores the private key in the private data
home with mode 0600, rather than using a desktop credential service.

`bun run build:cli:package` creates `dist/npm-cli`, a publishable package with
bundled workspace code and its native watcher dependency. Pack and test that
directory before publication; the repository workspace manifest is not the release
artifact. Publication and installed-service updates are separate actions.

Run `bun run test:cli:package` to build and install a tarball in a disposable
folder, exercise the real-host CLI/cloud tests against it, and (on macOS) verify
the durable helper after removing the installed package cache. Run this gate on
macOS arm64/x64 and Linux glibc arm64/x64 before release. It requires npm for the
pack/install verification, not for the shipped CLI runtime.
