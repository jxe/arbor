# Security 010: Signed profile statements, and moving a home host

**Why and when:** when a host Joe does not control is involved, or a home host must be left behind.

## Status

- **Effort:** XL
- **Risk:** HIGH. It changes how every device and app change is authorized,
  and moves a profile between hosts.
- **State:** DESIGN SKETCH 2026-09-27, split from the portable-profiles design
  (Security 008). **Deferred** until a host Joe does not control is involved,
  or a home host must be left behind. Two decisions are Joe's (marked
  **Decide**).
- **Builds on:** [Security 007](../../status.md#trees-on-other-hosts--2026-09-28),
  [Security 009](../../status.md#trees-on-other-hosts--2026-09-28), and
  [Apps 008](../apps/008-app-approvals-on-placement-hosts.md) when it exists.

## Why it waits

Until then every other host trusts the home host over HTTPS for a profile's
devices (and, with Apps 008, its app lends). Signing adds nothing a person
would notice while Joe runs every host. It buys three things:

1. a compromised or malicious home host cannot act as the profile, or invent
   its lends, on other hosts;
2. a profile can move its home when the old host is gone for good, which no
   HTTPS request can do;
3. a stolen profile key alone cannot take over the profile's devices.

## The design

### A signed profile statement

Other hosts need only part of a profile's configuration: its devices and its
`apps.yaml`. A **profile statement** signs exactly that, in canonical CBOR:

```text
{ version: 1, profileTree, sequence, previous, home, devices, apps, issuedAt }
  + signer (the profile key, or a DeviceID) + signature
```

- `sequence` counts from 0; `previous` is the SHA-256 of the previous
  statement's signed bytes. One chain per profile.
- `devices` is every device's DeviceID, `key` and `administrator` flag, sorted
  by DeviceID; labels stay out. `apps` is the accepted `apps.yaml` value.
  `home` is the home host's origin.
- Statement 0 is signed by the profile key. A later one is signed by the
  profile key or a device listed in the statement before it: an administrator
  device may sign any change, any listed device one that only adds ordinary
  devices (as pairing allows), and only the profile key may change `home`.

A host verifies the chain from 0 to the head once, then only what follows.
Device and app changes are rare, so no checkpoint is needed.

### Signed changes, one acceptor

- **Each change is signed, not each accepted root**, since a root the home
  host merged is signed by nobody. A change to `devices.yaml` or `apps.yaml` is
  accepted only with the next statement, as a fast-forward: a client whose
  statement is not the head's successor re-signs after rebasing. Other
  configuration edits merge as now. Story Sync signs with the Mac's key; the
  iPhone with its Secure Enclave key.
- **Pairing:** the offering device signs a **pairing ticket** (profile,
  PairingID, secret digest, expiry) when it creates the offer; the claiming
  device signs the statement adding itself and cites the ticket. The offering
  device need not stay online.
- **The home host stays the only acceptor** and orders the chain; other hosts
  verify signatures and take statements only from it. Accepting on several
  hosts would need a rule for concurrent revocations accepted in two places.
- **A stolen profile key alone cannot take over devices:** the home accepts a
  profile-key statement only through a claim or an operator-issued recovery
  pairing.
- **Existing profiles:** the Mac signs a statement 0 once with the profile
  key. A profile without a chain is **home-attested**, and other hosts trust
  its home as they do today.

**Decide (1): recovery when every administrator device is lost.** Either it
requires the profile key (the restored backup signs the recovery statement),
or the operator's recovery pairing also stays and leaves the profile
home-attested until re-signed. Recommended: both, with the profile key
preferred.

### Moving a home host

The profile key signs a statement whose `home` names the new host. The old
home accepts it if alive. If it is gone, placement hosts past Security 009's
grace accept a profile-key statement naming a new home from any source, and a
profile-key statement wins over a device-signed one at the same sequence;
whoever holds the profile key then holds the profile, which the
passphrase-encrypted backup protects. The new home takes the configuration,
verified against the chain.

The profile tree must move too, keeping its TreeID: a transfer of a tree
between hosts, which Overstory does not define (cross-host `story mv` refuses
today). The placement root cannot become the profile tree, since their TreeIDs
differ; when the home moves to a host with a placement account, the placement
root's children move under the profile tree and it is retired.

**Decide (2):** design the cross-host tree transfer here, or separately first.

## Work

- When it is taken up: settle the decisions, write the statement format and
  vectors (TypeScript and Swift), then the home role (accepting statements,
  pairing tickets, recovery), placement hosts verifying chains, statement 0
  for Joe, and the home move with its tree transfer; split further if the
  transfer is large.
