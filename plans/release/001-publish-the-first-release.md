# Release 001: Publish the first Mac and iPhone builds

**Why and when:** Joe wants friends to install Story on a Mac from a link on nxhx.org, keep getting updates, and install the iPhone app from TestFlight. Both builds exist: the Mac DMG is notarized and unpublished, and the iPhone build is waiting for beta review. What is left is publishing them and checking them by hand. Joe runs most of it.

Formerly Release 001 (a Mac download that updates itself) and Release 002 (the iPhone app on TestFlight), joined on 2026-10-11 once each was down to a checklist. How the builds are made and what was verified is in [status](../../status.md#cli-package-people-and-joining-by-invitation--2026-10-11) and the scripts' own comments.

> **Executor instructions**: Notarizing, publishing a GitHub Release, uploading a build, anything in App Store Connect and installing on Joe's Mac each wait for Joe's go-ahead.

## Status

- **Effort**: S
- **Risk**: LOW for the downloads. The update path is untried: no update has been delivered, and that needs two published releases.
- **Depends on**: nothing. [Security 011](../security/011-story-sync-local-callers.md) comes before the Mac download goes beyond a few friends who each have their own Mac.
- **Category**: release

## What exists

- `tools/release.sh <version>` builds the Mac app, the iPhone app and `@ovst/cli` at one version and publishes at the end, after asking once. It has not yet run to the end.
- **Mac.** `0.1.0` build 7 is in `dist/mac/`, notarized and stapled, with Sparkle 2.10.0 reading `https://github.com/jxe/arbor/releases/latest/download/appcast.xml`. Developer ID, not the Mac App Store; arm64 and macOS 27 only.
- **iPhone.** Build 2 of `0.1.0` is in the App Store Connect record "Story Docs", in the external group "Friends", submitted for beta review on 2026-10-11. It has Look Around First, sample pages for a phone with no account, which is the reviewer's way in. The internal group "Story Testers" can install it without review. Test Information is filled in.
- The bundle ID stays `org.nxhx.Arbor` on both ([old names](../../docs/architecture/old-names.md)).

## Steps

1. **Acknowledgements.** Add an acknowledgements file to the Mac app for Bun, `@parcel/watcher`, Quagmire, Yams and Sparkle.
2. **Publish the Mac release (Joe's go-ahead).** Run `tools/release.sh <version>`, which creates the GitHub release tagged `v<version>` with the DMG, a `Story.dmg` copy for a stable link, and `appcast.xml`. Set `OVERSTORYD_STORY_MAC_URL` on the host so the invitation page offers the download, and add the link on nxhx.org. Replace the symlink procedure in `packages/overstoryd/deploy/README.md` with the DMG install.
3. **Clean-machine walkthrough (Joe).** On a Mac account that has never run Story: download, pass Gatekeeper, approve the login item, join from an invitation link, and pair an iPhone. Stop Joe's own sync helper first, until Security 011 is done.
4. **Prove an update (Joe).** Publish a second release and confirm the first installs it and the sync helper restarts on the new build.
5. **Beta review.** If the reviewer needs more than the sample pages, answer in App Store Connect; a rejection names the reason.
6. **Testers and hand check (Joe).** Add friends to the Friends group by email or public link. Install from TestFlight on his own iPhone, then with one friend. Set `OVERSTORYD_STORY_IPHONE_URL` on the host so the invitation page offers the TestFlight link.
7. **Close out.** Record the evidence in `status.md` and delete this plan.

## Not verified

- Whether keychain items created under the development signature prompt once the helper is signed with Developer ID.
- Whether beta review accepts the sample pages as enough to review.
- Friends need macOS 27 and iOS 27. Lowering either deployment target is out of scope.

## Remaining gap for a new person

After setup, making another folder into a tree still needs the `story` command ([Filesystem 024](../filesystem/024-open-plain-folders-on-the-mac.md)). The first folder is offered during setup, and a friend who only reads and edits what Joe shares does not hit it.
