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
updates, conflicts, managed replicas, indexes, journals, caches, visits,
recovery data, account-keyed credential references, diagnostics, and migration
backups beneath it. Those private names and layouts may change.

Raw credentials use the platform credential facility where available and are
scoped by the selected data home and configuration TreeID. Origin alone is not
a credential key because two accounts may use one Canopy. Other
implementations may use an equivalent secret facility, but no raw credential
or access-link secret belongs in synchronized configuration or authored trees.

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

A declared placement may sit beneath the data home as a separate mounted tree. Local discovery, watching, indexing, snapshots, pushes, pulls, and deletion stop at every mounted tree root. Removing a placement stops replication without deleting its files or remote identity.

## Local scopes, visits, and durability

The reference daemon exposes `local` for untracked filesystem content and `system:` for constrained diagnostics, visit/cache metadata, credential availability, synchronization and activation status, recovery, and conflict summaries. These are arborsync facilities, not Arbor trees or portable wire locators.

Opening an unplaced remote locator may create a transient read-only visit and credential-free cache. A pathless placement creates a durable writable private replica. Local authored mutations are acknowledged only after their intent and eventual receipt are crash-recoverable; external filesystem changes are observed without being reported as authored API intent. The current recovery UI uses Trash and history.

## Migration

The alpha implementation moved legacy caches, rehearsal state, Finder
metadata, registries, journals, and recovery data beneath `.state` without
moving declared authored-tree placements. The account-layout cutover ran as an
explicit offline migration: it converted the synchronized v1 graph to v2 and
extracted OS paths into local `placements.yaml`. Its repository artifact and
compatibility readers remain during the rollback window, but normal startup
does not perform that conversion implicitly.
