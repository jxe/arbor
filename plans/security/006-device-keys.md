# Security 006: Device keys alongside credential digests, and recovery

## Status

- **Priority:** P3
- **Effort:** L
- **Risk:** HIGH. It adds a second way for every device to authenticate, and a
  way to reset a person's devices.
- **State:** PROPOSED 2026-09-26. Direction agreed; open questions below.
- **Builds on:** [canopyd 005](../soon/005-tree-configuration-trees.md), which
  puts a person's `devices.yaml` in their profile's configuration on its home
  host.
- **Followed by:** [Security 007](007-placement-hosts.md), which lets other
  hosts accept key devices, and [Security 008](008-portable-profiles.md),
  which retires credential digests.

## The problem

A device credential is a bearer secret whose digest one host binds
([accounts §5](../../docs/overstory-spec/04-accounts-and-devices.md#5-device-pairing)).
Only that host can check it, anyone holding it can use it, and it is sent with
every request. A placement host could never check it without holding a secret
per device. And a person who loses every administrator device has no way back
([canopyd 005](../soon/005-tree-configuration-trees.md) open question 1).

These are the parts of portable profiles that need only one host.

## The design

### Two kinds of device entry

A `devices.yaml` entry holds exactly one of:

```yaml
dv_mac:
  label: "Joe's Mac"
  administrator: true
  key: ed25519:3b6a…          # signs requests
dv_phone:
  label: "Joe's iPhone"
  credential: sha256:9c1d…    # bearer secret, as today
```

- A **key device** signs its requests with a private key that never leaves the
  device. The host verifies the signature against `key`.
- A **digest device** presents its bearer credential, as today.
- Both kinds have the same per-device and administrator rules. Only a key
  device can act on a host other than its home
  ([Security 007](007-placement-hosts.md)).

### Moving to a key

There is no forced migration. A digest device whose client supports keys
generates a key pair and submits one update, authenticated with its current
credential, that replaces its `credential` with `key` under the same DeviceID.
Pairing a new device writes `key` from then on. Digests are retired in
[Security 008](008-portable-profiles.md), as a compatibility cutoff.

### Recovery

The profile key, kept in its backup
([accounts §1.1](../../docs/overstory-spec/04-accounts-and-devices.md#11-beginning-a-person-identity)),
can authorize one update that replaces `devices.yaml` with a single new
administrator key device, when the person has no administrator device left.
The host verifies a challenge signed by the profile key, as claiming already
does.

## Open questions

1. **What a signature covers:** the method, path, a body digest, the host's
   origin and a timestamp or nonce, against a session obtained by signing a
   host challenge once. The per-request form keeps no host state; the session
   form is cheaper per request and is the likely answer for watches.
2. **Key storage** on the Mac and iPhone (Secure Enclave keys are P-256, not
   Ed25519), for the CLI, and for Arbor Sync sharing one installation's key
   among local clients, as it shares a credential today.
3. **Recovery limits:** whether a profile-key reset waits or notifies existing
   devices, since the profile key is one permanent key and its backup is the
   thing most likely to be stolen.
4. **Two meanings of "administrator"** (canopyd 005 open question 2) again,
   since a key device's flag is what another host will read.

## Work

### Phase 1: spec and vectors

- [Accounts](../../docs/overstory-spec/04-accounts-and-devices.md) §5 and the
  `devices.yaml` shape: key devices, moving to a key, recovery.
- [Access control](../../docs/overstory-spec/05-access-control.md) §2: signed
  requests or sessions as a credential.
- Conformance vectors for signatures and the `devices.yaml` shape.
- **Gate:** `bun run check:links`, a walk-through of the failures: a replayed
  signature, a signature for another host, a device moving to a key twice, a
  reset without the profile key.

### Phase 2: protocol and canopyd

- Parse both entry kinds; verify signatures; the key update and the recovery
  update.
- **Gate:** protocol and canopyd suites.

### Phase 3: clients

- Mac, iPhone, CLI and Arbor Sync: generate and store a key, move to it,
  pair new devices with keys, sign requests; recovery from the profile-key
  backup.
- **Gate:** client suites, and a local end-to-end: move the Mac to a key, pair
  the iPhone with a key, revoke it, recover from the backup.

### Phase 4: deployment (needs Joe's go-ahead)

- Deploy; move Joe's devices to keys as their builds are installed.
- Record the result in `status.md` and delete this plan.
