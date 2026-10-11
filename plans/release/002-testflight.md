# Release 002: the iPhone app on TestFlight

**Why and when:** Joe's friends join on a Mac and then pair an iPhone. They need a way to install the iPhone app, and TestFlight is the short path; the public listing is [Release 003](003-app-store.md). It does not depend on [Release 001](001-mac-release.md).

> **Executor instructions**: Uploading a build and anything in App Store Connect wait for Joe's go-ahead.

## Status

- **Effort**: M
- **Risk**: LOW
- **Depends on**: nothing
- **Category**: release

## What exists

- `swift/scripts/release-ios.sh <version> <build>` archives the iPhone and iPad app, signs it with the team's managed distribution identity and uploads it to App Store Connect. Build 1 of `0.1.0` was uploaded on 2026-10-11 with the account signed in to Xcode.
- The build carries `ITSAppUsesNonExemptEncryption` (false), orientation keys for both device families, and `PrivacyInfo.xcprivacy` (UserDefaults and file timestamps; nothing collected or tracked). The icon preview masters are out of the bundle.
- The app record exists for bundle ID `org.nxhx.Arbor`, which stays (see [old names](../../docs/architecture/old-names.md)).
- The iPhone app pairs with an account that already exists; each friend has a Mac. With no account it also offers sample pages held in memory, which is the reviewer's way in. That is in the source, not yet in an uploaded build.

## Steps

1. **Test information (Joe, in App Store Connect → TestFlight).** Beta app description, feedback email, and the review contact. Friends are external testers, which needs a short beta review of the first build; the review note says the app pairs with an account made on a Mac and how the reviewer can be given one.
2. **Testers (Joe).** Create the external group, add the build, and add friends by email or public link.
3. **Hand check (Joe).** Install from TestFlight on his own iPhone, then with one friend. Set `OVERSTORYD_STORY_IPHONE_URL` on the host so the invitation page offers the TestFlight link.
4. **Close out.** Record the evidence in `status.md` and delete this plan.

## Not verified

- Whether beta review accepts the sample pages as enough to review.
- Friends need iOS 27.
