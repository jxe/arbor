# Arbor local system reference

This document records replaceable local filesystem, daemon-state, and credential-storage choices in the current Arbor implementation. The synchronized cross-server configuration contract is normative in [configuration](../spec/04-accounts-and-devices.md); the loopback API is documented separately in [Local Arbor REST API](arborsync-api.md).

## Data home

The reference implementation uses `${ARBOR_DATA_HOME:-~/.arbor}` as one
private-state and credential namespace containing several account checkouts:

```text
${ARBOR_DATA_HOME:-~/.arbor}/
  placements.yaml
  accounts/
    <ConfigurationTreeID>/
      account.yaml
      trees.yaml
      devices.yaml
  .state/
    ...private arborsync state...
```

Each directory under `accounts/` is the source-preserving checkout of the
configuration tree named by that directory. `placements.yaml` is local-only
and groups absolute filesystem paths by configuration TreeID. The root-level
v1 `account.yaml`, `trees.yaml`, and `devices/` shape remains only behind a
named singleton compatibility adapter during the post-migration compatibility
window; current state uses the plural layout above.

`.state` is excluded from discovery, recursive watching, indexing, snapshots,
synchronization, and deletion. The current implementation stores refs, pending
updates, conflicts, managed replicas, the object index, journals, caches,
account-keyed credential references, diagnostics, and migration backups
beneath it. Those private names and layouts may change.

Beneath a placed root's `.state`, `index.sqlite` holds the workspace's object
store rows in an `objects` table: one row per absolute path the snapshot walk
encodes, for files and directories alike, with the file's stat tuple (size,
`mtime_ns`, `ctime_ns`, inode, device) and the hash of its wire object, indexed
by hash. The walk that computes a tree's root writes these rows, so they are
fresh whenever a root is; a file row is consulted only while its whole stat
tuple still matches, and a hit lets the walk skip reading that file. The index
is an optimization, never authority: the workspace re-runs an uncached walk
after it opens, after any watcher overflow or gap (a `batch` event), and every
30 minutes by default, logging a `diagnostic` event for each row whose cached
hash disagrees with the recomputed one and rewriting the row. Objects served
by hash are always verified against their hash before leaving the daemon; the
fetch-through cache for objects that live only on Canopy is in memory and
bounded.

Raw credentials use the platform credential facility where available and are
scoped by the selected data home and configuration TreeID. Origin alone is not
a credential key because two accounts may use one Canopy. Other
implementations may use an equivalent secret facility, but no raw credential
or access-link secret belongs in synchronized configuration or authored trees.

## Native working trees

iOS keeps each placed tree as a durable working tree beneath the app's private
support directory, keyed by the percent-encoded `TreeID`:

```text
<Application Support>/Arbor/
  WorkingTrees/<key>/
    wire-format               # format marker the tree was placed under
    materialized/tree.json    # WorkingTreeState, schema 2
    control/heads.json        # materialized, accepted, and pending roots
    journals/pages/<key>/     # crash journal for in-flight page transactions
    indexes/search.json       # search and page-identity index, rebuildable
    objects/<hash>            # the overlay: this tree's own unaccepted objects
  Sync/<key>/
    sync/update-control.json  # UpdateControl, schema 2: attempt, durable head, hold, conflict
    sync/objects/<hash>       # head objects too large to carry inline
```

Schema 2 node records hold a content reference, inline bytes or a hash with
its size and media type, instead of raw bytes. Markdown source stays inline;
every other file is a hash resolved on demand through the layered object store
(`objects/` first, then Canopy), so whole-tree hashing touches only directories
and Markdown and the tree neither fetches nor retains every object. The state
files are not decoded leniently: an older layout is re-placed from Canopy
rather than migrated in place. The format marker is `4` (content references,
the `WorkingTrees/` layout, `update-control.json`); a phone placed under an
older marker re-places from Canopy on its next launch, which discards edits
Canopy has not accepted yet, so the phone is synchronized before the build
that carries the new marker is installed.

The Mac keeps no content store. The app opens a tree the daemon has placed as
an in-memory working tree seeded from `GET /v1/bootstrap` (the folder's
directories and Markdown, every other file by hash) with an in-memory overlay,
and its platform object store is the control-mode daemon's `/v1/objects` route
over the placed folder. Only the coordinator's durable update control is
written beneath the app's support directory:

```text
<Application Support>/Arbor/
  Native Placement.json       # the placed trees the app has opened; the selected one is restored at launch
  Visits.json                 # app-side visit history: origin, tree descriptor, locator, time
  WorkingTrees/<key>/
    sync/update-control.json  # UpdateControl: attempt (adopted or own), durable head, hold, conflict
    sync/objects/<hash>       # head objects too large to carry inline
```

The daemon's per-tree state, the folder itself, and the configuration checkout
stay under the data home; the app edits `~/.arbor/accounts/<cfg>/trees.yaml`
and `devices.yaml` on disk exactly as the CLI does and asks the daemon to
synchronize. The control-mode daemon is the only launchd process: the app
attaches to it or launches it, never a per-folder daemon. Visits are the app's
own: a remote tree opened by locator is a read-only in-memory working tree
following that tree's Wire watch, anonymous unless an account at the same
origin holds a credential, with file bytes served by `/v1/objects?origin=`
when the daemon is running and by Canopy's object route otherwise.

## Daemon supervision

The reference CLI exposes `arbor daemon install|uninstall|start|stop|restart|status|logs` independently of the host service manager. The default data home has exactly one supervised local daemon and all native and command-line clients attach to its Arbor Sync REST origin. An explicit `ARBOR_DATA_HOME` remains an isolated foreground run instead of accidentally becoming a second default service.

macOS implements this contract as the per-user launchd label `org.nxhx.Arbor.arborsync`. A signed Arbor app registers its relocatable bundled agent with `SMAppService`; a CLI-only installation writes a user LaunchAgent pointing at that CLI installation. Both paths use the same label, port, control-mode daemon, and log location, so launchd cannot load competing owners. Future Linux and Windows adapters should preserve the commands and one-daemon-per-data-home invariant while translating them to the native user-service manager.

## Watching and local activation

Arbor Sync watches every `accounts/<ConfigurationTreeID>/` checkout and the
local `placements.yaml` independently. A valid account edit is synchronized as
an ordinary account-tree change. An invalid candidate leaves that account's
last fully valid projection active without removing other accounts; an invalid
placement file likewise retains the last valid placement projection. Both
produce safe diagnostics. The v1 watcher remains only inside the removable
singleton adapter during its compatibility window.

The configuration checkout is edited on disk, not through the daemon. The CLI
(`arbor place`, `arbor mv`, cloud bundle revocation) and, later, the Mac app
rewrite `trees.yaml`, `account.yaml`, or `devices.yaml` in place under
`accounts/<ConfigurationTreeID>/` with an atomic temporary-file-and-rename
write, then ask Arbor Sync to synchronize that account. The checkout is a placed
folder like any other: the daemon watches it, validates the candidate, and
pushes it; if the account's Canopy is unreachable the edit simply waits on disk
and is pushed on reconnect. Editors refuse to write while the daemon reports the
configuration tree in conflict.

A declared placement may sit beneath the data home as a separate mounted tree. Local discovery, watching, indexing, snapshots, pushes, pulls, and deletion stop at every mounted tree root. Removing a placement stops replication without deleting its files or remote identity.

## Scopes and durability

The reference daemon knows only actual Arbor trees: placed roots, pathless replicas, and the account-configuration tree, each named by its TreeID. The former `local` scope for untracked filesystem content and the `system:` scope for diagnostics, visits, recovery, and conflict summaries went with the daemon's editor path (Native 022 Phase 7). Status, conflicts, and credential availability are ordinary control-surface responses (`GET /v1/trees`, `GET /v1/conflicts`, `GET /v1/accounts`); browsing an unplaced remote tree is the app's own working-tree visit, served objects through `GET /v1/objects?origin=`, and creates no daemon-side visit record or cache directory.

A pathless placement creates a durable writable private replica. The daemon has no authored-mutation path of its own: the placed folder is its only local source, external filesystem changes are observed and become the next filesystem candidate, and accepted Canopy state is materialized only after its objects, heads, and requests are durable. Editors keep their own working tree, journal, and recovery.

## Loopback credential exposure

The daemon serves the stored Canopy account credential to any local process
over `GET /v1/credential` on its loopback socket. This is deliberate: a local
process running as the user can already read the credential store and write
the placed folders the daemon synchronizes under that credential, so handing
it the token grants nothing further. The
point is one device identity per installation: the Mac app and the daemon are
one device to Canopy, sharing a request-digest scope, which is what lets the
app adopt the daemon's stored pending update as its own. The socket binds to
loopback only and rejects non-loopback `Host` headers; the credential itself
still lives in the platform credential store (or the file store when
`ARBOR_CREDENTIAL_STORE=file`) and is never written to the tree.

## Migration

The alpha implementation moved legacy caches, rehearsal state, Finder
metadata, registries, journals, and recovery data beneath `.state` without
moving declared authored-tree placements. The account-layout cutover ran as an
explicit offline migration: it converted the synchronized v1 graph to v2 and
extracted OS paths into local `placements.yaml`. Its repository artifact and
compatibility readers remain during the rollback window, but normal startup
does not perform that conversion implicitly.
