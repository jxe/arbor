# Security 006: Device keys alongside credential digests, and recovery

## Status

- **Priority:** P3
- **Effort:** L
- **Risk:** HIGH. It adds a second way for every device to authenticate, and a
  way to reset a person's devices.
- **State:** PHASES 1 AND 2 IMPLEMENTED 2026-09-26, not deployed. The spec
  ([accounts §1.1, §3, §5](../../docs/overstory-spec/04-accounts-and-devices.md#5-device-pairing),
  [access control §2, §3.2](../../docs/overstory-spec/05-access-control.md#2-authentication-and-secrets)),
  the vectors (`device-keys.json`), the TypeScript protocol, canopyd and
  [migration 023](../../packages/canopyd/migrations/023-device-keys/README.md)
  are done and tested, and the Swift `Overstory` models, signing bytes and
  client calls are compiled and pass `device-keys.json`; see
  [status](../../status.md). What remains is below.
- **Builds on:** [tree configurations](../../docs/architecture/canopyd/tree-configurations.md) (canopyd 005, live 2026-09-26), which
  puts a person's `devices.yaml` in their profile's configuration on its home
  host.
- **Followed by:** [Security 007](007-placement-hosts.md), which lets other
  hosts accept key devices, and [Security 008](008-portable-profiles.md),
  which retires credential digests.
- **Sequencing with 007:** one Phase 1 covers both plans' spec edits and
  vectors, since 007 depends on the session form and the key encoding decided
  here. Phases 2 to 4 of 006 land and deploy before 007's.

## The problem

A device credential is a bearer secret whose digest one host binds
([accounts §5](../../docs/overstory-spec/04-accounts-and-devices.md#5-device-pairing)).
Only that host can check it, anyone holding it can use it, and it is sent with
every request. A placement host could never check it without holding a secret
per device. And a person who loses every administrator device has no way back but the
host operator's reset (`ARBOR_RESET_ACCOUNT`), which canopyd 005 kept as its
answer to that plan's open question 1 and left profile-key recovery here.

These are the parts of portable profiles that need only one host.

## The design

### Two kinds of device entry

A `devices.yaml` entry either has a `key` or does not:

```yaml
dv_mac:
  label: "Joe's Mac"
  administrator: true
  key: ed25519:O2onvM62…
dv_phone:
  label: "Joe's iPhone"
  key: p256:A3Gu0lH4…
dv_old_ipad:
  label: "Joe's iPad"         # a digest device: no key
```

- A **key device** proves possession of the private key for `key`, which never
  leaves the device, to open a session (below).
- A **digest device** presents its bearer credential, as today. Its
  credential digest stays host state, beside the entry, as it is now; it never
  enters `devices.yaml`, so it is never copied to administrator devices or
  backups.
- `key` is an algorithm tag and the raw public key, unpadded base64url:
  `ed25519:` for a 32-byte Ed25519 key, `p256:` for a compressed SEC1 P-256
  key (ECDSA with SHA-256). A host verifies both; clients choose by where the
  key is stored.
- Both kinds have the same per-device and administrator rules. Only a key
  device can act on a host other than its home
  ([Security 007](007-placement-hosts.md)).

### Sessions

A key device does not sign each request. It signs a host challenge once and
gets a short-lived session:

1. The device asks for a challenge naming its profile and DeviceID. The host
   returns a random, single-use challenge bound to its normalized origin, the
   profile TreeID, the DeviceID and an expiry of a minute or two.
2. The device signs the canonical CBOR encoding of the challenge, as claiming
   already does ([accounts §1.2](../../docs/overstory-spec/04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key)).
3. The host verifies the signature against the entry's `key` and returns a
   random session token with an expiry of at most an hour. It stores only the
   token's digest.
4. Requests carry `Authorization: Bearer <session token>` exactly where a
   device credential goes today, so every route keeps one authentication path.

Deleting a device entry ends its sessions in the same accepted update that
revokes a digest device's credential. A watch lasts no longer than the session
it was opened with; the client reopens it with a fresh session. Compared with
today's credential, a stolen session token works on one host, for at most an
hour, and cannot open another session.

Signing each request (method, path, body digest) was rejected: canonicalizing
HTTP requests is a well-known source of verification bugs, and it needs a body
hash on every upload and a replay cache, where a session reuses the bearer
check every route already has. Binding sessions to the key, as OAuth DPoP does,
can come later if a stolen session ever matters.

### Moving to a key

There is no forced migration. A digest device whose client supports keys
generates a key pair and submits one update, authenticated with its current
credential, that adds `key` to its own entry under the same DeviceID. The host
deletes the credential binding in the same commit, so the device holds exactly
one kind from then on. A second move by the same device, or any change to an
existing `key`, is refused: a device that loses its key is re-paired as a new
device. Pairing a new device writes `key` from then on. Digests are retired in
[Security 008](008-portable-profiles.md), as a compatibility cutoff.

### Key storage

- **iPhone:** a Secure Enclave P-256 key. It is not included in device backups,
  so a restored or replacement iPhone pairs again as a new device, which is the
  intended meaning of a DeviceID.
- **Mac, the CLI and Arbor Sync:** Arbor Sync holds its installation's key, an
  Ed25519 key in operating-system credential storage beside the profile key,
  and local clients ask it for session tokens instead of the credential it
  hands out today (`GET /v1/credential`). The Mac app and the CLI never hold
  the key. Moving the Mac's key into the Secure Enclave needs a signed helper
  in the app bundle that Arbor Sync can call; that is later hardening, not
  part of this plan.

### Recovery

The profile key, kept in its backup
([accounts §1.1](../../docs/overstory-spec/04-accounts-and-devices.md#11-beginning-a-person-identity)),
can start a **reset**: one update that replaces `devices.yaml` with a single new
administrator key device. The host verifies a challenge signed by the profile
key, as claiming already does.

The host cannot tell whether the person really has no administrator device
left, since lost devices are still listed, so a reset waits:

- The reset is recorded as pending and shown to every current device.
- Any current administrator device can cancel it.
- It takes effect after a fixed wait (72 hours proposed), when it revokes every
  existing device, of both kinds, and adds the new one.
- The new device has no authority during the wait.
- The operator's reset (`ARBOR_RESET_ACCOUNT`) stays as the immediate path.

This changes what the profile-key backup is: after this plan it can take over
the profile on its home host, not only claim accounts. Phase 3 therefore makes
backups passphrase-encrypted, and restore still accepts the existing
unencrypted format.

## Decided in Phases 1 and 2

- A session challenge lasts two minutes, a reset challenge five, a session at
  most an hour (`sessionLifetimeMs`), and a session is never renewed without
  a new signature.
- A reset waits 72 hours (`resetWaitMs`). Its devices learn of it from
  `GET /.arbor/profile-resets/{ProfileTreeID}`; Phase 3 decides where each
  client shows it.
- A session challenge accepts any person profile TreeID, including one that
  predates self-certifying IDs; a reset needs a self-certifying one, since it
  is signed by the profile key.
- Unauthenticated challenge requests are limited to 30 per caller and
  profile per ten minutes.

## Open questions

1. **The backup format:** the key-derivation function and its parameters for
   passphrase-encrypted backups (Phase 3).
2. **Two meanings of "administrator"** again, since a key device's flag is
   what another host will read. canopyd 005 kept both names: a profile's
   `admin` on a tree and a device's `administrator` flag.

## Work

### Phase 3: clients

- Arbor Sync: generate and store its key, move to it, open sessions and hand
  them to local clients, encrypted backups, and the reset.
- iPhone: a Secure Enclave key, move to it, sessions.
- Mac and CLI: use Arbor Sync's sessions; show and cancel a pending reset;
  pair new devices with keys.
- **Gate:** client suites, and a local end-to-end: move the Mac to a key, pair
  the iPhone with a key, revoke it and see its session end, start a reset from
  the backup and cancel it from the Mac, then complete one.

### Phase 4: deployment (needs Joe's go-ahead)

- Run [migration 023](../../packages/canopyd/migrations/023-device-keys/README.md)
  and deploy the host; it can go before Phase 3, since existing clients keep
  working. Move Joe's devices to keys as their builds are installed.
- Record the result in `status.md` and delete this plan.
