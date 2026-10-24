#!/bin/sh
set -eu

# Packs an app in a disk image laid out the usual way: the app on the left, an
# Applications alias on the right, large icons over a background with an arrow
# between them (dmg-background.tiff, drawn by make-dmg-background.swift), no
# toolbar or sidebar.
#
#   swift/scripts/make-dmg.sh <App.app> <volume name> <output.dmg>
#
# dmgbuild writes the window's layout into the image itself, so no Finder
# window opens and no Automation permission is needed. Install it once with
# `python3 -m pip install dmgbuild`.
[ $# -eq 3 ] || { echo "usage: $0 <App.app> <volume name> <output.dmg>" >&2; exit 2; }
app=$1
volume=$2
output=$3
scripts=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 -c 'import dmgbuild' 2>/dev/null \
  || { echo "error: dmgbuild is not installed; run python3 -m pip install dmgbuild" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# The settings file is Python that dmgbuild runs; the values come in as defines.
cat > "$work/settings.py" <<'SETTINGS'
import os.path
app = defines["app"]
name = os.path.basename(app)
format = "UDZO"
compression_level = 9
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
background = defines["background"]
window_rect = ((200, 200), (600, 360))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
arrange_by = None
icon_size = 128
text_size = 13
icon_locations = {name: (160, 170), "Applications": (440, 170)}
SETTINGS
rm -f "$output"
# dmgbuild drives hdiutil, whose every option now prints a deprecation warning; keep the rest.
python3 -m dmgbuild -s "$work/settings.py" -D app="$app" -D background="$scripts/dmg-background.tiff" \
  "$volume" "$output" 2>"$work/dmgbuild.log" || { cat "$work/dmgbuild.log" >&2; exit 1; }
grep -v '^hdiutil: WARNING: .* is deprecated' "$work/dmgbuild.log" >&2 || true
