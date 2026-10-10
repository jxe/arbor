#!/bin/sh
set -eu

# Runs the app-hosted StoryAppTests bundle, through the local workspace when
# one overrides the pinned Quagmire (DEVELOPMENT.md). Live-server cases skip
# here; `bun run test:protocol` runs the daemon-client suites against a live
# daemon. Quit any running debug Story first, or the bundle cannot launch.
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository_root"
if [ -f swift/Story.local.xcworkspace/contents.xcworkspacedata ]; then
  set -- -workspace swift/Story.local.xcworkspace "$@"
else
  set -- -project swift/Story.xcodeproj "$@"
fi
exec xcodebuild test -quiet "$@" -scheme Story -destination platform=macOS -only-testing:StoryAppTests
