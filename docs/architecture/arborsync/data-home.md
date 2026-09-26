# The Arbor data home

Replaceable local filesystem, daemon-state, and credential-storage choices of
Arbor Sync. The synchronized cross-host configuration contract is normative in
[accounts and devices](../../overstory-spec/04-accounts-and-devices.md); the loopback
API is in [the Arbor Sync REST API](../../implementing-sync-services/arborsync-api.md); what the Canopy app
keeps on disk is in [Canopy local state](../canopy-browser/local-state.md).

## Data home

The reference implementation uses `${ARBOR_DATA_HOME:-~/.arbor}` as one
private-state and credential namespace containing its account checkouts:

```text
${ARBOR_DATA_HOME:-~/.arbor}/
  placements.yaml
  accounts/
    <ConfigurationTreeID>/
      access.yaml
      mounts.yaml
      apps.yaml
      devices.yaml
  .state/
    ...private arborsync state...
```

Each directory under `accounts/` is the source-preserving checkout of a
person profile's tree configuration, named by its derived configuration
TreeID; the account's host origin and profile TreeID are kept with its
credential record, not in the checkout. A profile has one home host, so one
profile has one checkout. `placements.yaml` is local-only and groups absolute
filesystem paths by configuration TreeID. Other trees' configurations are
never checked out; clients read and edit them through the host.
`packages/canopyd/migrations/022-tree-configurations/rekey-data-home.ts`
moves a data home from the earlier random account-configuration TreeID to the
derived one. The plural layout above is the only supported account layout. The former
root-level account graph and singleton credential record were retired on
2026-09-21. Workspace registry records require `stateID`, `rootID`, and `path`;
existing `rt_` and `tr_` root identities are preserved unchanged. Incomplete
records fail with an offline-migration diagnostic before registry writes.

`.state` is excluded from discovery, recursive watching, indexing, snapshots,
synchronization, and deletion. The current implementation stores refs, pending
updates, conflicts, managed replicas, the object index, journals, caches,
account-keyed credential references, diagnostics, and migration backups
beneath it. Those private names and layouts may change.

Beneath a placed root's `.state`, `index.sqlite` holds the workspace's object
store rows in an `objects` table: one row per absolute path the snapshot walk
hashes, for files and directories alike, with the file's stat tuple (size,
`mtime_ns`, `ctime_ns`, inode, device) and the SHA-256 of its raw bytes, indexed
by hash. The walk that computes a tree's root writes these rows, so they are
fresh whenever a root is; a file row is consulted only while its whole stat
tuple still matches, and a hit lets the walk skip reading that file. The index
is an optimization, never authority: the workspace re-runs an uncached walk
after it opens, after any watcher overflow or gap (a `batch` event), and every
30 minutes by default, logging a `diagnostic` event for each row whose cached
hash disagrees with the recomputed one and rewriting the row. Objects served
by hash are always verified against their hash before leaving the daemon; the
fetch-through cache for objects that live only on canopyd is in memory and
bounded.

Raw credentials use the platform credential facility where available and are
scoped by the selected data home and configuration TreeID. Other
implementations may use an equivalent secret facility, but no raw credential
or access-link secret belongs in synchronized configuration or authored trees.

## Daemon supervision

The reference CLI exposes `arbor daemon install|uninstall|start|stop|restart|status|logs` independently of the host service manager. The default data home has exactly one supervised local daemon and all native and command-line clients attach to its Arbor Sync REST origin. An explicit `ARBOR_DATA_HOME` remains an isolated foreground run instead of accidentally becoming a second default service.

macOS implements this contract as the per-user launchd label `org.nxhx.Arbor.arborsync`. A signed Canopy app registers its relocatable bundled agent with `SMAppService`; a CLI-only installation writes a user LaunchAgent pointing at that CLI installation. Both paths use the same label, port, control-mode daemon, and log location, so launchd cannot load competing owners. Future Linux and Windows adapters should preserve the commands and one-daemon-per-data-home invariant while translating them to the native user-service manager.

## Watching and local activation

Arbor Sync watches every `accounts/<ConfigurationTreeID>/` checkout and the
local `placements.yaml` independently. A valid account edit is synchronized as
an ordinary account-tree change. An invalid candidate leaves that account's
last fully valid projection active without removing other accounts; an invalid
placement file likewise retains the last valid placement projection. Both
produce safe diagnostics.

The configuration checkout is edited on disk, not through the daemon. The CLI
(`arbor place`, `arbor mv`, cloud bundle revocation) and, later, the Mac app
rewrite `access.yaml`, `mounts.yaml`, `apps.yaml` or `devices.yaml` in place under
`accounts/<ConfigurationTreeID>/` with an atomic temporary-file-and-rename
write, then ask Arbor Sync to synchronize that account. The checkout is a placed
folder like any other: the daemon watches it, validates the candidate, and
pushes it; if the account's canopyd is unreachable the edit simply waits on disk
and is pushed on reconnect. Editors refuse to write while the daemon reports the
configuration tree in conflict.

A declared placement may sit beneath the data home as a separate mounted tree. Local discovery, watching, indexing, snapshots, pushes, pulls, and deletion stop at every mounted tree root. Removing a placement stops replication without deleting its files or remote identity.

## Ignored content

A placed folder follows its `.arborignore` and `.gitignore` files as
[directory format §7](../../overstory-spec/02-directory-format.md#7-tree-membership-and-ignore-files)
specifies: an ignored, untracked `.env`, cache, or build output is never
scanned into a change, uploaded, overwritten, or deleted by a pull, and stays
out of discovery, search, and generated types. `.gitignore` is read for
compatibility with the same grammar; `.arborignore` is the portable spelling
and wins beside it. The mandatory exclusions (`.git`, `node_modules`, `.arbor`,
`Trash`, `.build`, `DerivedData`, transaction temporaries, Finder's `.DS_Store`
and AppleDouble `._name` files, iCloud placeholders, nested mounts) apply
whatever the rules say. Git is never run, and
`.git/info/exclude`, `core.excludesFile`, and global Git ignore files are not
read, so a folder yields the same tree on every device.

An ignore file that is not valid UTF-8 applies no rules. The daemon reports a
`diagnostic` event naming that file, never its contents, and keeps
synchronizing.

"Tracked" needs no state of its own: it is the folder record's `known.root`,
the root the folder last held. A path in it keeps synchronizing after a rule
matches it, so adding a rule does not stop syncing an `.env` that was already
uploaded. To untrack one, move the file out of the folder, let the deletion
sync, then move it back; the rule then keeps it local. Its bytes remain in the
tree's accepted history, so a leaked secret must still be rotated. When a pull
changes the rules, the daemon keeps any local file either the old or the new
rules ignored, and publishes content that a removed rule uncovered.

## Scopes and durability

The reference daemon knows only actual Overstory trees: placed roots, pathless replicas, and the account's profile configuration, each named by its TreeID. The former `local` scope for untracked filesystem content and the `system:` scope for diagnostics, visits, recovery, and conflict summaries went with the daemon's editor path (Native 022 Phase 7). Status, held changes, and credential availability are ordinary control-surface responses (`GET /v1/trees`, `POST /v1/held/discard`, `GET /v1/accounts`); browsing an unplaced remote tree is the app's own working-tree visit, served objects through `GET /v1/objects?origin=`, and creates no daemon-side visit record or cache directory.

A pathless placement creates a durable writable private replica. The daemon has no authored-mutation path of its own: the placed folder is its only local source, external filesystem changes are scanned into local changes in the folder's change log (`<data home>/.state/trees/<base64url TreeID>/sync/`), and accepted canopyd state is written to the folder only when no local change is pending and the folder still holds what it last wrote or scanned. Editors keep their own working tree, journal, and recovery.

## Loopback credential exposure

The daemon serves the stored canopyd account credential to any local process
over `GET /v1/credential` on its loopback socket. This is deliberate: a local
process running as the user can already read the credential store and write
the placed folders the daemon synchronizes under that credential, so handing
it the token grants nothing further. The
point is one device identity per installation: the Mac app and the daemon are
one device to canopyd, sharing authentication and a request-digest scope while
remaining independent working-tree clients. The socket binds to
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

Overstory format 5 uses raw file payloads and typed directory entries. Sparse
bootstraps are rooted at the recorded accepted canopyd root and include its
directories and Markdown; daemon-local pending/conflict state is not part of
another client's installation. Other file sizes are unknown until read. On a format change, the daemon archives old refs and sync journals beneath
`.state/format-recovery/` before rebuilding indexes. Canopy on iOS retains
the old working tree and sync state beneath `FormatRecovery/` before rebootstrap.
These archives are recovery evidence and are never replayed automatically.

## Object-read diagnostics

The local byte lookup still tries indexed filesystem bytes, durable pending
objects and canopyd, in that order. A failed source may fall through to the next;
only hash-verified bytes are returned. Unexpected failures are written to daemon
logs with the `[arborsync:object-read]` prefix and structured source/reason fields.
Permission denial, IO failure, network/HTTP failure, malformed pending data and
hash mismatch remain distinguishable. Ordinary missing files and uncached old
hashes do not produce warnings. Use `arbor daemon logs` to inspect these records.

### Cloud placeholders

A placed folder may live in iCloud Drive or another macOS File Provider that
evicts file bytes and leaves dataless placeholders. Whether a read downloads a
placeholder or fails is a per-process kernel policy, and a launchd agent starts
with downloads off, so its reads of placeholder files and directories fail with
`EDEADLK`. The daemon entry point (`arborsync/src/cli.ts`, which the CLI's
LaunchAgent and the app's bundled helper both run) therefore turns on-demand
downloads on for its own process at startup
(`setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, …_ON)` through
`bun:ffi`, in `cloud-placeholders.ts`); the call is skipped off macOS. A read
of a placeholder then waits on a file-system worker while the provider
downloads it, and the event loop keeps serving. If the policy cannot be set,
startup logs `[arborsync:cloud-placeholders]` and continues. A read that still
returns `EDEADLK` is logged with reason `cloud-placeholder`, the placement
reports `error`, and the next periodic sync retries it. The daemon hashes
every synchronized file, so the 30-minute object audit downloads files the
provider evicted since the last one. To keep a placed folder from churning,
mark it Keep Downloaded in Finder.

Records contain the requested hash, tree or local path where available, and
safe error codes/HTTP status. They omit exception messages, response bodies,
request URLs and credentials. This is local diagnostic evidence, not a change
to the REST or canopyd Overstory response contract. `ProtocolHTTPError.status` lets local
callers classify HTTP failures without parsing the human-readable message.
