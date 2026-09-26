# Security 006: Place trees on other hosts through home-host vouching

## Status

- **Priority:** P3
- **Effort:** L
- **Risk:** HIGH. A host accepts another host's signed word for who is
  calling, which is new trust between hosts, and every client gains a second
  way to authenticate.
- **State:** PROPOSED 2026-09-26. Direction agreed; open questions below.
- **Builds on:** [canopyd 005](../soon/005-tree-configuration-trees.md), which
  gives each profile one **home host** holding its configuration, devices
  included, and limits a profile to that host.
- **Followed by:** [Security 007](007-device-keys.md) and
  [Security 008](008-portable-profiles.md).

## The problem

After canopyd 005, a person's devices are listed only in their profile's
configuration on its home host, and device credentials are bearer secrets
whose digests only that host binds
([accounts §5](../../docs/overstory-spec/04-accounts-and-devices.md#5-device-pairing)).
Another host has no way to recognise the person's devices, so a profile
cannot hold canonical trees on a second host. The spec allows accounts at
several Canopies with one profile
([accounts §1](../../docs/overstory-spec/04-accounts-and-devices.md#1-profiles-and-host-accounts));
canopyd 005 suspends that.

Giving the second host its own device list would bring back per-account data,
which canopyd 005 removed.

## The design

A **placement host** takes the home host's signed word for who is calling. It
keeps no device list, no credential digest and no copy of the profile's
configuration.

### Vouchers

1. A device authenticates to its home host A with its ordinary credential,
   which never leaves A, and asks for a voucher for placement host B.
2. A checks the device against the profile's `devices.yaml` and returns a
   **voucher**: a signed statement of issuer A, audience B, the profile
   TreeID, the DeviceID, whether it is an administrator device, and an expiry
   a few minutes away. A signs it with its **host key**.
3. The device presents the voucher to B as its bearer credential. B verifies
   A's signature, the audience, the expiry, and that A is this profile's home
   host, and treats the caller as that profile and device.

A refuses vouchers for revoked devices, so a revocation at A reaches B within
one voucher lifetime. A voucher names its audience, so B cannot replay it to A
or to another host.

### Placement accounts

A person claims an account on B with the profile-key challenge claiming
already uses
([accounts §1.2](../../docs/overstory-spec/04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key)),
with the home host's origin added to what the profile key signs. B records a
**placement account**: profile TreeID, handle, and home host. That is host
state like the handle, not authored per-account data.

B's community root mounts the member's profile tree at `/~handle` today. The
profile tree lives at A, so on B the claim declares an ordinary tree mounted at
`/~handle` and administered by the profile, as the parent of the person's
trees there. Every tree on B has its tree configuration on B, with rules that
name the profile as on any host.

### What B can do with a voucher

- Authenticate the caller as the profile for reads, updates and watches.
- Authorize tree-configuration edits from an administrator device, from the
  voucher's administrator flag and B's own `admin` rules.
- Declare, activate and mount trees under the person's `/~handle` on B.

### What waits for Security 008

- **Lending and app approvals on B.** `apps.yaml` lives at A, so code on B has
  only the caller's access, and no lend applies on B.
- **Moving a profile's home host.**
- **Groups hosted elsewhere** as subjects in B's rules.
- **B verifying devices without A.** When A is unreachable, a device can use
  its current voucher until it expires and then cannot act on B.

## Trust

B trusts A completely for the profiles whose home A is: a compromised A can act
as them on B. That is no more than A holds already, since A alone decides which
devices act for them. B trusts A for nothing else, and only for profiles whose
own profile key named A.

## Open questions

1. **Voucher lifetime**, and whether a device refreshes it ahead of expiry or
   on refusal.
2. **Host keys:** where A publishes its public key (a well-known HTTPS path,
   or a field in its descriptor), how it rotates, and whether B pins the key it
   saw at claim.
3. **Voucher encoding:** canonical CBOR signed with Ed25519, like the claim
   challenge, is the likely form.
4. **The ordinary tree at `/~handle` on B:** its name in the spec, and whether
   a person can later move their profile tree there (a change of home host,
   Security 008).
5. **Execution tokens on B**
   ([access control §2.1](../../docs/overstory-spec/05-access-control.md#21-execution-tokens)):
   whether code on B runs for a vouched caller exactly as for a local one.

## Work

### Phase 1: spec and vectors

- [Accounts](../../docs/overstory-spec/04-accounts-and-devices.md) §1: home
  and placement hosts; §1.2: claiming a placement account; a new section for
  vouchers.
- [Access control](../../docs/overstory-spec/05-access-control.md) §2:
  vouchers as a credential, audience and expiry rules.
- Conformance vectors for voucher encoding and verification.
- **Gate:** `bun run check:links`, a walk-through of the failures: an
  expired voucher, a voucher for another audience, a voucher from a host that
  is not the profile's home, a revoked device, an unreachable home host.

### Phase 2: canopyd

- Home role: a host key, voucher issuance for a device's own profile.
- Placement role: placement-account claims, voucher verification as a
  credential, the ordinary tree at `/~handle`.
- **Gate:** canopyd suite and a two-host test with two local canopyd
  instances.

### Phase 3: clients

- The protocol client, CLI, Arbor Sync, Mac and iPhone: record each profile's
  home host and placement accounts, fetch and refresh vouchers, claim a
  placement account.
- **Gate:** client suites and a local two-host end-to-end: claim on B, place a
  tree, edit it from two devices, revoke one at A and see B refuse it.

### Phase 4: deployment (needs Joe's go-ahead)

- Deploy the home role to the live host. A live placement host needs a second
  canopyd, which is its own decision.
- Record the result in `status.md` and delete this plan.
