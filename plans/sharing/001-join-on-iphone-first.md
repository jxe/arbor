# Sharing 001: Join on an iPhone first, add a Mac later

**Why and when:** an invitation link usually arrives in a message and is tapped on a phone. Today that ends at an app that can only pair with a Mac. Joe wants a friend to be able to join from the iPhone with the same link, and add a Mac afterwards by scanning a code the Mac shows. After the first Mac and TestFlight releases are out.

> **Executor instructions**: Nothing here changes live data. The host change in step 4 is the device-only session challenge already made for agent links (accounts §5.1); confirm it is deployed before testing against the live host.

## Status

- **Effort**: L
- **Risk**: MEDIUM. The identity key would live on a phone, so losing the phone must not lose the identity.
- **Depends on**: Release 002 (a TestFlight build to install)
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
- **Open: how the Mac learns the host without the person typing it.** The Mac starts knowing nothing, and there is no central place to ask. Candidates, which can be combined, with typing the host's name as the fallback under all of them:
  - *Over the local network.* The QR code also carries an address and a one-time token for a listener the Mac opens while the code is on screen; after approval the iPhone posts the host's address to it. Immediate, and needs no account anywhere, but both devices must be on the same network, the iPhone asks for local-network permission, and a Mac firewall may ask too.
  - *Through iCloud.* The iPhone writes the host's address to the app's iCloud key-value store and the Mac reads it. Nothing to approve and no shared network needed, but both devices must use one Apple Account, it can lag by seconds to a minute, and the Developer ID build needs an iCloud entitlement and provisioning profile it does not have today.
  - *By handing over a link.* After approval the iPhone offers AirDrop or Handoff of the account's address, which opens Story on the Mac. One extra tap, no new permissions.
- **Whether the Mac added this way is an administrator device** is the person's choice on the approval screen, defaulting to yes: without it the Mac cannot share.
- **Open: what a phone-first person can do before they add a Mac.** Either the iPhone learns to create one notes tree under the account, or phone-first means reading and editing what others share. Decide before step 3.

## Steps

1. **Spec.** Accounts §5: adding a device by its public key from an administrator device, beside pairing; the QR payload and the confirmation code derived from it. A conformance vector for the payload.
2. **Identity backup on the iPhone.** Export to Files in the format `story me backup` writes, restore from it, and a shared vector so Mac and iPhone read each other's backups.
3. **Join on the iPhone.** Handle `overstory://` and pasted invitation links; a join form as on the Mac (name, Join); activate the profile after the claim; first steps (photo, backup, and the answer to the open decision). Update `docs/implementing-editors/design.md`, which says iPhone setup is pairing-only.
4. **Add a Mac.** The Mac's "this account is already claimed" state shows the QR code and waits; the iPhone gets **Add a Mac** with the scanner it already has. The Mac needs the camera for nothing.
5. **Check by hand** with a fresh iPhone and a fresh Mac account: join on the phone from a link in Messages, back up, add the Mac by scanning, share from the Mac. Then lose the phone on purpose (delete the app) and recover the identity on a new install from the backup.
6. **Close out.** Record the evidence in `status.md` and delete this plan.

## Related

- [Security 012](../security/012-rejoin-with-the-profile-key.md) asks whether an identity alone may add a device. If yes, restoring a backup on the Mac becomes a second way to add it.
- [Release 003](../release/003-app-store.md) needs a way in for an App Store reviewer; joining on the iPhone from an invitation is one.
