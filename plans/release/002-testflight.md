# Release 002: the iPhone app on TestFlight

**Why and when:** Joe's friends join on a Mac and then pair an iPhone. They need a way to install the iPhone app, and TestFlight is the short path; the public listing is [Release 003](003-app-store.md). It does not depend on [Release 001](001-mac-release.md).

> **Executor instructions**: Uploading a build and anything in App Store Connect wait for Joe's go-ahead.

## Status

- **Effort**: M
- **Risk**: LOW
- **Depends on**: nothing
- **Category**: release

## What exists

- `swift/scripts/release-ios.sh <version> <build>` archives the iPhone and iPad app, signs it with the team's managed distribution identity and uploads it to App Store Connect, as the account signed in to Xcode.
- The app record is "Story Docs", bundle ID `org.nxhx.Arbor`, which stays (see [old names](../../docs/architecture/old-names.md)).
- Build 2 of `0.1.0`, uploaded 2026-10-11, has Look Around First: sample pages for a phone with no account, which is the reviewer's way in. It is in the external group "Friends", submitted for beta review that day and waiting. The internal group "Story Testers" can install it without review.
- Test Information is filled in: description, feedback and review contact, and review notes that point the reviewer at Look Around First.

## Steps

1. **Beta review.** If the reviewer needs more than the sample pages, answer in App Store Connect; a rejection names the reason.
2. **Testers (Joe).** Add friends to the Friends group by email or public link.
3. **Hand check (Joe).** Install from TestFlight on his own iPhone, then with one friend. Set `OVERSTORYD_STORY_IPHONE_URL` on the host so the invitation page offers the TestFlight link.
4. **Close out.** Record the evidence in `status.md` and delete this plan.

## Not verified

- Whether beta review accepts the sample pages as enough to review.
- Friends need iOS 27.
