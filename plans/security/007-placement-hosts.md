# Security 007: Place trees on other hosts

## Status

- **Priority:** P3
- **Effort:** M
- **Risk:** HIGH. A host accepts devices from a list another host publishes.
- **State:** PROPOSED 2026-09-26. Direction agreed; open questions below.
- **Builds on:** [tree configurations](../../docs/architecture/canopyd/tree-configurations.md) (canopyd 005, live 2026-09-26) (each
  profile's configuration on one **home host**) and
  [Security 006](006-device-keys.md) (key devices that sign requests).
- **Followed by:** [Security 008](008-portable-profiles.md).

## The problem

After canopyd 005, a profile has an account only on its home host, because only
that host knows the profile's devices. The spec allows accounts at several
Canopies with one profile
([accounts §1](../../docs/overstory-spec/04-accounts-and-devices.md#1-profiles-and-host-accounts)),
so that a person can place trees under several hosts' canonical URLs. Giving
each host its own device list would bring back per-account data.

## The design

A **placement host** B accepts the profile's key devices by reading them from
the home host A. It keeps no device list, no credential and no copy of the
profile's configuration.

### The published device keys

A serves, for each profile it is home to, the part of `devices.yaml` another
host needs, over plain HTTPS with no authentication:

```text
GET https://A/.arbor/profiles/{ProfileTreeID}/device-keys
```

It lists each key device's DeviceID, public key and administrator flag, as of
the accepted configuration. It leaves out labels and digest devices, which B
cannot use.

This is a known cost: anyone can see how many key devices a profile has and
when that changes. Limiting it to placement hosts would need hosts to
authenticate to each other, which this plan avoids.

### Placement accounts

A person claims an account on B with the profile-key challenge claiming
already uses
([accounts §1.2](../../docs/overstory-spec/04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key)),
with A's origin added to what the profile key signs. B records a **placement
account**: profile TreeID, handle and home host. That is host state like the
handle, not authored per-account data.

The profile tree lives at A, so on B the claim declares an ordinary tree
mounted at `/~handle` and administered by the profile, as the parent of the
person's trees there. Every tree on B has its tree configuration on B, with
rules that name the profile as on any host.

### Authenticating on B

1. A key device signs its request to B, as Security 006 defines.
2. B finds the placement account's home host and fetches its device keys,
   caching them for a short time (about a minute).
3. B verifies the signature against the listed key and treats the caller as
   that profile and device, an administrator device if the list says so.
4. If B's copy is older than the limit and A cannot be reached, B refuses.

A revocation at A reaches B within the cache lifetime. Digest devices work
only at A.

### What B can do

- Reads, updates and watches as the profile.
- Tree-configuration edits from administrator devices, against B's own
  `admin` rules.
- Declaring, activating and mounting trees under the person's `/~handle`.

Code on B runs with the caller's access only. `apps.yaml` handling across
hosts, lends included, is [Security 008](008-portable-profiles.md).

### Trust

B trusts A, over HTTPS, for the device lists of the profiles whose own profile
key named A. A compromised A can act as those profiles on B, which is no more
than A holds already. B trusts A for nothing else. Checking the list back to
the profile key, so that B need not trust A at all, is Security 008.

## Open questions

1. **Cache lifetime**, and whether B refetches early when a signature names an
   unknown DeviceID.
2. **Watches on B:** how a long-lived watch notices a revocation, which is
   probably B rechecking the cached list when it refreshes.
3. **The ordinary tree at `/~handle` on B:** its name in the spec, and what
   happens to it if the home host changes (Security 008).
4. **Whether code on B needs app approval** to use a caller's access at
   all, given `apps.yaml` is not read on B.

## Work

### Phase 1: spec and vectors

- [Accounts](../../docs/overstory-spec/04-accounts-and-devices.md) §1: home
  and placement hosts; §1.2: claiming a placement account; the published
  device keys.
- [Access control](../../docs/overstory-spec/05-access-control.md) §2: key
  devices on a placement host, and the freshness rule.
- **Gate:** `bun run check:links`, a walk-through of the failures: a digest
  device on B, a device revoked at A, A unreachable past the limit, a claim
  naming a home host the profile key did not sign.

### Phase 2: canopyd

- Home role: the device-keys route.
- Placement role: placement-account claims, fetching and caching device keys,
  the ordinary tree at `/~handle`.
- **Gate:** canopyd suite and a two-host test with two local canopyd
  instances.

### Phase 3: clients

- The protocol client, CLI, Arbor Sync, Mac and iPhone: record each profile's
  home host and placement accounts, claim a placement account, sign requests
  to it.
- **Gate:** client suites and a local two-host end-to-end: claim on B, place a
  tree, edit it from two devices, revoke one at A and see B refuse it within
  the cache lifetime.

### Phase 4: deployment (needs Joe's go-ahead)

- Deploy the home role to the live host. A live placement host needs a second
  canopyd, which is its own decision.
- Record the result in `status.md` and delete this plan.
