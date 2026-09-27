#!/bin/sh
set -eu

# Runs the app-hosted CanopyAppTests bundle, through the local workspace when
# one overrides the pinned Quagmire (DEVELOPMENT.md). Live-server cases skip
# here; `bun run test:protocol` runs the daemon-client suites against a live
# daemon. Quit any running debug Canopy first, or the bundle cannot launch.
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository_root"
if [ -f swift/Canopy.local.xcworkspace/contents.xcworkspacedata ]; then
  set -- -workspace swift/Canopy.local.xcworkspace "$@"
else
  set -- -project swift/Canopy.xcodeproj "$@"
fi
exec xcodebuild test -quiet "$@" -scheme Canopy -destination platform=macOS -only-testing:CanopyAppTests
