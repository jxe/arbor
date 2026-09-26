# Security 006: Portable profiles, devices and delegation across hosts

## Status

- **Priority:** P3
- **Effort:** XL, to be split once designed
- **Risk:** HIGH. It changes how every host authenticates a device, lets one
  host act on configuration another host accepted, and defines delegation the
  spec defers.
- **State:** PROPOSED 2026-09-26. Direction agreed; no design yet.
- **Builds on:** [canopyd 005](../soon/005-tree-configuration-trees.md), which
  puts a person's devices and app entries in their profile tree's
  configuration and limits a profile to one host until this plan lands.

## The problem

After canopyd 005, a person's profile configuration (`access.yaml`,
`mounts.yaml`, `apps.yaml`, `devices.yaml`) lives on one host, and a profile
has an account on that host only. That is enough for one Canopy, but the
direction is one identity used across many:

- **Placing trees under several hosts' canonical URLs.** A person should hold
  accounts at several canopyd hosts with one profile, as
  [accounts §1](../../docs/overstory-spec/04-accounts-and-devices.md#1-profiles-and-host-accounts)
  already allows, without a second device list or a second set of app
  entries.
- **Devices are per account.** A device's credential is a bearer secret whose
  digest one host binds
  ([accounts §5](../../docs/overstory-spec/04-accounts-and-devices.md#5-device-pairing)).
  One installation paired with two accounts has two DeviceIDs and two
  credentials, and revoking a lost phone means revoking it on every host.
- **Lending stops at the host.** An `apps.yaml` entry applies only on the host
  holding the configuration, so Joe cannot lend access he holds on host B from
  his configuration on host A. Delegated authorization across servers is
  [deferred](../../docs/overstory-spec/README.md#deferred), and
  [access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority)
  says its transport is not defined.
- **Groups are subjects everywhere but configured in one place.** A rule on
  host B naming a group profile hosted on host A needs that group's current
  `members`, and the group's `apps.yaml` lends only on host A.

## The goal

One profile, one configuration, usable at every host where the profile has an
account:

- a person pairs a device once and revokes it once;
- a host accepts a device, an app entry or a lend from a profile configuration
  it did not accept itself, without trusting the host it came from;
- an account is only a hosting relationship: this profile may place trees
  under these canonical URLs here.

## What the design must answer

1. **Device authentication any host can check.** Device keys that sign
   requests, replacing bearer secrets, and a device list that traces back to
   the profile key: the profile key signs the first administrator device, and
   administrator devices sign later changes? What of the profile key after
   bootstrap, given it is one permanent key
   ([accounts §1.1](../../docs/overstory-spec/04-accounts-and-devices.md#11-beginning-a-person-identity))?
2. **Where the profile configuration is accepted.** Either one host accepts
   updates and the others follow it, which brings back a home host, or every
   update is signed by a device the configuration already lists, so any host
   can accept and verify it and the configuration merges like any tree.
   Concurrent revocations accepted on two hosts are the hard case.
3. **Freshness and revocation.** How stale may host B's copy of a profile
   configuration be when it authorizes a request? A revoked device, a removed
   lend and a removed group member each need a bound, and B must fail closed
   when it cannot refresh.
4. **Cross-server delegation.** Host B enforcing a lend from a configuration
   host A holds, and code on one host using access lent on another: how the
   host running the code proves the execution to the host holding the
   resource, and what an execution token means across hosts
   ([executable documents](../../docs/overstory-spec/07-executable-documents.md)).
5. **Group membership across hosts.** Reading a remote group's `members` for
   access rules, and the same freshness bound.
6. **Claiming a second account.** A claim on a new host adopts the existing
   profile configuration instead of creating one, and the host learns which
   devices may act for the profile.
7. **Recovery.** Whether the profile key, or a quorum of devices, can reset a
   device list with no administrator device left; this ties to canopyd 005's
   first open question and the catalog's
   [recovery and administrator reset](../catalog.md#product-completion).

## Likely split

Each part is useful alone and should land and soak before the next:

1. **Signed devices on one host.** Device keys and signed requests replace
   bearer credentials, still with one host. This settles questions 1 and 7.
2. **One profile configuration on several hosts.** Questions 2, 3 and 6:
   a second account, one device list, one revocation.
3. **Cross-server delegation and remote groups.** Questions 4 and 5, and the
   spec's deferred item.

## Work

- Design the first part, record it here, and split this plan into one plan per
  part before any code.
- Spec edits belong to each part's phase 1, as in canopyd 005: accounts §1,
  §1.2 and §5; access control §1.1; the deferred list.
