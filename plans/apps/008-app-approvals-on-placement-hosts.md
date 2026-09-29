# Apps 008: App approvals and lending on placement hosts

**Why and when:** part of the lending test that follows Apps 005: an app approved at a profile's home host should work on its placement hosts too.

## Status

- **Effort:** M
- **Risk:** MEDIUM. A placement host enforces lends it read from another host.
- **State:** PLANNED 2026-09-27, split from the portable-profiles design
  (Security 008). Waits until apps run on hosts at all
  ([Apps 005](005-source-resolution-and-sidecar.md)). One decision is Joe's
  (marked **Decide**).
- **Builds on:** [Security 007](../../status.md#trees-on-other-hosts--2026-09-28) and
  [Security 009](../../status.md#trees-on-other-hosts--2026-09-28) (its refresh and
  grace).
- **Trust:** the home host, over HTTPS, as for devices. That a compromised home
  host could invent lends as well as devices is closed by
  [Security 010](../security/010-signed-profile-statements.md).

## The problem

An `apps.yaml` entry applies only at its profile's home host. On a placement
host nobody can approve an app for themselves or lend access to one, and code
there uses only `everyone` rules and the host's own `app` rules
([access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority)).

## The design

### The placement account's `apps.yaml`, by read token

`apps.yaml` says which resources a person lends to which apps, which is more
than a device list discloses, so it is not published to everyone as device
keys are:

- When a device claims a placement account on B (accounts §1.3), it first
  asks the home host A for a **placement read token** for B: a random secret,
  scoped to reading this profile's published configuration, naming B's
  origin. A stores only its digest; the claim carries the token to B.
- B fetches `GET https://A/.arbor/profiles/{ProfileTreeID}/configuration`
  with the token: the device keys as §5.4 lists them, plus the accepted
  `apps.yaml` value. The public device-keys route stays.
- An administrator device lists and revokes a profile's read tokens at A.
  Revoking one makes B's next refresh fail, as an unreachable home does.

**Decide:** the read token (recommended), or publish `apps.yaml` beside the
device keys to anyone, which is simpler and discloses the lends.

### Enforcing it on B

B indexes each placement account's fetched `apps.yaml` into its policy index
(`app_policy`) and enforces it for code it runs against resources it holds,
exactly as a home host does; access control §1.1's placement-host paragraph
goes. B refreshes it with the device keys, under Security 009's grace, so a
removed lend reaches B within 60 s while A is up.

## Work

- **Phase 1, spec:** accounts §1.3 (the token in the claim), a new §5.5 for
  the configuration route; access control §1.1.
- **Phase 2, canopyd:** read tokens at the home (issue, list, revoke;
  digest-only storage, a batch step), the configuration route, fetching and
  indexing on the placement host. **Gate:** the two-host test: a lend at A
  indexed on B, a removed lend gone within the refresh, a revoked token ending
  B's sessions.
- **Phase 3, clients:** the placement claim asks for the token first; each
  app's device list shows read tokens with a revoke action.
- **Phase 4, deployment** (needs Joe's go-ahead); record the result in
  `status.md` and delete this plan.
