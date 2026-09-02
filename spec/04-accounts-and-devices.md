# Accounts and devices
*Part of the [Arbor spec](../spec.md): communities, profiles, the private account-configuration tree, devices, placements, and how a tree is declared and activated.*

*Owns: profile documents, the profile claim, the configuration graph and YAML, device pairing, placements and projections, tree activation, and the `account-config-v1` write rules and merge rule. References: [access control](05-access-control.md) for subjects, rules, and credentials, and the [data model](01-data-model.md) for synchronization.*

## 1. Accounts and profiles

Person and group profiles are complete Arbor trees with ordinary root Markdown:

```yaml
type: person
```

```yaml
type: group
members:
  - arbor://community.example/~alice
  - arbor://community.example/~bob
```

The profile tree's `TreeID`, not its mutable title or root `PageID`, is the stable person or group identity. The root document's `type: person` or `type: group` is the sole declaration of a profile's kind; wire tree descriptors carry no profile kind, and the server enforces `type: person` at an account's profile tree and `type: group` at the community root without validating `type:` elsewhere. Group membership is the authored `members` list. Membership does not itself grant write access to the group tree.

### 1.1 Profile claim

```text
PUT /.arbor/claims/{handle}
```

The body names a generated profile `TreeID`, account-configuration `TreeID`,
generated `DeviceID`, device label, device credential digest, initial profile
snapshot, and complete initial configuration snapshot. The configuration
snapshot contains `account.yaml`, `trees.yaml`, and that device's file and
makes the device the first administrator.

The server validates both graphs and atomically creates the profile,
account, public canonical profile boundary and ACL, private config tree,
credential binding, accepted updates, and first administrator. Exact retry is
idempotent. Any different attempt after success returns `already-claimed`. No
response returns a raw device credential.

## 2. Configuration graph

Each account has one private `account-configuration` Arbor tree with this complete graph layout:

```text
/
  account.yaml
  trees.yaml
  devices/
    <DeviceID>.yaml
```

The server rejects every other graph path, including `.state`. The tree must not declare itself in `trees.yaml` or appear in a device's placements. It is private, noncanonical, and governed control content despite using ordinary immutable Arbor objects and synchronization. Local checkout, private-state, migration, and credential-storage choices are outside this specification.

## 3. Configuration YAML

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
    server: "https://community.example"
    path: "/Users/joe/Documents/Arbor"
    projection:
      driver: sqlite
      mode: read-only
```

`account.yaml` owns the community/profile connection and the nonempty set of
administrator `DeviceID`s. `trees.yaml` is keyed by client-generated `TreeID`
and owns each tree's canonical boundary and ACL. A tree's profile kind is the
root document's `type:` frontmatter; the server requires `type: person` at an
account's profile tree and `type: group` at the community root, and does not
validate `type:` elsewhere. The configuration tree is never an entry in either
file.

Each `devices/<DeviceID>.yaml` filename is both the file's device identity and
membership in the active-device set. Device files cannot be renamed. A
`placements` entry is keyed by `TreeID`. A `path` is a filesystem placement;
an omitted path requests an implementation-managed durable writable replica. No
placement entry creates a tree. `server` is the HTTP(S) Canopy origin that hosts
the tree.
Writers emit only `server`; version-1 readers may accept the legacy key
`authority` during migration but reject an entry containing both. Every active
device may read all device files, so placements are visible account-wide; a
device applies only its own file locally.

An optional `projection` selects a placement-private physical representation
without changing the placed tree. The portable values are `driver: sqlite`
with `mode: read-only` or `mode: bidirectional`. A read-only projection follows
coherent remote query state, may serve the last completely applied output hash
and scoped model hash offline, and rejects local mutations and direct database
writes. A bidirectional projection
may additionally publish provisional named mutations and candidate state under
the [store replication contract](06-stores.md#4-postgres-and-placement-projections).
Projection files, paths, applied output hashes/model hashes, queues, and
readiness are private state;
only the requested driver and mode belong to synchronized placement YAML.

An ordinary device may edit or delete only its own file. An administrator may
edit `account.yaml` and `trees.yaml`, and may delete another device file, but
may not edit another device's placements. Deleting a device file atomically
revokes its credential and permanently retires its `DeviceID`; pairing again
creates a new identity. `admins` must remain a nonempty subset of active device
filenames, so the last administrator cannot be removed or demoted.

Removing a placement stops replication and does not delete local files, remote
identity, ACLs, history, boundaries, or conflicts. Removing an uninitialized
tree declaration cancels its reservation. Removing an active remote tree
declaration is invalid until Arbor specifies a remote deletion lifecycle
([deferred 1](../spec.md#deferred)).

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

A syntactically or semantically invalid candidate cannot become the accepted
configuration. Generated IDs, status, retry state, and normalized YAML are not
inserted into accepted user-authored files.

The account tokens, and what each survives:

| Token | Identifies | Minted by | Survives |
|---|---|---|---|
| `DeviceID` | one credential binding for one account | the device: `dv_` plus 26 base32 characters | everything except deletion of its file, which retires it |
| `PairingID` | one short-lived pairing secret | the server | nothing; it is single use |
| access-link digest | one access link | hashing the secret, which is shown once and never stored | deleting the rule revokes it |

## 4. Device pairing

```text
POST /.arbor/pairings
PUT  /.arbor/pairings/{PairingID}/claim
```

An authenticated device creates a short-lived, single-use pairing secret. The
claimant locally generates a new `DeviceID` and credential, stores the raw
credential immediately, and sends only its digest together with the label,
initial placements, and pairing secret. The server atomically adds the new
device file to the config tree and binds the digest. The new device is ordinary,
not an administrator. Exact claim retry is idempotent; concurrent or expired
reuse fails. No response returns the raw new credential.

A `DeviceID` identifies one credential binding for one account. Deleting its
file from the accepted account configuration atomically revokes the credential
and permanently retires the ID. Credential validity is derived from the current
accepted config root plus server-held digest binding; caller claims do not
authorize a transition.

## 5. Declaring and activating a tree

Adding an unknown client-generated `TreeID` to `trees.yaml` first accepts and
reserves its identity, canonical path, and ACL. Private derived
status becomes `awaiting-initialization`. At least one active administrator's
placements must name it. Pending trees are unreadable, unresolved, and
unattached.

An eligible administrator snapshots its filesystem placement or pathless
replica and submits it as the tree's first update:

```text
POST /.arbor/trees/{TreeID}/updates
{ "base": null, "candidate": <root>, "ifMatch": "bytesHash", "objects": [...] }
```

Activation is an ordinary update whose base is `null` and whose `ifMatch` is
`bytesHash`: it has the same request identity, replay, and `UpdateResult` as
every later update. The server requires
the submitting administrator device to have placed the reserved tree, validates
the graph and the applicable profile invariant, creates the first accepted
update, applies the declared ACL and parent boundary, marks the tree active,
and emits `tree.activation` on the account's configuration tree atomically.
First valid activation wins: an identical replay returns `current`, and a
different snapshot for an already active TreeID is `conflict`. Removing the
pending declaration cancels the reservation. Pending, activating, active, and
error status remains derived private state and events, never YAML.

## 6. Governed account tree

For storage, immutable objects, snapshots, accepted updates, merging, replicas,
and observation, the account-configuration tree is an ordinary private,
noncanonical Arbor tree whose updates carry `ifMatch: "modelHash"` with
`onConflict: "merge"`; its merge rule is the semantic merge below. It
additionally has the closed, code-defined server-side policy
`account-config-v1`, and all other trees use `ordinary`; this is not a generic
policy or plugin mechanism.

For every candidate and merged root, the server parses and validates the
complete graph and semantic diff, authenticates the submitting credential
against the current accepted root, enforces the path and per-device/admin rules,
and atomically applies credential revocation, administrator changes, existing
tree ACL changes, and canonical-boundary changes with acceptance of the root.
Caller assertions never replace authorization from the current accepted root.
Derived credential bindings, retired IDs, status, and indexes live in the
server database while the accepted graph remains canonical.

Different device files merge independently. Placements merge by `TreeID`,
administrators by `DeviceID`, trees by `TreeID`, and ACLs by semantic subject.
Disjoint changes auto-merge. Delete versus unchanged resolves to delete, and an
administrator's device revocation wins a concurrent edit by that revoked
device. Incompatible edits to the same semantic field create a private typed
conflict that requires an explicit exact-identity resolution. YAML receives no
conflict markers or `conflictResolution` field.
