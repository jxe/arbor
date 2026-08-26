# Arbor local system reference

This document records replaceable local filesystem, daemon-state, and credential-storage choices in the current Arbor implementation. The synchronized cross-server configuration contract is normative in [configuration](../spec/configuration.md); the loopback API is documented separately in [Local Arbor REST API](arborsync-api.md).

## Data home

The reference implementation uses `${ARBOR_DATA_HOME:-~/.arbor}` as one isolated configuration checkout, private-state root, and credential namespace:

```text
${ARBOR_DATA_HOME:-~/.arbor}/
  account.yaml
  trees.yaml
  devices/
    <DeviceID>.yaml
  .state/
    ...private arborsync state...
```

The directory above `.state` is the checkout of the account-configuration tree. `.state` is excluded from discovery, recursive watching, indexing, snapshots, synchronization, and deletion. The current implementation stores refs, pending updates, conflicts, pathless replicas, indexes, journals, caches, visits, recovery data, credential references, diagnostics, and migration backups beneath it. Those private names and layouts may change.

Raw credentials use the platform credential facility where available and are scoped to the selected data home. Other implementations may use an equivalent secret facility, but no raw credential or access-link secret belongs in synchronized configuration or authored trees.

## Watching and local activation

Arbor Sync watches `account.yaml`, `trees.yaml`, and `devices/*.yaml`. A valid direct edit is synchronized as an ordinary account-tree change. An invalid candidate leaves the last fully valid configuration active and creates a safe diagnostic. Arbor-authored edits preserve unrelated comments and mapping order and replace files atomically.

A declared placement may sit beneath the data home as a separate mounted tree. Local discovery, watching, indexing, snapshots, pushes, pulls, and deletion stop at every mounted tree root. Removing a placement stops replication without deleting its files or remote identity.

## Local scopes, visits, and durability

The reference daemon exposes `local` for untracked filesystem content and `system:` for constrained diagnostics, visit/cache metadata, credential availability, synchronization and activation status, recovery, and conflict summaries. These are arborsync facilities, not Arbor trees or portable wire locators.

Opening an unplaced remote locator may create a transient read-only visit and credential-free cache. A pathless placement creates a durable writable private replica. Local authored mutations are acknowledged only after their intent and eventual receipt are crash-recoverable; external filesystem changes are observed without being reported as authored API intent. The current recovery UI uses Trash and history.

## Migration

The alpha implementation moved legacy caches, rehearsal state, Finder metadata, registries, journals, and recovery data beneath `.state` without moving declared authored-tree placements. Future migrations are implementation operations and do not alter the synchronized configuration format.
