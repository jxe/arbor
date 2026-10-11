#!/bin/sh
set -eu

# Packs an app in a disk image laid out the usual way: the app on the left,
# an Applications alias on the right, large icons, no toolbar or sidebar.
#
#   swift/scripts/make-dmg.sh <App.app> <volume name> <output.dmg>
#
# The layout is set by asking Finder, which macOS lets a terminal do only after
# its Automation permission is granted once. Without it the image is still
# made, unarranged, and a warning says so.
[ $# -eq 3 ] || { echo "usage: $0 <App.app> <volume name> <output.dmg>" >&2; exit 2; }
app=$1
volume=$2
output=$3
name=$(basename "$app")

work=$(mktemp -d)
trap 'hdiutil detach "$mount" -quiet -force 2>/dev/null || true; rm -rf "$work"' EXIT
mount="$work/mount"
staging="$work/staging"
mkdir -p "$staging" "$mount"
ditto "$app" "$staging/$name"
ln -s /Applications "$staging/Applications"

# A writable image first, so Finder can record the window's layout in it.
hdiutil create -quiet -volname "$volume" -srcfolder "$staging" -format UDRW -fs HFS+ "$work/layout.dmg"
hdiutil attach "$work/layout.dmg" -quiet -noautoopen -nobrowse -mountpoint "$mount"
if ! osascript >/dev/null 2>"$work/finder.log" <<SCRIPT
tell application "Finder"
  set image to POSIX file "$mount" as alias
  open image
  set shown to container window of image
  set current view of shown to icon view
  set toolbar visible of shown to false
  set statusbar visible of shown to false
  set bounds of shown to {200, 200, 800, 560}
  set options to icon view options of shown
  set arrangement of options to not arranged
  set icon size of options to 128
  set text size of options to 13
  set position of item "$name" of image to {160, 170}
  set position of item "Applications" of image to {440, 170}
  update image without registering applications
  delay 1
  close shown
end tell
SCRIPT
then
  echo "warning: Finder did not arrange the disk image ($(tr '\n' ' ' < "$work/finder.log")); it is usable but plain" >&2
fi
sync
hdiutil detach "$mount" -quiet
rm -f "$output"
hdiutil convert "$work/layout.dmg" -quiet -format UDZO -imagekey zlib-level=9 -o "$output"
