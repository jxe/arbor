# Security 008: Portable profiles and delegation across hosts

## Status

- **Priority:** P3
- **Effort:** XL, to be split once designed
- **Risk:** HIGH. It lets one host act on configuration another host
  accepted, and defines delegation the spec defers.
- **State:** PROPOSED 2026-09-26. Direction agreed; no design yet. Formerly
  numbered Security 006 before that number went to home-host vouching.
- **Builds on:** [canopyd 005](../soon/005-tree-configuration-trees.md) (a
  profile's configuration on its home host),
  [Security 006](006-home-host-vouching.md) (placement hosts that take the home
  host's word for who is calling) and [Security 007](007-device-keys.md)
  (signed device keys, a device list that traces to the profile key, and
  recovery).

## The problem

After canopyd 005 and Security 006 and 007, a profile's configuration is
accepted only on its home host. Other hosts can place the person's trees, but
only by asking the home host who is calling:

- **Lending stops at the home host.** An `apps.yaml` entry applies only there,
  so Joe cannot lend access he holds on a placement host, and code there has
  only the caller's access. Delegated authorization across servers is
  [deferred](../../docs/overstory-spec/README.md#deferred), and
  [access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority)
  says its transport is not defined.
- **The home host is a single point.** When it is unreachable, the person's
  devices cannot act anywhere once their vouchers expire, and there is no way
  to move a profile's home.
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

1. **Where the profile configuration is accepted.** With Security 007's signed
   device list, every update can be checked without trusting the host that
   accepted it, so any host holding a copy could accept updates and the
   configuration could merge like any tree. Concurrent revocations accepted on
   two hosts are the hard case. Or the home host stays the only acceptor and
   others follow it, which keeps Security 006's model.
2. **Freshness and revocation.** How stale may a host's copy of a profile
   configuration be when it authorizes a request? A revoked device, a removed
   lend and a removed group member each need a bound, and a host must fail
   closed when it cannot refresh.
3. **Cross-server delegation.** A host enforcing a lend from a configuration
   another host holds, and code on one host using access lent on another: how
   the host running the code proves the execution to the host holding the
   resource, and what an execution token means across hosts
   ([executable documents](../../docs/overstory-spec/07-executable-documents.md)).
4. **Group membership across hosts.** Reading a remote group's `members` for
   access rules, and the same freshness bound.
5. **Moving a home host**, and whether a placement host's ordinary tree at
   `/~handle` can become the profile tree.

## Work

- Design, record the answers here, and split this plan into one plan per part
  before any code. Question 1 comes first; delegation and remote groups
  depend on it.
- Spec edits belong to each part's phase 1, as in canopyd 005: accounts §1
  and §5; access control §1.1; the deferred list.
