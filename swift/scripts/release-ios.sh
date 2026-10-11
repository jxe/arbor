#!/bin/sh
set -eu

# Archives the iPhone and iPad app and uploads it to App Store Connect, where
# it appears under TestFlight after processing.
#
#   swift/scripts/release-ios.sh <version> <build>      e.g. 0.1.0 3
#
# The build number must be higher than every build already uploaded for this
# version. Signs with the team's automatically managed distribution identity.
# Authenticates with an App Store Connect API key when STORY_ASC_KEY_ID and
# STORY_ASC_ISSUER_ID are set (the key file is STORY_ASC_KEY_PATH, by default
# ~/.appstoreconnect/private_keys/AuthKey_<id>.p8), otherwise with the account
# signed in to Xcode. STORY_SKIP_UPLOAD=1 exports an .ipa to dist/ios/ instead.
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository_root"
[ $# -eq 2 ] || { echo "usage: $0 <version> <build>" >&2; exit 2; }
version=$1
build=$2
team=B7P78ULCXS

output="$repository_root/dist/ios"
work="$output/build"
rm -rf "$work"
mkdir -p "$work"

if [ -f swift/Story.local.xcworkspace/contents.xcworkspacedata ]; then
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
xcodebuild archive -quiet "$@" -scheme Story -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$work/Story.xcarchive" \
  -allowProvisioningUpdates MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build"
shift 2
xcodebuild -exportArchive "$@" -archivePath "$work/Story.xcarchive" \
  -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$output" -allowProvisioningUpdates
