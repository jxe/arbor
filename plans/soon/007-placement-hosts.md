# Security 007: Place trees on other hosts

## Status

- **Priority:** P3
- **Effort:** M
- **Risk:** HIGH. A host accepts devices from a list another host publishes.
- **State:** PHASE 1 DONE 2026-09-26: the spec is written
  ([accounts §1, §1.3, §5.4](../../docs/overstory-spec/04-accounts-and-devices.md#13-claiming-a-placement-account),
  [access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority)).
  The decisions are recorded below. PHASES 2–4 DONE: the home role
  (published device keys) is live since 2026-09-26 (`8448a63f`); the
  placement role, the clients and batch 027 (schema 27) deployed and installed
  2026-09-28 at `02689859` (see
  [status](../../status.md#trees-on-other-hosts--2026-09-28)). Two app flows
  remain, and no live placement host exists yet.
- **Builds on:** [tree configurations](../../docs/architecture/canopyd/tree-configurations.md) (canopyd 005, live 2026-09-26) (each
  profile's configuration on one **home host**) and
  key devices and sessions opened by signing a host challenge
  ([accounts §5](../../docs/overstory-spec/04-accounts-and-devices.md#5-device-pairing), Security 006,
  deployed 2026-09-26); from schema 26 every device is a key device.
- **Followed by:** [Security 009](../../status.md#trees-on-other-hosts--2026-09-28); later [Apps 008](../apps/008-app-approvals-on-placement-hosts.md) and [Security 010](../security/010-signed-profile-statements.md).

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

It lists each device's DeviceID, `key` and administrator flag, as of the
accepted configuration. It leaves out labels.

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

1. A device asks B for a session challenge and signs it, as accounts §5
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
fails, since B refuses to open new sessions once its copy is stale.

### What B can do

- Reads, updates and watches as the profile.
- Tree-configuration edits from administrator devices, against B's own
  `admin` rules.
- Declaring, activating and mounting trees under the person's `/~handle`.

### Code on B

B cannot read the caller's `apps.yaml`, so until
[Apps 008](../apps/008-app-approvals-on-placement-hosts.md) code on B uses only rules B holds:

- `everyone` rules, and
- rules with an `app` in the `access.yaml` of B's own trees.

Code on B never uses a caller's personal access. A tree's administrators on B
approve an app for that tree by adding an `app` rule to its configuration,
which is stored and enforced on B. What this leaves out is an app acting as
its caller on a tree that grants the caller access but has no `app` rule;
Apps 008 can allow that later without taking anything back.

This does not wait on anything: canopyd runs no hosted app code yet, and
[Apps 005](../apps/005-source-resolution-and-sidecar.md) owns the execution
context its sidecar will be issued, including whether code on the home host
needs the caller's own approval.

### Trust

B trusts A, over HTTPS, for the device lists of the profiles whose own profile
key named A. A compromised A can act as those profiles on B, which is no more
than A holds already. B trusts A for nothing else. Checking the list back to
the profile key, so that B need not trust A at all, is Security 010.

## Decided

1. **Lifetimes:** a placement host keeps a fetched list for 60 s, refetches
   early for an unknown DeviceID at most once per 5 s per profile, and refuses
   to open a session from a copy older than 60 s that it cannot refresh.
   [Security 009](../../status.md#trees-on-other-hosts--2026-09-28) adds a grace while the
   home is unreachable.
2. **The tree at `/~handle` on B** is the **placement root** (accounts §1.3).
   It cannot become the profile tree if the home moves (Security 010).
3. **Both names stay:** a tree's `admin` rule and a device's `administrator`
   flag. B's errors say "administrator device" for the second.

## Work

### Phase 2: canopyd

- Home role: the device-keys route. Done: `publishedDeviceKeys` and the
  protocol client's `publishedDeviceKeys`, tested in
  `tests/integration/canopyd/device-keys.test.ts`.
- Placement role. Done: claims (`homeHost` signed, placement root declared
  in one transaction), the in-memory device-key copy with its lifetime,
  early-refetch and staleness options, sessions and revocation, the placement
  descriptor, and batch step 027. Gate passed:
  `tests/integration/canopyd/placement-hosts.test.ts` with two local canopyd
  instances.

### Phase 3: clients

Done 2026-09-27, not installed:

- The protocol client; the CLI's `arbor account place <url>`, `arbor account`
  and `arbor place` onto a placement host (create a tree under the placement
  root, activate the root, or place an existing tree). A placement connection
  is stored per origin under the home connection
  (`.state/accounts/<cfg>/placements/host-<digest>/`) and uses the home
  device's key.
- Arbor Sync: `placements.yaml` names a placement host per folder
  (`{tree, host}`; a bare TreeID stays the home), each placement syncs with
  its host's session, a 401 forgets only that host's session,
  `GET /v1/credential` takes `origin`, and `POST /v1/bootstrap/placements`
  claims for the data home.
- Swift: the placement descriptor and challenge (`homeHost` signed), the
  claim, placement connections, the Other Hosts section on the Mac and
  iPhone, and on the Mac placing, opening and editing folders on a placement
  host. The iPhone holds no profile key, so it connects to placements claimed
  from the Mac with its own device key.
- Vectors: a placement challenge, and home and placement signing bytes that
  cannot stand in for each other.
- **Gate passed on Linux:** `tests/integration/arborsync-placement-host.test.ts`
  (two canopyd, two Arbor Sync data homes: claim on B, place, edit from two
  devices, revoke one at A and see B end its session and watch within the
  lifetime), `arborsync-placement-route.test.ts`, and the Swift packages
  under the Linux harness.

The Mac build, `CanopyAppTests` and the hand checks passed 2026-09-28
([status](../../status.md#trees-on-other-hosts--2026-09-28)).

### Phase 4: deployment (done 2026-09-28)

- Batch 027 cut over live with this code at `02689859`; the Mac app, Arbor
  Sync and the iPhone were rebuilt from it.

## Remaining

- Placing an existing tree on a placement host from the app's "Available
  trees" list, and the iPhone opening trees on a placement host (its
  `place(tree:from:)` uses the home host).
- Making a folder into a tree from the Mac app, onto a placement host as
  anywhere else, waits on
  [Filesystem 024](../filesystem/024-disk-editors-for-non-tree-folders.md).
- A live placement host needs a second canopyd, which is Joe's decision.
- When these are done, record them in `status.md` and delete this plan.
