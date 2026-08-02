# Local system and placements
*Part of the [Arbor spec](../spec.md): the Arbor data home, `trees.yaml`, safe system records, and local durability.*

## Arbor data home

The Arbor data home is `${ARBOR_DATA_HOME:-~/.arbor}`. Setting `ARBOR_DATA_HOME` selects a completely isolated Arbor data home, including its placement registry and credential namespace. An implementation must not read placements or credentials from another Arbor data home while the override is active.

Only this selection rule and `trees.yaml` are standardized local control surfaces. Private indexes, journals, caches, recovery databases, account records, and device identity layout are implementation-specific. They remain subject to the secrecy and durability requirements below.

## Placement registry: `trees.yaml`

`${ARBOR_DATA_HOME:-~/.arbor}/trees.yaml` is a human-editable YAML mapping keyed by canonical absolute local paths. An empty registry is `{}`. A shared placement has this shape:

```yaml
"/canonical/local/path":
  source: "arbor://tree/<TreeID>/"
  tree: "<TreeID>"
  canonical: "arbor://community.example/~profile/path"
  endpoint: "https://community.example"
  ref: "sha256:..."
  access: read
  publicAccess: none
```

`source`, `tree`, `canonical`, `endpoint`, `ref`, and `access` are required. `publicAccess` is the only optional field.

- `source` is the raw `arbor://tree/<TreeID>/` locator and its TreeID equals `tree`.
- `tree` is the stable shared-tree identity.
- `canonical` is the current replaceable public Arbor name.
- `endpoint` is an absolute HTTP or HTTPS authority.
- `ref` is the last common wire root used for synchronization and conflict detection.
- `access` is the effective `read` or `write` authority of this placement.
- `publicAccess`, when present, is `none`, `read`, or `write`.

`source: local` is recognized only as legacy migration input. New unpromoted local browsing never creates a durable registry entry.

A conforming parser rejects duplicate YAML keys, noncanonical or non-absolute key paths, missing or unknown fields, inconsistent `source`/`tree` identities, malformed locators or endpoints, invalid access values, duplicate TreeID placements, and any ambiguous identity. It never infers or repairs uncertain identity.

Arbor-authored edits preserve unrelated comments and mapping order and replace the file atomically. A malformed live edit produces a `system:diagnostics` record while the last fully valid active registry remains in force. Malformed content must never be interpreted as an empty registry.

Removing an entry removes only that path-to-tree relationship. It does not delete local files, remote identity, refs or history, ACLs, canonical boundaries, credentials, or another device's placement.

Credentials, access-link secrets, private indexes, journals, recovery databases, and device identity records must never enter `trees.yaml`.

Language-neutral valid, invalid, edit-preservation, last-valid, nesting, and removal vectors are in [fixtures/trees-yaml.json](fixtures/trees-yaml.json).

## Nested placements

Distinct shared trees may occupy nested local paths. Longest local prefix enters the child tree. The parent must exclude the mounted root from discovery, recursive watching, indexing, generated declarations, snapshots, pushes, pulls, and deletion. The mount is not a parent graph entry and cannot change the parent's ref, ACL, or canonical namespace.

Operations within the mounted root resolve to the child. Operations that would create, replace, move, trash, or restore the mount root itself fail with `reserved-boundary`. Removing the placement leaves its files and remote state intact.

Canonical nested boundaries are different: they are explicit `tree` entries in the parent wire graph. A local placement may project such a child from another OS location, but the parent graph records the child `TreeID`, never a copy of its bytes.

## `system:` tree

The safe virtual system tree has these top-level records:

- `system:device` — safe device identity and data-home status;
- `system:community` — active community and account/profile summary;
- `system:trees` — placements plus tree-level canonical, profile, access, ref, and synchronization information;
- `system:credentials` — opaque credential references and availability, never secrets;
- `system:connections` — safe database-connection labels and metadata, never DSNs or passwords;
- `system:visited` — durable remote-visit metadata and safe cache status;
- `system:diagnostics` — malformed control files, unavailable credentials, conflicts, and other actionable diagnostics.

There are no separate normative `system:profiles` or `system:access` subtrees. Profile and access information belongs to the relevant tree record. Implementations may expose additional safe diagnostic fields, but clients must ignore unknown descriptive fields.

System records are virtual even when backed by private files. Reading them never reveals credential material, link secrets, private index contents, journal payloads, or host paths unrelated to the addressed placement. System mutations use the explicit singleton operations in [REST v1](arbord-rest.md), not edits to guessed private files.

## Visits, credentials, and local durability

Opening a remote locator does not create a placement or placeholder directory. Arbord may retain safe visit metadata and a credential-free cache sufficient for explicit stale/offline reopening. Access-link secrets are supplied out of band and are never stored in visit locators, history, diagnostics, logs, or cached content metadata.

Credentials live in an operating-system credential facility or comparably isolated secret store selected by the active Arbor data home. Safe records may retain an origin, account/profile identity, opaque credential reference, and digest for integrity checking.

An authored local mutation is acknowledged only after its intent and eventual receipt are crash-recoverable. External filesystem changes are observed without being misreported as authored API intent. Deletes in a durable shared-tree domain are recoverable through Trash/history; recovery preserves logical identity where the underlying format provides it. Exact journal files, replay sizes, and recovery database schemas are reference choices.

Scripts and agents receive a resolved namespace assembled from visible local paths, placements, access, and any explicit process ceiling. A runtime cannot address content outside that namespace merely because the host process can.
