# Release 002: the iPhone app on TestFlight

**Why and when:** Joe's friends join on a Mac and then pair an iPhone. They need a way to install the iPhone app, and TestFlight is the short path; the public listing is [Release 003](003-app-store.md). Do this after [Rename 003](../rename/003-bundle-and-keychain-identifiers.md), once Joe has the Apple items in step 1. It does not depend on [Release 001](001-mac-release.md) except for the Quagmire release they share.

> **Executor instructions**: Steps 2 and 3 are repo work. Creating the app record, uploading a build and inviting testers are Joe's, or wait for his go-ahead.

## Status

- **Effort**: M
- **Risk**: LOW
- **Depends on**: Rename 003; the Quagmire release in Release 001 step 2
- **Category**: release

## What exists

The iPhone app pairs with an account that already exists and does nothing else at first launch. That is enough here: each friend has a Mac. Nothing uploads a build today, and several keys App Store Connect checks at upload are missing.

## Steps

1. **Apple account (Joe).**
   - App Store Connect → Business: the Free Apps agreement is active.
   - Register `org.nxhx.Story` and create the app record. The name "Story" alone is probably taken; choose a listing name that is free. The name under the icon stays "Story".
   - An App Store Connect API key for uploads (the same key as Release 001).
   - The release Xcode 27, not the beta.
2. **Upload validation.**
   - `ITSAppUsesNonExemptEncryption` set to false: the app uses only standard cryptography from the system.
   - Orientation keys for iPhone and iPad, since the target declares both device families.
   - `PrivacyInfo.xcprivacy` declaring the UserDefaults and file-timestamp reasons.
   - Exclude `AppIcon` preview masters (`IconPreviews`) from Resources in `swift/project.yml`.
   - Version and build numbers from the build settings (Release 001 step 2).
3. **Upload script**, `swift/scripts/release-ios.sh`: archive, export for App Store Connect, upload, with a build number that increases on every run.
4. **Testers (Joe's go-ahead).** Friends are external testers, which needs a short beta review of the first build. Write the "what to test" note and the review note: the app pairs with an account made on a Mac, and the note says how the reviewer can be given one.
5. **Hand check (Joe).** Install from TestFlight on his own iPhone after Rename 003's re-pair, then with one friend. Set the host's TestFlight URL so the invitation page offers it.
6. **Close out.** Record the evidence in `status.md` and delete this plan.

## Not verified

- Whether beta review accepts a pairing-only app without a demo account. If it does not, the reviewer path from Release 003 moves here.
- Friends need iOS 27.
