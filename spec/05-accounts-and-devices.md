# Accounts and devices
*Part of the [Arbor spec](../spec.md): profile identity, Canopy accounts, the private account-configuration tree, devices, and how a hosted tree is declared and activated.*

*Owns: profile documents, Canopy account claims, joining an existing profile to another Canopy, the account-configuration graph and YAML, device pairing, tree activation, and the `account-config-v2` write and merge rules. References: [locators](04-locators.md) for Canopy-defined canonical URLs, [access control](06-access-control.md) for subjects, rules, and credentials, and the [data model](01-tree-operations.md) for synchronization. Filesystem placements are deliberately local rather than part of this portable graph.*

## 1. Profiles and Canopy accounts

Person and group profiles are complete Arbor trees with ordinary root Markdown:

```yaml
type: person
```

```yaml
type: group
members:
  - profile: arbor://tr_alice_profile/
    handle: alice
  - profile: arbor://tr_bob_profile/
    handle: bob
  - profile: arbor://tr_carol_profile/
```

The profile tree's `TreeID`, not its mutable title, root `PageID`, handle, or
current canonical URL, is the stable person or group identity. The root
document's `type: person` or `type: group` is the sole declaration of profile
kind; Wire tree descriptors carry no profile kind. Group membership is authored
profile content and does not itself grant write access to the group tree.

A **Canopy account** is a relationship between one Canopy and one profile
`TreeID`. Its private configuration `TreeID` is the stable identity of that
account connection. A person may have accounts at several Canopies without
acquiring another profile identity. How a Canopy allocates account locators and
which canonical paths an account may declare are Canopy policy, not Arbor
identity. The current Canopy uses `/~handle`, but neither `handle` nor that path
shape is required by the portable account graph.

An authenticated account descriptor may include a Canopy-specific `handle` as
an optional presentation hint. Consumers must remain correct when it is absent;
the configuration TreeID is the account identity and the complete Canopy
account URL is the claim target.

Every account may host trees. Arbor does not define a second account species
for membership without hosting, a distinguished home Canopy, a separate
principal, or account roles. Device administration is the one authority bit in
the configuration graph.

Every structured `members` entry requires the stable `profile` locator. A
`profile` alone is membership without a local Canopy account; adding the
Canopy-policy `handle` also reserves the current Canopy's corresponding account
locator for that exact profile. There is no handle-only member or account
reservation. The person can create the profile tree locally first and share
its raw TreeID locator with the community administrator.

The handle is deliberately bare: the containing community already identifies
the Canopy, so its DNS name and `arbor:` scheme are not repeated. Other Canopy
implementations may define another local allocation field and policy. A scalar
member locator is legacy input compatibility, not the normative authored form.

### 1.1 Creating identity and claiming an account

```text
PUT /.arbor/accounts
```

A profile begins as an ordinary local tree. Opening a previously unidentified
local root mints and durably records its generated `TreeID`; profile creation is
not a Canopy operation. A person profile's local root document declares
`type: person` before an account is claimed.

The account-claim body names the Canopy-allocated account locator, that existing
local profile `TreeID`, a newly generated account-configuration `TreeID`, a
generated `DeviceID`, device label and credential digest, and the complete
initial configuration snapshot. It contains no profile snapshot or filesystem
path. The server validates the reservation and configuration, then atomically
creates the Canopy account, private configuration tree, credential binding,
accepted update, first administrator, and any declared-tree reservations. It
does not create, copy, locate, or host the profile tree. Exact retry is
idempotent; a different attempt after success returns `already-claimed`. No
response returns a raw device credential. The exact profile TreeID in the
administrator-authored member reservation authorizes its first account claim.

The old `PUT /.arbor/claims/{handle}` operation, which creates and hosts a
profile from an uploaded snapshot, is version-1 migration compatibility only.
New clients do not call it.

### 1.2 Optional proof when joining an existing profile to another Canopy

```text
PUT /.arbor/profile-proofs/{ProfileProofID}
PUT /.arbor/profile-proofs/{ProfileProofID}/consume
PUT /.arbor/accounts
```

The administrator-authored member reservation already binds the target account
allocation to an exact profile TreeID. A Canopy may additionally require proof
that the claimant controls that profile through an existing account. In that
case, an administrator of the existing account generates a random
`ProfileProofID` and secret. The first route records only
the secret digest, the issuing account's profile `TreeID`, the target Canopy
origin, complete target account locator, target configuration `TreeID`, and a short server-bounded
expiry. Exact retry with the same ID and body is idempotent; a different body
for that ID fails.

When proof is used, the account-join body names the issuer origin, proof ID and raw proof secret,
the existing profile `TreeID`, a newly generated configuration
`TreeID`, a generated first `DeviceID`, its label and credential digest, and a
complete initial configuration snapshot. The target calls the issuer's consume
route over HTTPS with the proof secret and exact target binding. The issuer
compares the digest and returns the bound profile TreeID without returning the
secret. Exact consume retry for the same target is idempotent; a different,
expired, or concurrent consume fails. The issuer URL is transient verification
input, not profile identity or a field in the accepted configuration graph.

Successful verification then permits the same ordinary account claim described
in §1.1. It atomically creates the new Canopy account,
configuration tree, credential binding, and first administrator. It does not
copy, relocate, or create the profile tree. Exact retry is idempotent; expired,
replayed for a different target, mismatched, or unverifiable proofs fail
closed. After joining, ordinary account and tree synchronization requires no
ongoing federation with the proof issuer.

## 2. Account-configuration graph

Each Canopy account has one private `account-configuration` Arbor tree with
this complete graph layout:

```text
/
  account.yaml
  trees.yaml
  devices.yaml
```

The graph shape identifies this configuration generation; its authored files
do not repeat a format version. The server rejects every other graph path,
including `.state`, nested device files, and placement files. The configuration
tree must not declare itself in `trees.yaml`. It is private, noncanonical, and
governed control content despite using ordinary immutable Arbor objects and
synchronization.

Local checkout, private-state, migration, and credential-storage choices are
outside the portable graph. In particular, no operating-system path or
placement projection is synchronized through an account-configuration tree.

## 3. Configuration YAML

The three configuration files are strict, ordinary, human-editable UTF-8 YAML.
Mappings shown below are the complete top-level shapes: there is no `version`,
`trees`, `devices`, or other wrapper key.

```yaml
# account.yaml
canopy: "https://canopy-a.example"
profile: "tr_joe_profile"
```

```yaml
# trees.yaml
tr_notes:
  canonical: "https://canopy-a.example/~joe/notes"
  access:
    - subject:
        kind: everyone
      access: read
tr_private:
  canonical: "https://canopy-a.example/~joe/private"
  access: []
```

```yaml
# devices.yaml
dv_mac:
  label: "Joe's Mac"
  administrator: true
dv_phone:
  label: "Joe's iPhone"
```

`account.yaml` records the portable account relationship directly. `canopy` is
the normalized HTTPS origin and `profile` is the stable person-profile
`TreeID`. The file contains no handle, account locator, home, principal,
administrator list, or nested community object. Account-locator allocation
belongs to the Canopy's community policy.

`trees.yaml` is keyed directly by client-generated `TreeID`. Each entry declares
one tree hosted by this account, its complete canonical HTTPS URL, and its ACL.
The canonical URL's origin must equal `account.yaml`'s `canopy`; the Canopy then
decides whether that account may allocate its requested path. A full URL makes
the intended Canopy visible where the canonical placement is authored; it
remains a replaceable secondary name rather than tree identity. The account's
profile need not appear in this map unless this Canopy actually hosts it. To
give the profile a canonical URL at this Canopy, add its already-existing
`TreeID` to `trees.yaml` and activate it through the ordinary mechanism in §6.

`devices.yaml` is keyed directly by `DeviceID`. An entry means that device has
an active credential binding for this account. `administrator` is optional and
defaults to `false`. At least one active device must be an administrator.
Pairing adds a new ordinary-device entry. Deleting an entry atomically revokes
its credential and permanently retires its `DeviceID`; pairing it again creates
a new identity.

An ordinary device may change only its own safe fields, currently `label`. An
administrator may change safe labels, promote or demote devices, and revoke a
device by deleting its entry. No transition may remove or demote the final
administrator. A device cannot create its own entry, change its own
administrator bit, or revive a retired `DeviceID` through a configuration edit.
Only an administrator may edit `trees.yaml`. `account.yaml.profile` is immutable
after account creation; a Canopy-origin transition is a coordinated account
lifecycle operation rather than an ordinary file-only edit.

Removing an uninitialized tree declaration cancels its reservation. Removing
an active remote tree declaration is invalid until Arbor specifies a remote
deletion lifecycle ([deferred 1](../spec.md#deferred)).

YAML never contains refs, update IDs, retry state, conflict choices, status,
device credential digests, raw credentials, raw access-link secrets, raw
profile-proof secrets, filesystem paths, placement options, or proof issuers.
Link-subject digests are allowed because they are ACL identity, not the secret.

A conforming parser rejects duplicate keys, aliases, unknown fields, malformed
IDs, non-HTTPS or non-normalized Canopy origins, canonical URLs outside the
account's origin, canonical paths forbidden by Canopy policy, invalid ACL values,
credential-binding identity disagreement, an empty administrator set, and all
other ambiguous identities. Existing shorter legacy IDs may be accepted during
migration; newly activated trees and paired devices use a prefix plus 26
lowercase base32 characters encoding 128 random bits.

A syntactically or semantically invalid candidate cannot become the accepted
configuration. Generated IDs, status, retry state, and normalized YAML are not
inserted into accepted user-authored files.

The account tokens, and what each survives:

| Token | Identifies | Minted by | Survives |
|---|---|---|---|
| configuration `TreeID` | one Canopy account connection | the first device | Canopy naming changes and local moves |
| profile `TreeID` | one person or group | the first local workspace | all account, canonical-name, and hosting changes |
| `DeviceID` | one credential binding for one account | the device | everything except deletion of its `devices.yaml` entry |
| `PairingID` | one short-lived pairing secret for one account | the server | nothing; it is single use |
| `ProfileProofID` | one short-lived, target-bound account join proof | an existing profile-account administrator | nothing; it is single-target and expires |
| access-link digest | one access link | hashing the secret, which is shown once and never stored | deleting the rule revokes it |

## 4. Local placements

Placement is intentionally separate from account membership, device
registration, and portable Arbor content. Each implementation may choose its
own local representation, but it must keep operating-system paths and
placement-private options outside synchronized configuration and Wire content.
Removing a placement stops that local materialization without deleting local
files, remote identity, ACLs, history, canonical boundaries, or conflicts.

The Interface 005 reference layout groups local placements by configuration
`TreeID`, then maps canonical absolute local paths directly to hosted `TreeID`s:

```yaml
# ~/.arbor/placements.yaml (informative, not portable Arbor content)
tr_config_a:
  "/Users/joe/Documents/Notes": "tr_notes"
tr_config_b:
  "/Users/joe/Documents/Sketches": "tr_sketches"
```

There is no top-level wrapper or format version. Grouping by configuration
`TreeID`, rather than origin, permits several accounts at one Canopy and
survives a Canopy-domain change. A value may later widen to a mapping such as
`{ tree: tr_notes, projection: ... }` when a placement-specific option is
needed. Arbor-managed replicas are still real local paths, normally beneath
private state, and follow the same one-path-to-one-tree rule. This reference
layout does not make OS paths portable or synchronized.

## 5. Device pairing

```text
POST /.arbor/pairings
PUT  /.arbor/pairings/{PairingID}/claim
```

An authenticated device creates a short-lived, single-use pairing secret for
one Canopy account. The claimant locally generates a new account-scoped
`DeviceID` and credential, durably stores the raw credential before claiming,
and sends only its digest together with its label and pairing secret. The
server atomically adds an ordinary-device entry to `devices.yaml` and binds the
digest. Pairing carries no placement or local path. Exact claim retry uses the
same pairing secret, DeviceID, label, and credential digest and is idempotent;
concurrent, altered, or expired reuse fails. No response returns the raw new
credential.

One physical installation paired with two accounts has two `DeviceID`s and two
credentials. Native clients present this literally as one QR for one account;
the person repeats the account-local flow to add another. There is no
multi-account pairing transaction or global device identity.

## 6. Declaring and activating a tree

Adding an unknown client-generated `TreeID` to `trees.yaml` first accepts and
reserves its identity, canonical URL, and ACL. Private derived status becomes
`awaiting-initialization`. Pending trees are unreadable, unresolved, and
unattached.

An authenticated administrator for the account submits the tree's complete
initial snapshot:

```text
POST /.arbor/trees/{TreeID}/updates
{ "base": null, "candidate": <root>, "ifMatch": "bytesHash", "objects": [...] }
```

Activation is an ordinary update whose base is `null` and whose `ifMatch` is
`bytesHash`: it has the same request identity, replay, and `UpdateResult` as
every later update. The server requires authorization and a declaration in the
submitting account, not a server-visible filesystem placement. It validates
the graph and any applicable profile invariant, creates the first accepted
update, applies the declared ACL and canonical boundary, marks the tree active,
and emits `tree.activation` on the account's configuration tree atomically.
First valid activation wins: an identical replay returns `current`, and a
different snapshot for an already active TreeID is `conflict`. Removing the
pending declaration cancels the reservation. Pending, activating, active, and
error status remains derived private state and events, never YAML.

## 7. Governed account tree

For storage, immutable objects, snapshots, accepted updates, merging, replicas,
and observation, the account-configuration tree is an ordinary private,
noncanonical Arbor tree whose updates carry `ifMatch: "modelHash"` with
`onConflict: "merge"`. It additionally has the closed, code-defined server-side
policy `account-config-v2`; all other trees use `ordinary`. This is not a
generic policy or plugin mechanism. The `v2` suffix versions the Wire-visible
merge algorithm; it is not a `version` field in any authored YAML file.

For every candidate and merged root, the server parses and validates the
complete graph and semantic diff, authenticates the submitting credential
against the current accepted root, enforces the per-device and administrator
rules, and atomically applies credential revocation, administrator changes,
existing-tree ACL changes, and canonical-boundary changes with acceptance of
the root. Caller assertions never replace authorization from the current
accepted root. Derived credential bindings, retired IDs, status, and indexes
live in the server database while the accepted graph remains canonical.

The top-level entries of `devices.yaml` merge by `DeviceID`; `trees.yaml`
entries merge by `TreeID`; ACLs merge by semantic subject. Disjoint changes
auto-merge. Delete versus unchanged resolves to delete, and an administrator's
device revocation wins a concurrent edit by that revoked device. Incompatible
edits to the same semantic field create a private typed conflict that requires
an explicit exact-identity resolution. YAML receives no conflict markers or
`conflictResolution` field.
