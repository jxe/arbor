# Security 008: Portable profiles and delegation across hosts

## Status

- **Priority:** P3
- **Effort:** XL, to be split once designed
- **Risk:** HIGH. It lets one host act on configuration another host
  accepted, and defines delegation the spec defers.
- **State:** DESIGN PROPOSED 2026-09-27, below; four decisions are Joe's
  (marked **Decide**). Once they are made, this plan splits into the four
  plans under [Split](#split) and is deleted. Formerly numbered Security 006.
- **Builds on:** [tree configurations](../../docs/architecture/canopyd/tree-configurations.md)
  (canopyd 005, live 2026-09-26: a profile's configuration on its home
  host), key devices and the operator's recovery pairing (Security 006,
  deployed 2026-09-26; credential digests retired at schema 26), and
  [Security 007](007-placement-hosts.md) (placement hosts that read the home
  host's published device keys).

## The problem

After canopyd 005, Security 006 and Security 007, a profile's configuration is
accepted only on its home host. Other hosts can place the person's trees, but
they trust the home host's published device keys and read nothing else of the
configuration:

- **Placement hosts trust the home host.** Nothing ties the published device
  keys back to the profile key.
- **Lending stops at the home host.** An `apps.yaml` entry applies only there,
  so Joe cannot lend or approve apps on a placement host, and code there uses
  only `everyone` rules and the `app` rules of trees there. Delegated
  authorization across servers is [deferred](../../docs/overstory-spec/README.md#deferred), and
  [access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority)
  says its transport is not defined.
- **The home host is a single point.** When it is unreachable, the person's
  devices cannot act anywhere once placement hosts' cached keys expire, and
  there is no way to move a profile's home.
- **Groups are subjects everywhere but configured in one place.** A rule on
  one host naming a group profile hosted on another needs that group's current
  `members`, and the group's `apps.yaml` lends only where it lives.

## The goal

One profile, one configuration, usable at every host where the profile has an
account, with no host it depends on:

- a host accepts a device, an app entry or a lend from a profile configuration
  it did not accept itself, without trusting the host it came from;
- lends and app approvals work on every host, including for code on one host
  using access held on another;
- a person's devices keep working when any one host is unreachable, and a
  profile can change its home.

## What the design must answer

1. **A device list that traces to the profile key.** The profile key signs the
   first administrator device and administrator devices sign later changes, so
   a host can check a device list without trusting the host that served it.
   Whether each change is signed or each accepted root.
2. **Where the profile configuration is accepted.** With that chain, any host
   holding a copy could accept updates and the configuration could merge like
   any tree; concurrent revocations accepted on two hosts are the hard case.
   Or the home host stays the only acceptor and others follow full copies,
   which extends Security 007's model.
3. **`apps.yaml` across hosts:** a placement host enforcing app approvals and
   lends for code and resources it holds.
4. **Freshness and revocation.** How stale may a host's copy of a profile
   configuration be when it authorizes a request? A revoked device, a removed
   lend and a removed group member each need a bound, and a host must fail
   closed when it cannot refresh.
5. **Cross-server delegation.** A host enforcing a lend from a configuration
   another host holds, and code on one host using access lent on another: how
   the host running the code proves the execution to the host holding the
   resource, and what an execution token means across hosts
   ([executable documents](../../docs/overstory-spec/07-executable-documents.md)).
6. **Group membership across hosts.** Reading a remote group's `members` for
   access rules, and the same freshness bound.
7. **Moving a home host**, and whether a placement host's ordinary tree at
   `/~handle` can become the profile tree.

## Proposed design

### The idea: a signed profile statement

Other hosts need only part of a profile's configuration: its devices (who
may act as the profile) and its `apps.yaml` (what the profile approves and
lends). The design signs exactly that part, as a **profile statement**, and
leaves the rest of the configuration (the profile tree's own `access.yaml`
and `mounts.yaml`) accepted and merged at the home host as today.

A profile statement is canonical CBOR:

```text
{ version: 1, profileTree, sequence, previous, home, devices, apps, issuedAt }
  + signer (the profile key, or a DeviceID) + signature
```

- `sequence` counts from 0; `previous` is the SHA-256 of the previous
  statement's signed bytes (null at 0). The statements form one chain per
  profile.
- `devices` is every device's DeviceID, `key` and `administrator` flag, sorted
  by DeviceID: `devices.yaml` without labels, which stay host-visible only.
- `apps` is the accepted `apps.yaml` value.
- `home` is the home host's origin (for moving a home, below).
- Statement 0 is signed by the profile key. Every later statement is signed by
  the profile key or by a device listed in the statement before it, under
  these rules: an administrator device may sign any change; any listed device
  may sign one that only adds ordinary devices (what pairing allows today, see
  below); only the profile key may change `home`.

A host verifies a chain from statement 0 to the head, then caches the head
and verifies only later statements. Device and app changes are rare, so a
chain stays short; nothing needs a checkpoint.

### Q1. A device list that traces to the profile key

**Each change is signed, not each accepted root.** The home host merges
concurrent configuration edits, and a merged root is signed by nobody. A
statement is a summary a device signs about the result it intends. So a
change to `devices.yaml` or `apps.yaml` is accepted only with the next
statement, and only as a fast-forward: a client whose statement is not the
successor of the head re-signs after rebasing its edit. Every other
configuration edit merges as it does now.

- **Editing.** Arbor Sync signs with the Mac's device key when it pushes an
  edit of the checkout's `devices.yaml` or `apps.yaml`; the iPhone signs with
  its Secure Enclave key in `TreeConfigurationClient`. The host checks that
  the statement's `devices` and `apps` equal the candidate's.
- **Pairing without the offering device.** When a device creates a pairing
  offer it also signs a **pairing ticket**: the profile, the PairingID, the
  secret's digest and the expiry. The claiming device signs the next
  statement (adding itself as an ordinary device) with its new key and cites
  the ticket; a verifier accepts it when the ticket's signer was listed. So
  pairing looks the same to the person, and the offering device need not stay
  online.
- **Recovery.** The operator cannot sign. **Decide (1):** recovery either
  requires the profile key (the person restores its backup on the new device,
  and it signs the recovery statement), or the operator's recovery pairing
  stays as it is and leaves the profile **home-attested**: its chain stops,
  and placement hosts fall back to trusting the home host, as under Security
  007. Recommended: allow both, with the profile key preferred. Recovery keeps
  its reach even when the backup is lost, and the downgrade is visible.
- **Existing profiles.** The Mac signs a statement 0 for Joe's current
  devices and apps once, with the profile key. Until a profile has a chain, a
  placement host treats it as home-attested.

This also fixes a weakness of the profile key: a stolen profile key alone
cannot take over devices, because a statement takes effect only when the home
host accepts it, and the home host accepts a profile-key statement only
through a claim or a recovery pairing the operator issued.

### Q2. Where the profile configuration is accepted

**The home host stays the only acceptor**, and orders the chain. Other hosts
verify signatures, so they need not trust it for content, but they take new
statements only from it. Accepting on several hosts would need a rule for
concurrent revocations accepted in two places, a hard problem that one person
with a few hosts does not need solved. A home host that disappears is handled
by moving the home (Q7), not by multi-acceptor merging.

### Q3. `apps.yaml` across hosts

`apps` is part of the statement, so a placement host holds a verified copy of
each account's approvals and lends. It enforces them for code it runs against
resources it holds, exactly as the home host does today, and access control
§1.1's placement-host restriction goes. Code on one host using access held on
another is Q5.

### Q4. Freshness and revocation

Signatures prove who authorized a statement, not that it is still the latest.
Freshness comes from the home host:

- A placement host refetches the chain as Security 007 does (60 s), so a
  deleted device or a removed lend reaches it within that.
- **Decide (2): how long a placement host keeps serving from its last copy
  while the home host is unreachable.** Security 007 refuses at once. With a
  signed chain the copy is still authentic, and nobody can revoke while the
  home is down anyway. The only exposure is a revocation made within 60 s of
  the outage. Recommended: a grace of one hour (a session's lifetime), after
  which the host fails closed and the person moves the home (Q7).
- Group membership (Q6) uses the same bound.

### Q5. Cross-server delegation

Code runs on host R, and the resource it needs is on host S. R cannot prove
anything to S by itself: hosts have no identities, and adding host keys is
what this design avoids. So **the caller authorizes the crossing**. At the
start of an execution that needs a resource on S, the caller's device signs
an **execution grant**: the caller's profile and DeviceID, the app TreeID and
pinned code root, the requirements on S, S's origin as the audience, and an
expiry. R forwards it with each call. S verifies the device signature against
the caller's statement chain, and verifies any lend against the lender's
signed `apps`. S enforces its own `access.yaml` as always. What S trusts R
for is only to run the pinned code, which lending already trusts the app's
administrators to do.

**Decide (3): what waits.** Anonymous callers, and lends to `everyone`
callers, have nobody to sign, and would need host identities. Recommended:
cross-host v1 is caller-signed only; those stay same-host until someone needs
them. All of Q5 waits on hosted code existing at all
([Apps 005](../apps/005-source-resolution-and-sidecar.md)).

### Q6. Group membership across hosts

A rule on S naming a group whose profile tree lives on H needs its `members`,
which are authored content, not signed. Recommended v1: S reads the group's
root document from H when that profile tree is publicly readable, trusts H
for it (as Security 007 trusts a home host for device keys), and caches it
under Q4's bound. A private remote group's rules match nobody on S, which
fails closed. A group's `apps.yaml` lends only where the group lives until
groups have statements of their own, signed by their administrators' devices;
that waits for a need.

### Q7. Moving a home host

The profile key signs a statement whose `home` names the new host. The old
home accepts it if it is alive. If it is gone, placement hosts that have
passed Q4's grace accept a profile-key statement naming a new home from any
source, and a profile-key statement wins over any device-signed statement at
the same sequence. The new home then takes the configuration, verified
against the chain. That makes the profile key the last resort when a home is
gone, so whoever holds it then holds the profile, as for claims today; the
passphrase-encrypted backup is what protects it.

The profile tree itself has to move too, with its TreeID, which is a transfer
of a tree between hosts: something Overstory does not define yet (cross-host
`arbor mv` refuses today). **Decide (4):** design that transfer as part of
this work, or leave home moves for later and accept that a lost home host
means a new identity. The placement root cannot become the profile tree,
since their TreeIDs differ. When the home moves to a host that already has a
placement account, the placement root's children move under the profile tree
and the placement root is retired.

## Split

Once the decisions are made:

| Plan | Covers | Waits on |
|---|---|---|
| Security 009: Signed profile statements | Q1, Q2, Q3's storage, Q4: the statement format and vectors, signing in Arbor Sync and on the iPhone, pairing tickets, recovery, statement 0 for Joe, placement hosts verifying chains | Security 007 |
| Security 010: App approvals and lending across hosts | Q3's enforcement, Q5 | Security 009, Apps 005 |
| Security 011: Remote groups | Q6 | Security 007 |
| Security 012: Moving a home host | Q7, and the cross-host tree transfer if Decide (4) takes it on | Security 009 |

Security 009 is the one near-term plan (`soon/`); the others go to
`security/`.

## Work

- Joe makes decisions 1–4.
- Split as above. Spec edits belong to each part's phase 1: accounts §1, §5;
  access control §1.1 and §2; the deferred list.
