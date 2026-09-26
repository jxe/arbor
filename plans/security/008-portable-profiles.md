# Security 008: Portable profiles and delegation across hosts

## Status

- **Priority:** P3
- **Effort:** XL, to be split once designed
- **Risk:** HIGH. It lets one host act on configuration another host
  accepted, and defines delegation the spec defers.
- **State:** PROPOSED 2026-09-26. Direction agreed; no design yet. Formerly
  numbered Security 006.
- **Builds on:** [canopyd 005](../soon/005-tree-configuration-trees.md) (a
  profile's configuration on its home host),
  [Security 006](006-device-keys.md) (key devices beside credential digests,
  and recovery) and [Security 007](007-placement-hosts.md) (placement hosts
  that read the home host's published device keys).

## The problem

After canopyd 005 and Security 006 and 007, a profile's configuration is
accepted only on its home host. Other hosts can place the person's trees, but
they trust the home host's published device keys and read nothing else of the
configuration:

- **Placement hosts trust the home host.** Nothing ties the published device
  keys back to the profile key.
- **Lending stops at the home host.** An `apps.yaml` entry applies only there,
  so Joe cannot lend or approve apps on a placement host, and code there has
  only the caller's access. Delegated authorization across servers is
  [deferred](../../docs/overstory-spec/README.md#deferred), and
  [access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority)
  says its transport is not defined.
- **The home host is a single point.** When it is unreachable, the person's
  devices cannot act anywhere once placement hosts' cached keys expire, and
  there is no way to move a profile's home.
- **Two kinds of device credential.** Digest devices still work at the home
  host.
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
7. **Retiring credential digests**, once every device has a key.
8. **Moving a home host**, and whether a placement host's ordinary tree at
   `/~handle` can become the profile tree.

## Work

- Design, record the answers here, and split this plan into one plan per part
  before any code. Questions 1 and 2 come first; the rest depend on them.
- Spec edits belong to each part's phase 1, as in canopyd 005: accounts §1
  and §5; access control §1.1; the deferred list.
