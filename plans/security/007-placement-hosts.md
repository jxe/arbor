# Security 007: Place trees on other hosts

## Status

- **Priority:** P3
- **Effort:** M
- **Risk:** HIGH. A host accepts devices from a list another host publishes.
- **State:** DESIGNED 2026-09-26, together with
  [Security 006](006-device-keys.md); Phase 1 is shared with 006, and Phases 2
  to 4 follow 006's. The decisions are recorded below.
- **Builds on:** [tree configurations](../../docs/architecture/canopyd/tree-configurations.md) (canopyd 005, live 2026-09-26) (each
  profile's configuration on one **home host**) and
  [Security 006](006-device-keys.md) (key devices, and sessions opened by
  signing a host challenge).
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

It lists each key device's DeviceID, `key` (as Security 006 encodes it) and
administrator flag, as of the accepted configuration. It leaves out labels and
digest devices, which B cannot use.

This is a known cost: anyone can see how many key devices a profile has, which
are administrators, and when that changes. Limiting it to placement hosts would
need hosts to authenticate to each other, which this plan avoids.

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

1. A key device asks B for a session challenge and signs it, as Security 006
   defines; the challenge is bound to B's origin, so a session opened on A
   never works on B.
2. B finds the placement account's home host and its device keys, from its
   cache or by fetching them. B keeps a fetched list for about a minute.
3. B verifies the signature against the listed key and issues a session as
   that profile and device, an administrator device if the list says so.
4. If B's copy is older than the limit and A cannot be reached, B refuses.
5. A challenge naming a DeviceID missing from B's copy makes B refetch early,
   at most once every few seconds per profile, so nobody can use B to flood A.

B refreshes the list of each profile with open sessions, and ends the sessions
and watches of any device no longer listed. A revocation at A therefore reaches
B within the cache lifetime; the session expiry is a backstop if B's refresh
fails, since B refuses to open new sessions once its copy is stale. Digest
devices work only at A.

### What B can do

- Reads, updates and watches as the profile.
- Tree-configuration edits from administrator devices, against B's own
  `admin` rules.
- Declaring, activating and mounting trees under the person's `/~handle`.

### Code on B

B cannot read the caller's `apps.yaml`, so until
[Security 008](008-portable-profiles.md) code on B uses only rules B holds:

- `everyone` rules, and
- rules with an `app` in the `access.yaml` of B's own trees.

Code on B never uses a caller's personal access. A tree's administrators on B
approve an app for that tree by adding an `app` rule to its configuration,
which is stored and enforced on B. What this leaves out is an app acting as
its caller on a tree that grants the caller access but has no `app` rule;
Security 008 can allow that later without taking anything back.

This does not wait on anything: canopyd runs no hosted app code yet, and
[Apps 005](../apps/005-source-resolution-and-sidecar.md) owns the execution
context its sidecar will be issued, including whether code on the home host
needs the caller's own approval.

### Trust

B trusts A, over HTTPS, for the device lists of the profiles whose own profile
key named A. A compromised A can act as those profiles on B, which is no more
than A holds already. B trusts A for nothing else. Checking the list back to
the profile key, so that B need not trust A at all, is Security 008.

## Open questions

Details for Phase 1, not direction:

1. **Lifetimes:** the cache lifetime (about a minute), the early-refetch rate
   limit, and how long B serves from a stale copy while A is unreachable
   (proposed: not at all past the cache lifetime).
2. **The ordinary tree at `/~handle` on B:** its name in the spec, and what
   happens to it if the home host changes (Security 008).

## Work

### Phase 1: spec and vectors (shared with Security 006)

- [Accounts](../../docs/overstory-spec/04-accounts-and-devices.md) §1: home
  and placement hosts; §1.2: claiming a placement account; the published
  device keys.
- [Access control](../../docs/overstory-spec/05-access-control.md) §1.1: code
  on a placement host uses only `everyone` and `app` rules; §2: sessions on a
  placement host and the freshness rule; §3.2: a watch on B ends when its
  device leaves the list.
- **Gate:** `bun run check:links`, `git diff --check`, and a walk-through of
  the failures: a digest device on B, a session from A presented to B, a device
  revoked at A with an open watch on B, A unreachable past the limit, a claim
  naming a home host the profile key did not sign, code on B reaching for the
  caller's own access.

### Phase 2: canopyd (after Security 006 Phase 2)

- Home role: the device-keys route.
- Placement role: placement-account claims, fetching, caching and refreshing
  device keys, sessions from them, the ordinary tree at `/~handle`.
- **Gate:** canopyd suite and a two-host test with two local canopyd
  instances.

### Phase 3: clients

- The protocol client, CLI, Arbor Sync, Mac and iPhone: record each profile's
  home host and placement accounts, claim a placement account, open sessions
  on it.
- **Gate:** client suites and a local two-host end-to-end: claim on B, place a
  tree, edit it from two devices, revoke one at A and see B end its watch
  within the cache lifetime.

### Phase 4: deployment (needs Joe's go-ahead)

- Deploy the home role to the live host, after Security 006 is live. A live
  placement host needs a second canopyd, which is its own decision.
- Record the result in `status.md` and delete this plan.
