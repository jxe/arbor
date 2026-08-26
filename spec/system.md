# Local system and account configuration
*Part of the [Arbor spec](../spec.md): the Arbor data home, its synchronized account-configuration tree, placements, and private local state.*

## Normative data-home layout

The Arbor data home is `${ARBOR_DATA_HOME:-~/.arbor}` and has this complete normative layout:

```text
${ARBOR_DATA_HOME:-~/.arbor}/
  account.yaml
  trees.yaml
  devices/
    <DeviceID>.yaml
  .state/
    ...private arbord state...
```

The directory above `.state` is the physical checkout of one private
`account-configuration` Arbor tree. Setting `ARBOR_DATA_HOME` selects an
entirely isolated checkout and credential namespace; an implementation must not
read configuration, state, or credentials from another data home while the
override is active. One data home contains one active account-configuration
checkout.

`.state` is a reserved local nested mount. It is excluded from discovery,
indexing, recursive watching, snapshots, synchronization, deletion, and the
configuration tree's graph. The authority rejects an account-configuration
graph containing `.state`. Private refs, updates, pending submissions,
conflicts, pathless replicas, indexes, journals, caches, visits, recovery data,
credential references, diagnostics, migration backups, and all other
implementation state live beneath `.state`. Raw credentials live only in the
operating-system credential store selected by the active data home.

The configuration tree itself is implicit. It must not declare itself in
`trees.yaml` or appear in any device's placements. It is private,
noncanonical, and special control content rather than portable authored
content, despite using ordinary immutable Arbor objects and synchronization.

A declared filesystem placement may be physically nested beneath the data
home, as with a legacy `community/` or `profile/` placement. It is a separate
Arbor tree mount, excluded from the account-configuration graph exactly like
any other mounted tree; it does not add a permitted path to that graph. Apart
from declared nested tree placements, the checkout has no paths beyond the
normative layout above. Alpha migration moves known legacy caches, rehearsal
state, Finder metadata, registries, journals, and recovery data beneath
`.state` without moving or rewriting declared authored-tree placements.

## Configuration YAML

The three configuration forms are ordinary human-editable UTF-8 YAML:

```yaml
# account.yaml
version: 1
community: "https://community.example"
profile:
  tree: "tr_<26-lowercase-base32-characters>"
  handle: "joe"
admins:
  - "dv_<26-lowercase-base32-characters>"
```

```yaml
# trees.yaml
version: 1
trees:
  "tr_<26-lowercase-base32-characters>":
    kind: person-profile
    canonicalPath: "/~joe"
    access:
      - subject:
          kind: everyone
        access: read
```

```yaml
# devices/dv_<26-lowercase-base32-characters>.yaml
version: 1
label: "Joe's Mac"
placements:
  "tr_<26-lowercase-base32-characters>":
    authority: "https://community.example"
    path: "/Users/joe/Documents/Arbor"
```

`account.yaml` owns the community/profile connection and the nonempty set of
administrator `DeviceID`s. `trees.yaml` is keyed by client-generated `TreeID`
and owns each tree's canonical boundary, kind, and ACL. `kind` cannot change
after activation. The configuration tree is never an entry in either file.

Access subjects are `everyone`, a stable profile `TreeID`, or a
`sha256:<hex>` access-link digest. Stored rules contain only `read` or `write`;
`none` means removal and is never stored. Public access is represented by the
`everyone` rule; there is no `publicAccess` field. A raw link secret never
enters YAML.

Each `devices/<DeviceID>.yaml` filename is both the file's device identity and
membership in the active-device set. Device files cannot be renamed. A
`placements` entry is keyed by `TreeID`. A `path` is a filesystem placement;
an omitted path is a durable private writable replica beneath `.state`. No
entry means only a transient lazy read-only visit or cache. Every active device
may read all device files, so placements are visible account-wide; arbord
applies only its own file locally.

An ordinary device may edit or delete only its own file. An administrator may
edit `account.yaml` and `trees.yaml`, and may delete another device file, but
may not edit another device's placements. Deleting a device file atomically
revokes its credential and permanently retires its `DeviceID`; pairing again
creates a new identity. `admins` must remain a nonempty subset of active device
filenames, so the last administrator cannot be removed or demoted.

Removing a placement stops replication and does not delete local files, remote
identity, ACLs, history, boundaries, or conflicts. Removing an uninitialized
tree declaration cancels its reservation. Removing an active remote tree
declaration is invalid until Arbor specifies a separate remote deletion
lifecycle.

YAML never contains refs, update IDs, retry state, conflict choices, status,
device credential digests, raw credentials, or raw access-link secrets. Link
subject digests are allowed because they are the ACL identity, not the secret.

A conforming parser rejects duplicate keys, aliases, unknown fields, malformed
IDs, origins, paths, or filenames, filename/credential-binding identity
disagreement, forbidden paths, invalid ACL values, inconsistent profile/tree identity,
inactive administrators, and all other ambiguous identities. Existing shorter
legacy IDs may be accepted during migration; newly activated trees and paired
devices use a prefix plus 26 lowercase base32 characters encoding 128 random
bits.

Arbord watches `account.yaml`, `trees.yaml`, and `devices/*.yaml`. A direct
valid edit is submitted through ordinary account-tree synchronization and
becomes active after acceptance. A syntactically or semantically invalid
candidate leaves the last fully valid configuration active and creates a safe
diagnostic. Arbor-authored edits preserve unrelated comments and mapping order
and replace files atomically; arbord does not add generated IDs, status, retry
state, or normalized YAML to user-authored files.

## Governed account tree

For storage, immutable objects, snapshots, accepted updates, merging, replicas,
and observation, the account-configuration tree is an ordinary private Arbor
tree. It additionally has the closed, code-defined authority policy
`account-config-v1`; this is not a generic policy or plugin mechanism.

For every candidate and merged root, the authority parses and validates the
complete graph and semantic diff, authenticates the submitting credential
against the current accepted root, enforces the path and per-device/admin rules,
and atomically applies credential revocation, administrator changes, existing
tree ACL changes, and canonical-boundary changes with acceptance of the root.
Caller assertions never replace authorization from the current accepted root.
Derived credential bindings, retired IDs, status, and indexes live in the
authority database while the accepted graph remains canonical.

Different device files merge independently. Placements merge by `TreeID`,
administrators by `DeviceID`, trees by `TreeID`, and ACLs by semantic subject.
Disjoint changes auto-merge. Delete versus unchanged resolves to delete, and an
administrator's device revocation wins a concurrent edit by that revoked
device. Incompatible edits to the same semantic field create a private typed
conflict that requires an explicit exact-identity resolution. YAML receives no
conflict markers or `conflictResolution` field.

## Nested placements and the system scope

Distinct ordinary Arbor trees may occupy nested paths. Longest local prefix
enters the child tree. The parent excludes the mounted root from discovery,
recursive watching, indexing, snapshots, pushes, pulls, and deletion. A mount
is not a parent graph entry. Canonical nested boundaries are different: they
are explicit `tree` entries in the parent immutable graph.

Operations against a mount root that would replace, move, trash, or restore it
fail with `conflict` and typed workspace-revision details identifying the
reserved boundary. Removing a placement leaves files and remote state intact.

`system:` is an explicit scope, not an Arbor tree and never receives a
`TreeDescriptor`. It is limited to safe diagnostics, visit/cache metadata,
credential availability, synchronization and activation status, recovery, and
conflict summaries. It exposes no placement registry, account mutation
surface, raw credential, access-link secret, private object, journal payload,
or unrelated host path. `local` is likewise an explicit non-tree scope.

## Visits, credentials, and durability

Opening an unplaced remote locator creates neither a virtual tree nor a
placeholder directory. Arbord may retain a transient read-only visit and a
credential-free cache sufficient for stale/offline reopening. A pathless
placement, by contrast, is a durable writable private replica.

Device credentials and access-link secrets are generated locally. The raw
device credential is immediately stored in the OS credential store and only
its digest is sent to the authority. A raw link secret is displayed or copied
once and only its digest is stored. Secrets never enter locators, files,
history, diagnostics, logs, events, errors, or authority responses.

An authored local mutation is acknowledged only after its intent and eventual
receipt are crash-recoverable. External filesystem changes are observed
without being misreported as authored API intent. Deletes in a durable local
domain are recoverable through Trash or history. Scripts and agents receive an
explicit resolved namespace and gain no authority from ambient host access.
