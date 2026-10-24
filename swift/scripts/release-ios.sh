#!/bin/sh
set -eu

# Archives the iPhone and iPad app and uploads it to App Store Connect, where
# it appears under TestFlight after processing.
#
#   swift/scripts/release-ios.sh <version> <build>      e.g. 0.1.0 3
#   swift/scripts/release-ios.sh <version> <build> --archive-only   then
#   swift/scripts/release-ios.sh <version> <build> --upload-only
#
# The two halves let tools/release.sh archive while the Mac app builds and
# upload only once publishing is confirmed. The archive builds in its own
# derived data, so it can run beside the Mac build.
#
# The build number must be higher than every build already uploaded for this
# version. Signs with the team's automatically managed distribution identity.
# Authenticates with an App Store Connect API key when STORY_ASC_KEY_ID and
# STORY_ASC_ISSUER_ID are set (the key file is STORY_ASC_KEY_PATH, by default
# ~/.appstoreconnect/private_keys/AuthKey_<id>.p8), otherwise with the account
# signed in to Xcode. STORY_SKIP_UPLOAD=1 exports an .ipa to dist/ios/ instead.
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository_root"
usage() { echo "usage: $0 <version> <build> [--archive-only|--upload-only]" >&2; exit 2; }
[ $# -eq 2 ] || [ $# -eq 3 ] || usage
version=$1
build=$2
half=${3:-}
case $half in ""|--archive-only|--upload-only) ;; *) usage ;; esac
team=B7P78ULCXS

output="$repository_root/dist/ios"
work="$output/build"
if [ "$half" != "--upload-only" ]; then
  rm -rf "$work"
  mkdir -p "$work"
fi

# tools/release.sh sets STORY_USE_PINNED_PACKAGES=1 to build against the pinned
# Quagmire release rather than the sibling checkout the local workspace adds.
if [ "${STORY_USE_PINNED_PACKAGES:-}" != "1" ] && [ -f swift/Story.local.xcworkspace/contents.xcworkspacedata ]; then
  set -- -workspace swift/Story.local.xcworkspace
else
  set -- -project swift/Story.xcodeproj
fi
if [ -n "${STORY_ASC_KEY_ID:-}" ] && [ -n "${STORY_ASC_ISSUER_ID:-}" ]; then
  key_path=${STORY_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$STORY_ASC_KEY_ID.p8}
  [ -f "$key_path" ] || { echo "error: no API key file at $key_path" >&2; exit 1; }
  set -- "$@" -authenticationKeyPath "$key_path" -authenticationKeyID "$STORY_ASC_KEY_ID" -authenticationKeyIssuerID "$STORY_ASC_ISSUER_ID"
fi

destination=upload
[ "${STORY_SKIP_UPLOAD:-}" = "1" ] && destination=export
cat > "$work/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>$destination</string>
	<key>teamID</key>
	<string>$team</string>
	<key>signingStyle</key>
	<string>automatic</string>
</dict>
</plist>
PLIST

# The scheme and authentication arguments are in "$@" for both steps; the
# export takes the archive in place of a workspace and scheme.
if [ "$half" != "--upload-only" ]; then
  xcodebuild archive -quiet "$@" -scheme Story -configuration Release \
    -destination "generic/platform=iOS" -archivePath "$work/Story.xcarchive" \
    -derivedDataPath "$output/derived" \
    -allowProvisioningUpdates MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build"
fi
[ "$half" = "--archive-only" ] && exit 0
[ -d "$work/Story.xcarchive" ] || { echo "error: no archive at $work/Story.xcarchive; run --archive-only first" >&2; exit 1; }
shift 2
xcodebuild -exportArchive "$@" -archivePath "$work/Story.xcarchive" \
  -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$output" -allowProvisioningUpdates
