#!/bin/sh
set -eu

# Builds the Mac app for download: a Release archive with the pinned Bun as
# its sync helper, signed with Developer ID under the hardened runtime, packed
# in a DMG, notarized and stapled. Output goes to dist/mac/.
#
#   swift/scripts/release-mac.sh <version> <build>      e.g. 0.1.0 7
#
# Needs a "Developer ID Application" certificate and notarization credentials
# stored as the keychain profile named by STORY_NOTARY_PROFILE (default
# story-notary; see `xcrun notarytool store-credentials`). STORY_SKIP_NOTARIZE=1
# stops after signing, to check the build without sending it to Apple.
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository_root"
[ $# -eq 2 ] || { echo "usage: $0 <version> <build>" >&2; exit 2; }
version=$1
build=$2
profile=${STORY_NOTARY_PROFILE:-story-notary}
team=B7P78ULCXS
identity=$(security find-identity -v -p codesigning | sed -n "s/.*\"\(Developer ID Application: .*($team)\)\"/\1/p" | head -n 1)
[ -n "$identity" ] || { echo "error: no Developer ID Application certificate for team $team" >&2; exit 1; }

output="$repository_root/dist/mac"
work="$output/build"
rm -rf "$work"
mkdir -p "$work"

# The helper is the Bun the repository pins, from its release, not whichever is on PATH.
bun_version=$(cat .bun-version)
bun_archive="$output/cache/bun-darwin-aarch64-$bun_version.zip"
bun_checksum=$(sed -n "s/^$bun_version  bun-darwin-aarch64.zip  //p" swift/scripts/bun-checksums.txt)
[ -n "$bun_checksum" ] || { echo "error: swift/scripts/bun-checksums.txt has no checksum for Bun $bun_version" >&2; exit 1; }
if [ ! -f "$bun_archive" ]; then
  mkdir -p "$output/cache"
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-darwin-aarch64.zip" -o "$bun_archive.part"
  mv "$bun_archive.part" "$bun_archive"
fi
[ "$(shasum -a 256 "$bun_archive" | cut -d ' ' -f 1)" = "$bun_checksum" ] || { echo "error: $bun_archive does not match its recorded checksum" >&2; exit 1; }
unzip -q -o "$bun_archive" -d "$work/bun"
BUN_EXECUTABLE="$work/bun/bun-darwin-aarch64/bun"
export BUN_EXECUTABLE

if [ -f swift/Story.local.xcworkspace/contents.xcworkspacedata ]; then
  set -- -workspace swift/Story.local.xcworkspace
else
  set -- -project swift/Story.xcodeproj
fi
xcodebuild archive -quiet "$@" -scheme Story -configuration Release \
  -destination "generic/platform=macOS" -archivePath "$work/Story.xcarchive" \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=NO MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build"

app="$work/Story.app"
ditto "$work/Story.xcarchive/Products/Applications/Story.app" "$app"

# Inside out: each nested binary, then the app that seals them.
sign() { codesign --force --sign "$identity" --options runtime --timestamp "$@"; }
find "$app/Contents/Resources/story-sync" -name "*.node" -exec codesign --force --sign "$identity" --options runtime --timestamp {} \;
sign --entitlements swift/StoryApp/story-sync.entitlements "$app/Contents/MacOS/story-sync"
sign "$app/Contents/MacOS/story-sync-service"
sign --entitlements swift/StoryApp/Story.entitlements "$app"
codesign --verify --deep --strict "$app"

dmg="$output/Story-$version.dmg"
staging="$work/dmg"
mkdir -p "$staging"
ditto "$app" "$staging/Story.app"
ln -s /Applications "$staging/Applications"
rm -f "$dmg"
hdiutil create -quiet -volname "Story $version" -srcfolder "$staging" -format UDZO "$dmg"
codesign --force --sign "$identity" --timestamp "$dmg"

if [ "${STORY_SKIP_NOTARIZE:-}" = "1" ]; then
  echo "Signed, not notarized: $dmg"
  exit 0
fi
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
xcrun stapler staple "$dmg"
spctl --assess --type open --context context:primary-signature "$dmg"
echo "$dmg"
