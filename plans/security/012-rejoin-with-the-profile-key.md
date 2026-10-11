# Security 012: Rejoin an account with the profile key

**Why and when:** Joe wants a person who already has an account on a host to get back into it from a new or wiped Mac with the identity alone, whether it is in the keychain or just recovered from a backup. Today that is refused on purpose. Decide the protocol question first; do this before people depend on Story enough to lose a Mac.

## Status

- **Effort**: M
- **Risk**: MEDIUM. It widens what the profile key can do.
- **Depends on**: Joe's decision below
- **Category**: security, product completion

## What exists

- Accounts §1.1 says the profile key "claims accounts (§1.2, §1.3); it does not recover lost devices, which is the home host's help (§5.3)". The host follows it: a second claim of a claimed account by the same profile is `AlreadyClaimedError` unless it repeats the first claim exactly (`claimAccountWithConfiguration`, `packages/overstoryd/src/overstoryd.ts`).
- A device joins an existing account by pairing with a device that already uses it, or with a recovery pairing the host's operator issues (`overstoryd recover <handle>`, valid 24 hours).
- The Mac setup form (2026-10-11) says so: after "already claimed" it points at **Already have an account? Add this Mac to it**, which takes either code.
- An identity backup is encrypted under a passphrase because the key it holds claims accounts.

## The decision

Whether the profile key may enrol a new device on its own account without another device or the operator.

- **For:** the identity backup becomes a complete way back in, with no dependence on a second device or on reaching the host's operator. It is what people expect a "recovery" file to do.
- **Against:** a stolen backup and its passphrase would then give full access to the account, not only the ability to claim the profile at another host. Today a thief with the key still needs a paired device or the operator.
- **A middle course:** the key may enrol a device, and the host tells the account's other devices and delays the new device's administrator role, so the owner can revoke it.

## Sketch, if the answer is yes

1. **Spec.** Accounts §1.1 and §5.3: a signed device-enrolment request, a profile proof over a host challenge that names the new device key, accepted for the profile's own claimed account. State what the new device may do and how existing devices learn of it.
2. **Host.** A route beside the account challenge that verifies the proof and adds the device to `devices.yaml`; conformance vectors; tests for a wrong profile, a replayed challenge and a disabled account.
3. **Clients.** Story Sync and the Swift account service: when a join answers "already claimed" and the Mac holds that account's profile key, offer **Rejoin as ~handle** instead of the pairing hint.
4. **Check** on two Macs with one identity backup, then close out in `status.md` and delete this plan.
