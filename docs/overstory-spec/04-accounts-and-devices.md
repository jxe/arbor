# Accounts and devices
*Part of the [Overstory spec](README.md): profile identity, host accounts, each hosted tree's private tree configuration, devices, and how a hosted tree is declared, activated and mounted.*

*Owns: profile documents, self-certifying person identity, host account claims, the tree configuration graph and YAML, device pairing, tree declaration, activation and mounting, and the `tree-config-v1` write and merge rules. References: [locators](03-locators.md) for the host-defined canonical URLs, [access control](05-access-control.md) for subjects, rules, and credentials, and the [data model](01-tree-operations.md) for synchronization. Filesystem placements and private identity keys are deliberately local rather than part of this portable graph.*

## 1. Profiles and host accounts

Person and group profiles are complete Overstory trees with ordinary root Markdown:

```yaml
type: person
displayName: Alice Arbor
avatar: images/alice.webp
description: Builds shared gardens.
```

```yaml
type: group
members:
  - profile: arbor://tr_alice_profile/
  - profile: arbor://tr_bob_profile/
  - profile: arbor://tr_carol_profile/
```

The profile tree's `TreeID`, not its mutable title, root `PageID`, handle, or
current canonical URL, is the stable person or group identity. A new person
profile has a self-certifying TreeID derived from its public identity key;
groups retain ordinary random TreeIDs because a group is not controlled by one
person's permanent secret. The root document's `type: person` or `type: group`
is the sole declaration of profile kind; Overstory tree descriptors carry no profile
kind. Group membership is authored profile content and does not itself grant
write access to the group tree.

Person and group profiles may carry the presentation-only fields `displayName`,
`avatar`, and `description`. A display name is trimmed, contains 1–80 Unicode
scalars, and has no line break. A description contains at most 500 Unicode
scalars. An avatar is a relative path inside the same profile tree, has no
empty, `.` or `..` component, and ends in `png`, `jpg`, `jpeg`, `gif`, or
`webp`. Malformed or missing presentation fields are ignored rather than
invalidating the profile. They never participate in identity or authorization.
When a group omits `displayName`, directory presentation uses the plain text of
its first authored H1 as the group name. This fallback remains presentation
only and does not add or imply a `displayName` field.

A **host account** is host state: the host's record that one profile
`TreeID` is claimed there, with the credential bindings of that profile's
devices. It has no authored tree of its own; the person's devices and app
approvals live in the profile tree's own [tree configuration](#2-tree-configuration-graph).
Its identity is the pair of host and profile TreeID. How a host allocates
account locators is host policy, not Overstory identity. canopyd uses
`/~handle`, but neither `handle` nor that path shape is required by the
portable graph.

An authenticated account descriptor may include a host-specific `handle` as
an optional presentation hint. Consumers must remain correct when it is absent;
the profile TreeID is the account identity and the complete host account URL
is the claim target.

**One host per profile.** Device credentials are bearer secrets whose digests
one host binds, so a profile's configuration lives on the one host that binds
them, its **home host**, and a profile is claimed at one host. A host refuses
a claim for a profile it already has an account for, and clients connect a
profile to one host. Accounts for one profile at several hosts return with
device keys that other hosts can verify
([Security 007](../../plans/security/007-placement-hosts.md)).

Every account may host trees. Overstory does not define a second account
species for membership without hosting, a separate principal, or account
roles. A tree's `admin` rule and a device's `administrator` flag are the two
authority bits in the configuration graph: the first says which profiles
govern a tree, the second which of a person's devices may act for the person
in governing.

Every claimed structured `members` entry requires the stable `profile` locator, and
membership, including membership used by access rules, is decided by that
Profile TreeID alone. A host may define further per-member fields for its own
account allocation, such as [canopyd's](../architecture/canopyd/README.md#accounts-and-canonical-paths) `handle`, which
reserves an account for exactly that profile; they never establish identity or
membership. The person can create the profile tree locally first and share its
raw TreeID locator with the host's administrator. A scalar member locator is
legacy input compatibility, not the normative authored form.

canopyd also accepts a pending community invitation with `handle` and
`inviteDigest: sha256:<hex>` in place of `profile`. It reserves the account
address but is not yet a member for access purposes. The administrator gives
the prospective member a 22-character base64url code generated from 16 random
bytes; the SHA-256 digest of its UTF-8 text is authored there. The invitation
remains valid until claimed or removed from the community profile.
On a successful signed claim, canopyd replaces that entry with the claimant's
`profile` locator and retains its handle. This pending form is host allocation
policy, not a group membership identity; other group profiles continue to name
members by Profile TreeID.

### 1.1 Beginning a person identity

One explicit local operation creates a person identity before any host
account exists. It:

1. generates an Ed25519 keypair using the operating system's cryptographic
   random source;
2. computes `SHA-256("arbor-person-profile-v1\0" || publicKey)`, encodes all 32
   digest bytes as unpadded lowercase base32, and prefixes the result with
   `tr_` to obtain the profile TreeID;
3. creates or adopts one local profile folder whose root `_index.md` declares
   `type: person`, binding that local tree to the derived TreeID; and
4. stores the private key in operating-system credential storage, indexed by
   the profile TreeID. The private key is never Overstory content and never enters
   account configuration, logs, URLs, command arguments, or host storage.

The public key is raw 32-byte Ed25519 public-key material encoded as unpadded
base64url when carried by Overstory. The TreeID is public. Anyone can verify its
derivation, but only a holder of the corresponding private key can create a
valid profile proof.

The operation refuses to replace a different local identity or silently adopt
an ordinary random TreeID as a person identity. Repeating it for the same
profile and available key is idempotent. This version has one permanent key and
defines no rotation, successor key, recovery key, delegation, or host-backed
identity recovery.

A backup contains the same private key, not another authority. A conforming
backup operation writes a versioned, profile-bound secret file with owner-only
permissions, refuses to overwrite an existing path, and never prints the key.
Restore validates that the private key derives the recorded public key and
Profile TreeID before storing it or binding a local profile folder. Losing every
copy of the private key permanently loses the ability to establish that profile
at another host, though already-paired host devices retain their independent
account credentials.

### 1.2 Claiming an account with the profile key

```text
POST /.arbor/account-challenges
PUT /.arbor/accounts
```

The community administrator first records an exact structured member containing
the person's public profile TreeID and the host's local allocation for it
(canopyd's `handle`), or a pending invitation with a code digest and handle.
The person may send that public TreeID by any ordinary channel. An invited
person instead receives the code and creates their profile identity locally. A
host founder supplies the same public TreeID as bootstrap configuration, so
founding removes only that out-of-band handoff and does not waive proof.

The challenge request contains `profileTree`, `configurationTree` (the
profile's derived configuration TreeID, §2.1), and an optional `account` URL
or invitation code. A host refuses a `configurationTree` other than the
derived one. If `account` is omitted, the host
resolves the unique community reservation for that profile identity or code.
No match is an unassigned
membership; several matches require an explicit account URL. An already-claimed
reservation retains the existing already-claimed response. Resolution does not
require the community profile to be publicly readable and grants no authority.
The returned challenge always contains the exact account URL, including when
the request supplied only the community origin. Clients verify the returned
origin and any explicitly requested account before signing.

Before account creation, the host returns a random, single-use, short-lived
challenge bound to its normalized origin, the complete allocated account URL,
the challenged profile TreeID, and the profile's configuration TreeID. The client
signs the canonical CBOR encoding of the complete challenge with the profile
private key. The account-claim body carries the challenge, raw public key, and
Ed25519 signature alongside the proposed device and configuration data. The
host verifies the challenge and expiry, hashes the supplied public key to the
challenged profile TreeID, and verifies the signature locally. It contacts no
other host.

The account-claim body names the host-allocated account locator, that existing
local profile `TreeID`, its derived configuration `TreeID`, a generated
`DeviceID`, device label and credential digest, and the complete initial
snapshot of the profile's tree configuration. It contains no profile snapshot
or filesystem path. The initial configuration must grant the profile `admin`,
list the claiming device as its one administrator device, and mount nothing.
The claim **declares the profile tree**: the server validates the reservation
and configuration, then atomically creates the host account, the profile's
tree configuration, credential binding, accepted update and first
administrator device, and reserves the profile tree as
`awaiting-initialization` (§6). It does not create, copy, or locate the
profile tree's content; the person activates it with its first snapshot. Exact retry is
idempotent; a different attempt after success returns `already-claimed`. For
a pending invitation, the body also supplies its code. The host verifies the
digest and advances the community profile to an accepted root with that entry
replaced by the proven Profile TreeID in the same commit. No
response returns a raw device credential. An exact profile reservation selects
who may claim; an invitation code permits its holder to bind the pending slot
to their identity. The
profile-key signature proves control of that identity. Exact replay of one
successful claim is idempotent; an altered, expired, already-consumed, or
wrong-target challenge fails closed.

The old `PUT /.arbor/claims/{handle}` operation, which creates and hosts a
profile from an uploaded snapshot, and the source-host profile-proof routes
are removed rather than retained as new-account compatibility. A host using
this generation accepts new person accounts only for self-certifying Profile
TreeIDs with valid local signatures.

## 2. Tree configuration graph

Every hosted tree has one private **tree configuration**: a second Overstory
tree, edited only by the tree's administrators, holding who may do what to the
tree, administering it included, and which child trees it mounts at which
names. A profile tree's configuration also holds what belongs to the profile:
which apps may use its access and, for a person, their devices. There is no
separate account configuration.

```text
/
  access.yaml     every tree: who may do what, administrators included
  mounts.yaml     every tree: child trees by logical path
  apps.yaml       profile trees only: apps that may use the profile's access
  devices.yaml    person profiles only: the person's devices
```

Which files are present depends on the tree's kind, and each is then required.
A person profile is known from its self-certifying TreeID (§1.1), which the
host verifies at claim; a group profile from its accepted root's
`type: group`. The server rejects every other path, nested directories, and a
file present or missing contrary to the tree's kind. If a tree stops being a
group profile, its `apps.yaml` stops applying and the next edit must remove
it. The graph shape identifies this configuration generation; its files do not
repeat a format version.

A tree configuration is private, noncanonical, and governed control content
despite using ordinary immutable Overstory objects and synchronization. It has
no tree configuration of its own, cannot be mounted, and is absent from
canonical resolution and public discovery. Local checkout, private-state and
credential-storage choices are outside the graph; no operating-system path or
placement projection is synchronized through a tree configuration.

### 2.1 Finding it

The configuration's TreeID is derived from the tree's, so there is no pointer
to keep consistent and a configuration cannot be attached to the wrong tree:
compute `SHA-256("arbor-tree-config-v1\0" || TreeID)` over the UTF-8 TreeID,
encode all 32 digest bytes as unpadded lowercase base32, and prefix `tr_`.
This is the same form as a person profile TreeID (§1.1), so the prefix does not
reveal that a TreeID names a configuration; only a host that knows the tree
can tell. A derived TreeID has no configuration of its own.

Every locator of a tree addresses its configuration with the segment
parameter `arbor-config` ([locators §3](03-locators.md#3-parsing-and-canonicalization)):

```text
https://canopy.example/~joe/todos;arbor-config
arbor://tr_todos;arbor-config
/.arbor/trees/tr_todos;arbor-config
```

It follows renames and works for a tree with no canonical path. The host
answers it only to the tree's administrators, and to anyone else exactly as
it answers a tree they may not read (`404`), so it reveals nothing more.
Descriptors of a configuration carry `kind: "tree-configuration"` and no
`canonical`.

## 3. Configuration YAML

The files are strict, ordinary, human-editable UTF-8 YAML. The shapes below
are complete top-level shapes: there is no `version` or other wrapper key.

```yaml
# access.yaml
- who: {profile: tr_joe}
  allow: [admin]
- who: {profile: tr_alice}
  allow: [read, create-child]
- who: everyone
  app: tr_supplies
  allow: [read]
  within: /published
```

```yaml
# mounts.yaml
todos: tr_todos
projects/garden: tr_garden
```

```yaml
# apps.yaml (a person's)
tr_supplies:
  - resource: tr_alice_pantry
    allow: [read, create-child]
    within: /inventory
tr_joe_homepage:
  - resource: tr_library_catalog
    who: everyone
    allow: [read]
```

```yaml
# devices.yaml
dv_mac:
  label: "Joe's Mac"
  administrator: true
dv_phone:
  label: "Joe's iPhone"
```

**`access.yaml`** is the tree's list of [resource rules](05-access-control.md#1-subjects-and-rules)
(`who` / `app` / `allow` / `within`). It always contains at least one rule
granting `admin`. `admin` may be granted only to a person or group profile, in
a rule with no `app` and no `within`; the profiles it names, and a group's
current members, are the tree's **administrators**. An administrator may read
and edit the tree configuration and has every other operation on the whole
tree. `me` and `members` are invalid here.

**`mounts.yaml`** maps logical paths relative to this tree's root to child
TreeIDs. A path is nonempty, relative, has no empty, `.` or `..` component,
and does not lie inside another mount's path; a tree is mounted at most once
anywhere, never by itself, and never as a configuration. The host maintains
each active mount as the canonical boundary entry in this tree's content, so
the child's canonical URL follows from the parent's
([locators §5](03-locators.md#5-finding-trees)). A pending child is
mounted too; its boundary appears when it activates.

**`apps.yaml`** holds, keyed by app TreeID, the rules a profile lets that app
use: `resource` / `who` / `allow` / `within`, with the app implied by the key.
`admin` is invalid here. `who` defaults to the profile itself, spelled `me` in
a person's file and `members` in a group's; each spelling is invalid in the
other file. Any other `who` lends the access
([access control §1.1](05-access-control.md#11-execution-authority)).

**`devices.yaml`** is keyed directly by `DeviceID`. An entry means that device
has an active credential binding for this person at the home host.
`administrator` is optional and defaults to `false`. At least one device is an
administrator. Pairing adds a new ordinary-device entry. Deleting an entry
atomically revokes its credential and permanently retires its `DeviceID`;
pairing it again creates a new identity.

### 3.1 Who may edit a tree configuration

An update to a tree configuration is authorized when the submitting device is
an `administrator` device in the `devices.yaml` of a person profile that
administers the tree, directly or as a current member of an administering
group. Authorization reads the current accepted configurations, never the
proposed one, so an edit cannot add its own submitter.

A person profile's configuration governs itself: its own `devices.yaml` names
the devices that may edit it. An ordinary device may change only its own safe
fields, currently `label`; an administrator device may do the rest, including
pairing and revoking. A device cannot create its own entry, change its own
administrator bit, or revive a retired `DeviceID` through a configuration
edit.

**Mounting** a tree additionally requires the submitting device's person to
administer the child. Renaming or removing a mount needs only this tree's
administrators: the parent controls its namespace. A host may reserve names
in its root tree's `mounts.yaml`; canopyd mounts each claimed member's profile
at `~handle` itself and refuses a root mount at a reserved or claimed
`~handle` ([canopyd](../architecture/canopyd/README.md#accounts-and-canonical-paths)).

### 3.2 Invariants

- `access.yaml` always grants `admin` to at least one profile.
- A person profile's configuration grants `admin` to that person's profile
  and no one else, so only the person can pair devices or lend their access.
  A group profile's may name other administrators, who then act for the
  group, lending included.
- A person profile's `devices.yaml` always has at least one administrator
  device.
- A group profile that administers any tree keeps at least one member: an
  update to that group's `members` that removes the last one is refused.

A candidate or merge that would break one is invalid. Removing an active
tree's last mount leaves it hosted without a canonical path; removing an
active tree is invalid until Overstory specifies a remote deletion lifecycle
([deferred 1](README.md#deferred)).

YAML never contains refs, update IDs, retry state, conflict choices, status,
device credential digests, raw credentials, identity private keys,
signatures, raw access-link secrets, filesystem paths, placement options, or
proof issuers. Link-subject digests are allowed because they are ACL
identity, not the secret. A conforming parser rejects duplicate keys, aliases,
unknown fields, malformed IDs, invalid rules and every ambiguous identity.
Newly activated trees and paired devices use a prefix plus 26 lowercase
base32 characters encoding 128 random bits; existing shorter legacy IDs
remain valid. Generated IDs, status, retry state, and normalized YAML are not
inserted into accepted user-authored files.

The account tokens, and what each survives:

| Token | Identifies | Minted by | Survives |
|---|---|---|---|
| person-profile `TreeID` | one person and one public identity key; with the host, one host account | `arbor me create` | all account, canonical-name, and hosting changes |
| configuration `TreeID` | one tree's configuration | derived from the tree's `TreeID` | everything the tree survives |
| group-profile `TreeID` | one authored group | the first local workspace | canonical-name and hosting changes |
| `DeviceID` | one credential binding for one person at the home host | the device | everything except deletion of its `devices.yaml` entry |
| `PairingID` | one short-lived pairing secret for one account | the server | nothing; it is single use |
| account challenge | one short-lived, target-bound profile signature | the target host | nothing; it is single use and expires |
| access-link digest | one access link | hashing the secret, which is shown once and never stored | deleting the rule revokes it |

## 4. Local placements

Placement is intentionally separate from account membership, device
registration, and portable Overstory content. Each implementation may choose its
own local representation, but it must keep operating-system paths and
placement-private options outside synchronized configuration and Overstory content.
Removing a placement stops that local materialization without deleting local
files, remote identity, ACLs, history, canonical boundaries, or conflicts.

See [reference local placements](../implementing-sync-services/local-placements.md)
for the local file layout and the distinction between a placed folder and a
working tree borrowing that folder's object store.

## 5. Device pairing

```text
POST /.arbor/pairings
PUT  /.arbor/pairings/{PairingID}/claim
```

An authenticated device creates a short-lived, single-use pairing secret for
its account. The claimant locally generates a new
`DeviceID` and credential, durably stores the raw credential before claiming,
and sends only its digest together with its label and pairing secret. The
server atomically advances the person profile's tree configuration with an
ordinary-device entry in `devices.yaml` and binds the digest. Pairing carries
no placement or local path. Exact claim retry uses the same pairing secret,
DeviceID, label, and credential digest and is idempotent; concurrent,
altered, or expired reuse fails. No response returns the raw new credential.

Because a profile has one home host (§1), one physical installation has one
`DeviceID` per profile it acts for, and there is no multi-account pairing
transaction or global device identity. Several local clients on one
installation MAY share that installation's device credential: to the host
they are one device, and their request digests share one scope, which is what
makes adoption
([working-tree updates §2.2](09-client-synchronization.md#32-entry)) sound.

## 6. Declaring, activating and mounting a tree

Each step is an ordinary update of one tree.

1. **Declare.** A client generates the TreeID and submits the tree
   configuration's first snapshot, addressed through that TreeID:

   ```text
   POST /.arbor/trees/{TreeID};arbor-config/updates
   { "base": null, "updates": [{ "change": <change-id>, "candidate": <root>, "operations": null, "resolves": [], "objects": [...], "deltas": [] }] }
   ```

   The configuration must grant the submitting device's person `admin`, and a
   profile tree is declared only by claiming it (§1.2). The host reserves the
   TreeID; the tree is `awaiting-initialization`, unreadable and unresolved.
   An exact replay returns the original result; a different first snapshot
   for a declared TreeID is `conflict`.
2. **Activate.** An administrator submits the tree's complete initial
   snapshot:

   ```text
   POST /.arbor/trees/{TreeID}/updates
   { "base": null, "updates": [ ... ] }
   ```

   Activation is an ordinary update whose base is `null`, without `ifCurrent`
   or resolution declarations: it has the same request identity, replay, and
   `UpdateResult` as every later update. The server validates the graph and
   any applicable profile invariant, creates the first accepted update,
   applies the configuration's rules and any mount naming the tree as a
   canonical boundary, marks the tree active, and makes its descriptor and
   accepted snapshot readable in the same commit. First valid activation
   wins: an exact successful replay returns its original result, and a
   different snapshot for an already active TreeID is `conflict`.
3. **Mount.** An administrator of both the parent and the child adds the
   mount to the parent's `mounts.yaml` (§3.1). A pending tree may be
   mounted; its boundary appears when it activates.

Activation emits no event on any configuration. A client that learns of a
declaration before activation may retry the declared tree's descriptor until
the initial update makes it readable, then fetch the accepted snapshot named
by that descriptor. Pending, activating, active, and error status remains
derived private state, never YAML or a portable tree-watch event. Retiring a
tree retires its configuration.

## 7. Governed configuration trees

For storage, immutable objects, snapshots, accepted updates, merging, working
trees, and observation, a tree configuration is an ordinary private,
noncanonical Overstory tree whose updates use ordinary reconciliation. It
additionally has the closed, code-defined server-side policy
`tree-config-v1`; all other trees use `ordinary`. This is not a generic policy
or plugin mechanism. The `v1` suffix versions the protocol-visible merge
algorithm; it is not a `version` field in any authored YAML file.
`tree-config-v1` replaces the earlier per-account `account-config-v2`.

For every candidate and merged root, the server parses and validates the
complete graph and semantic diff, authorizes the submitting device against the
current accepted configurations (§3.1), enforces the invariants (§3.2), and
atomically applies credential revocation, administrator changes, rule changes
and canonical-boundary changes with acceptance of the root. Caller assertions
never replace authorization from the current accepted roots. Derived
credential bindings, retired IDs, status, and indexes live in the server
database while the accepted graphs remain canonical.

Entries merge by key: `devices.yaml` by `DeviceID`, `mounts.yaml` by path,
`access.yaml` rules by canonical `(who, app, within)`, and `apps.yaml` rules by
app and canonical `(resource, who, within)`. No authored grant ID is added.
Disjoint changes auto-merge. Delete versus unchanged resolves to delete, and
an administrator's device revocation wins a concurrent edit by that revoked
device. Concurrent removal or narrowing must not resurrect authority through
a union: ambiguous edits to the same rule enforce the restrictive
intersection (a private `tree-configuration-policy` conflict) until an
administrator resolves them. Other incompatible edits to the same semantic
field, and a merge that would break an invariant, create a private
`tree-configuration` conflict that requires an explicit exact-identity
resolution. YAML receives no conflict markers or `conflictResolution` field.
