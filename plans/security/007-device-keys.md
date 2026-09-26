# Security 007: Signed device keys and device-list recovery

## Status

- **Priority:** P3
- **Effort:** L
- **Risk:** HIGH. It replaces how every device authenticates, and adds a way
  to reset a person's devices.
- **State:** PROPOSED 2026-09-26. Direction agreed; no design yet.
- **Builds on:** [canopyd 005](../soon/005-tree-configuration-trees.md). Can
  land before or after [Security 006](006-home-host-vouching.md).
- **Followed by:** [Security 008](008-portable-profiles.md).

## The problem

A device credential is a bearer secret whose digest one host binds
([accounts §5](../../docs/overstory-spec/04-accounts-and-devices.md#5-device-pairing)).
Only that host can check it, anyone holding it can use it, and nothing ties
the device list back to the profile's identity key. And a person who loses
every administrator device has no way back
([canopyd 005](../soon/005-tree-configuration-trees.md) open question 1).

These are the parts of portable profiles that need only one host.

## The direction

- **Device keys.** Each device holds a signing key; `devices.yaml` lists its
  public key in place of a credential digest, and requests are signed, not
  carried by a bearer secret.
- **A device list that traces to the profile key.** The profile key signs the
  first administrator device; administrator devices sign later changes to
  `devices.yaml`, so any holder of the configuration can check it without
  trusting the host that accepted it. This is what
  [Security 008](008-portable-profiles.md) builds on.
- **Recovery.** The profile key, kept in its backup
  ([accounts §1.1](../../docs/overstory-spec/04-accounts-and-devices.md#11-beginning-a-person-identity)),
  can authorize a reset of `devices.yaml` when no administrator device is left.

With device keys, Security 006's vouchers become one option: a placement host
could verify a signed request against a device list it holds. That choice
belongs to Security 008.

## Open questions

1. **Request signing:** which parts of a request are signed, replay
   protection, and the cost on every request against a session token obtained
   by signing once.
2. **Key storage** on the Mac, iPhone and CLI: Secure Enclave or keychain, and
   what a CLI on a server does.
3. **The signature chain:** whether each `devices.yaml` change carries a
   signature, or the whole file is signed as of each accepted root.
4. **Recovery limits:** whether a profile-key reset needs a waiting period or a
   notice to existing devices, since the profile key is one permanent key.
5. **Migration:** re-pairing every device, or each device registering a key
   with its current credential.

## Work

- Design, record the answers here, then write phases in the pattern of canopyd
  005: spec and vectors, protocol, canopyd, clients, a migration needing Joe's
  go-ahead.
