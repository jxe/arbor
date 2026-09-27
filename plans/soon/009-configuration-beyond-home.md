# Security 009: Placement hosts through a home outage, and remote groups

## Status

- **Priority:** P3
- **Effort:** S–M
- **Risk:** MEDIUM. A placement host keeps honouring a device list it cannot
  refresh, and matches groups another host holds.
- **State:** PLANNED 2026-09-27, split from the portable-profiles design
  (Security 008). The grace is decided.
- **Builds on:** [Security 007](007-placement-hosts.md) (placement hosts that
  read the home host's published device keys).
- **Trust:** other hosts, over HTTPS, as Security 007 already trusts the home
  host for devices. Checking a profile's devices back to the profile key is
  [Security 010](../security/010-signed-profile-statements.md), deferred until
  a host Joe does not control is involved.
- **Related, not yet:** app approvals and lending on placement hosts
  ([Apps 008](../apps/008-app-approvals-on-placement-hosts.md)) and
  code using access held on another host
  ([Apps 009](../apps/009-cross-host-delegation.md)).

## The problem

After Security 007:

- a placement host refuses every new session once the home host has been
  unreachable for 60 s, so a short outage at the home stops work everywhere;
- a rule naming a group whose profile lives on another host matches nobody.

## The design

### A grace while the home host is unreachable

A placement host refreshes each profile's device keys every 60 s, so a deleted
device reaches it within that. When a refresh fails, it keeps opening sessions
from its last copy for a **grace**, then refuses.

**Decided (Joe, 2026-09-27):** one hour, a session's lifetime. Nobody can
revoke a device while its home host is down, since only the home accepts the
change, so the only exposure is a deletion made in the last 60 s before the
outage. Past the grace the host fails closed.

### Remote groups

A rule on host B naming a group profile hosted on host H needs that group's
`members`. B reads the group's root document from H when the group's profile
tree is publicly readable there, trusts H for it, and caches it under the same
60 s refresh and grace. A group that B cannot read matches nobody, which fails
closed. Groups hosted on B are unchanged.

## Work

### Phase 1: spec

- Accounts §5.4: the grace. Access control §3: membership of a group hosted
  elsewhere, its refresh and grace, and failing closed.

### Phase 2: canopyd

- The grace in the placement role's device-key cache (a constructor option,
  like the lifetimes).
- Remote group membership: fetch, cache and refresh a remote group's root
  document; rules match its members; unreadable groups match nobody.
- No schema change.
- **Gate:** canopyd suite and the two-host test extended: sessions continue
  through an outage shorter than the grace and stop after it; a deletion at A
  still reaches B within 60 s while A is up; a public remote group's member
  gains its access on B and loses it within the refresh after removal; a
  private remote group matches nobody.

### Phase 3: deployment (needs Joe's go-ahead)

- Deploy with Security 007's placement role; record the result in `status.md`
  and delete this plan.
