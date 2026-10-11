# Release 001: a Mac download that updates itself

**Why and when:** Joe wants friends to install Story on a Mac from a link on nxhx.org, and to keep getting updates without rebuilding from Xcode. Nothing in the repo builds a distributable app today. Joe has the Developer ID certificate and notarization credentials (keychain profile `story-notary`); the release Xcode is the last Apple item.

> **Executor instructions**: Notarizing, publishing a GitHub Release and installing on Joe's Mac each wait for Joe's go-ahead. Tagging Quagmire is Joe's step.

## Status

- **Effort**: L
- **Risk**: LOW for the download; the update mechanism is the larger remaining piece.
- **Depends on**: nothing
- **Category**: release

## What exists

- `swift/scripts/release-mac.sh <version> <build>` archives a Release build with the pinned Bun (checksum in `swift/scripts/bun-checksums.txt`) as the sync helper, signs every nested binary and the app with Developer ID under the hardened runtime, builds and signs a DMG, and, unless `STORY_SKIP_NOTARIZE=1`, notarizes and staples it. Run up to signing on 2026-10-11: the helper in the signed app starts, loads the file watcher and reports `0.1.0+2`.
- The helper's only entitlement is `com.apple.security.cs.allow-jit`. Bun also runs with none, without its JIT.
- The app reads its version and build from the build settings, stamps them into the helper, and restarts a persistent helper whose stamp differs from its own (`StorySyncProcessSupervisor.isStaleHelper`).
- There is no update mechanism, and nothing has been sent to Apple's notary service.
- Quagmire is pinned at `0.8.0` while committed code uses API from the sibling checkout, so the release script builds through `Story.local.xcworkspace` when it exists.

## Decisions

- **Developer ID, not the Mac App Store.** The app is not sandboxed: it keeps data in `~/.story` and syncs folders the person chooses.
- **GitHub Releases on `jxe/arbor`** hosts the DMG and the appcast. nxhx.org gets a link, which Joe adds.
- **Sparkle** for updates, as a macOS-only dependency.
- **arm64 only.** The deployment target is macOS 27.
- **Bundle ID stays `org.nxhx.Arbor`.** Joe decided on 2026-10-11 not to rename it; see [old names](../../docs/architecture/old-names.md).

## Steps

1. **Release Xcode (Joe).** Install the release Xcode 27 and select it; the first builds used the beta.
2. **App tests under the hardened runtime.** Run `swift/scripts/test-story-app.sh` with Story closed. The hardened runtime was enabled while Story was open, so the hosted test bundle has not launched against it. If it cannot load, limit the setting to the Release configuration.
3. **Notarize (Joe's go-ahead).** Run the release script without `STORY_SKIP_NOTARIZE`. If the notary service refuses the build, its log names the binary and the reason.
4. **Updates.** Add Sparkle as a macOS-only dependency with `SUFeedURL` set to `https://github.com/jxe/arbor/releases/latest/download/appcast.xml`, a Check for Updates menu item, and the public key in `Info.plist`; Joe generates the signing key and keeps the private half in his keychain. The release script signs Sparkle's nested helpers and writes the signed appcast.
5. **Portable build.** Release Quagmire and bump both pins by the procedure in DEVELOPMENT.md (Joe tags), so the release builds from `Story.xcodeproj` alone. Add an acknowledgements file for Bun, `@parcel/watcher`, Quagmire, Yams and Sparkle.
6. **Clean-machine walkthrough (Joe).** On a Mac account that has never run Story: download, pass Gatekeeper, approve the login item, join from an invitation link, and pair an iPhone. Then publish a second release and confirm the update installs and the helper restarts.
7. **Publish (Joe's go-ahead).** Create the GitHub Release. Set `OVERSTORYD_STORY_MAC_URL` on the host so the invitation page offers the download, and add the link on nxhx.org. Replace the symlink procedure in `packages/overstoryd/deploy/README.md` with the DMG install.
8. **Close out.** Record the evidence in `status.md` and delete this plan.

## Not verified

- Whether the notary service accepts the build, and a build made with a beta Xcode.
- Whether keychain items created under the development signature prompt once the helper is signed with Developer ID.
- Friends need macOS 27. Lowering the deployment target is out of scope.

## Remaining gap for a new person

Making a tree from a folder still needs the `story` command ([Filesystem 024](../filesystem/024-disk-editors-for-non-tree-folders.md)). A friend who only reads and edits what Joe shares does not hit it.
