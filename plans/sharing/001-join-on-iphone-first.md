# Sharing 001: Join on an iPhone first, add a Mac later

**Why and when:** an invitation link usually arrives in a message and is tapped on a phone. Today that ends at an app that can only pair with a Mac. Joe wants a friend to be able to join from the iPhone with the same link, and add a Mac afterwards by scanning a code the Mac shows. After the first Mac and TestFlight releases are out.

> **Executor instructions**: Nothing here changes live data. The host change in step 4 is the device-only session challenge already made for agent links (accounts §5.1); confirm it is deployed before testing against the live host.

## Status

- **Effort**: L
- **Risk**: MEDIUM. The identity key would live on a phone, so losing the phone must not lose the identity.
- **Depends on**: Release 001 (a TestFlight build to install)
- **Category**: product completion

## What exists

- The iPhone app can create an identity and claim an invitation (`KeychainAccountService.createIdentity`, `claimAccount(inviteCode:)` in `swift/StoryApp/HostAccountService.swift`; `NativeAccountService` in `OverstoryClient/Credentials.swift`), but no screen uses them, the app does not handle `overstory://` links, and the native claim does not activate the profile tree as Story Sync's does (`packages/client/src/account-bootstrap.ts`).
- The iPhone cannot export its identity. `KeychainAccountService.backupIdentity` is unsupported, and the key is stored as this-device-only.
- The first device of an account is an administrator device, so it may edit `devices.yaml`.
- A device signs in at its home host by DeviceID alone, and the host names the profile (accounts §5.1). A Mac that knows the host and holds a device key can therefore find its account without being told the profile.
- Pairing today runs the other way: an existing device makes an offer, shown as a QR code, and the new device claims it. The Mac shows such a code; the iPhone scans it. The Mac setup form accepts a pasted pairing code.
- The invitation page offers the TestFlight link when the host is configured with `OVERSTORYD_STORY_IPHONE_URL`.
- The iPhone opens and edits trees but does not create one.

## Decisions

- **Backup before anything else.** Joining on an iPhone is not offered until the iPhone can back its identity up, in the Mac's backup format, to Files. The first-steps list on the iPhone requires it, as the Mac's does.
- **Adding a Mac: the Mac shows the code, the phone scans it.** This is what people know from messaging apps, and a Mac has no good way to scan. It needs no pairing offer:
  1. The Mac makes a device key and shows a QR code holding its DeviceID, public key and name, with a short confirmation code beside it.
  2. On the iPhone, **Add a Mac** scans it, shows the name and the same confirmation code, and on approval adds the device to `devices.yaml`, an ordinary configuration edit by an administrator device.
  3. The Mac learns which host to ask (below), asks it for a session challenge by its DeviceID, gets one as soon as the device exists, signs in, and continues into its first steps.
  The QR code holds nothing secret. The confirmation code is what stops a person from approving a code shown by someone else's screen.
- **The Mac learns the host over the local network.** The Mac starts knowing nothing, and there is no central place to ask. While the code is on screen the Mac listens on the local network, and the QR code also carries that listener's address and a one-time token; after approval the iPhone posts the host's address to it. Both devices must be on the same network, the iPhone asks for local-network permission, and a Mac firewall may ask too. Joe decided on 2026-10-11 that there is no fallback: nothing to type, and no link to open on the Mac. iCloud's key-value store and an AirDrop or Handoff link were the alternatives.
- **Whether the Mac added this way is an administrator device** is the person's choice on the approval screen, defaulting to yes: without it the Mac cannot share.
- **Open: what a phone-first person can do before they add a Mac.** Either the iPhone learns to create one notes tree under the account, or phone-first means reading and editing what others share. Decide before step 3.

## Steps

1. **Spec.** Accounts §5: adding a device by its public key from an administrator device, beside pairing; the QR payload and the confirmation code derived from it. A conformance vector for the payload.
2. **Identity backup on the iPhone.** Export to Files in the format `story me backup` writes, restore from it, and a shared vector so Mac and iPhone read each other's backups.
3. **Join on the iPhone.** Handle invitation links, opened as `overstory://` or pasted. This plan owns what an invitation link does on the iPhone; the iPhone's handler for opens from the OS, and every other kind of link, is [Links 001](../links/001-tree-id-links.md) phase 3. Whichever lands first adds `.onOpenURL` with the pending-open handoff, and the other adds its case to it. A join form as on the Mac (name, Join); activate the profile after the claim; first steps (photo, backup, and the answer to the open decision). Update `docs/implementing-editors/design.md`, which says iPhone setup is pairing-only.
4. **Add a Mac.** The Mac's "this account is already claimed" state shows the QR code and waits; the iPhone gets **Add a Mac** with the scanner it already has. The Mac needs the camera for nothing.
5. **Check by hand** with a fresh iPhone and a fresh Mac account: join on the phone from a link in Messages, back up, add the Mac by scanning, share from the Mac. Then lose the phone on purpose (delete the app) and recover the identity on a new install from the backup.
6. **Close out.** Record the evidence in `status.md` and delete this plan.

## Related

- [Security 012](../security/012-get-back-in-with-the-admins-help.md): Joe decided on 2026-10-11 that an identity alone does not add a device, so restoring a backup on the Mac is not a second way to add it. A person who loses the phone restores the backup on a new one and asks the host's administrator to let them back in.
- [Release 003](../release/003-app-store.md): Look Around First is the App Store reviewer's way in today; joining on the iPhone from an invitation is the fallback if sample pages are not enough. This plan replaces Joe's 2026-10-10 decision, recorded there until 2026-10-11, not to build joining on the iPhone.
- [Links 001](../links/001-tree-id-links.md) phase 3 owns the iPhone's other link opens; see step 3.
