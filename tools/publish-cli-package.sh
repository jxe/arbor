#!/bin/sh
set -eu

# Publishes the story command built in dist/ and @ovst/usl, skipping any version
# already on npm. Runs in .github/workflows/publish-npm.yml, which npm trusts.
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

publish_npm() {
  directory=$1
  shift
  package=$(node -p "const p = require('./$directory/package.json'); p.name + '@' + p.version")
  if npm view "$package" version >/dev/null 2>&1; then echo "$package is already on npm"; return 0; fi
  if output=$(cd "$directory" && npm publish "$@" 2>&1); then echo "Published $package"; return 0; fi
  # A staged version waits for npm's review; publishing it again is a conflict.
  if printf '%s' "$output" | grep -q E409; then echo "$package is staged on npm"; return 0; fi
  printf '%s\n' "$output" | tail -n 5
  echo "error: $package was not published" >&2
  return 1
}

# The platform builds first, so @ovst/cli never names an optional dependency npm cannot find.
for platform in dist/npm-cli-*/; do publish_npm "${platform%/}"; done
publish_npm dist/npm-cli
publish_npm packages/usl --access public
