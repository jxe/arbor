#!/bin/sh
set -eu

# One release of everything people install: the Mac app (a GitHub release
# with the notarized DMG and the Sparkle appcast), the iPhone app (an upload
# to App Store Connect, for TestFlight) and the story command (@ovst/cli on
# npm), all at one version.
#
#   tools/release.sh <version>            e.g. tools/release.sh 0.1.1
#   tools/release.sh <version> --only mac,ios,npm    any subset, comma-separated
#
# It builds and checks everything first and publishes only at the end, after
# asking once. The build number is the commit count, so it rises with every
# release. Pushing main, which this does, also deploys the host.
#
# Needs: a clean main, the Developer ID certificate and the story-notary
# keychain profile (swift/scripts/release-mac.sh), Xcode signed in to the team
# (swift/scripts/release-ios.sh), `gh` and `npm` logged in. Afterwards, by
# hand: add the TestFlight build to its tester group, and approve the npm
# publish if npm stages it.
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

version=${1:-}
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "usage: $0 <version> [--only mac,ios,npm]" >&2; exit 2; }
parts=mac,ios,npm
if [ "${2:-}" = "--only" ]; then parts=${3:?--only needs a list such as mac,npm}; fi
wants() { case ",$parts," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
for part in $(printf '%s' "$parts" | tr ',' ' '); do
  case $part in mac|ios|npm) ;; *) echo "error: unknown part $part" >&2; exit 2 ;; esac
done

tag="v$version"
[ "$(git branch --show-current)" = "main" ] || { echo "error: release from main" >&2; exit 1; }
[ -z "$(git status --short)" ] || { echo "error: the working tree has changes; commit or stash them" >&2; exit 1; }
if wants mac && git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "error: $tag already exists" >&2; exit 1
fi
if wants npm && npm view "@ovst/cli@$version" version >/dev/null 2>&1; then
  echo "error: @ovst/cli $version is already on npm" >&2; exit 1
fi
if wants mac; then gh auth status >/dev/null 2>&1 || { echo "error: gh is not logged in" >&2; exit 1; }; fi
if wants npm; then npm whoami >/dev/null 2>&1 || { echo "error: npm is not logged in; run npm login" >&2; exit 1; }; fi

# The story command takes its version from its manifest; the apps take theirs as arguments.
current=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' packages/cli/package.json)
if [ "$current" != "$version" ]; then
  sed -i '' "s/^  \"version\": \"$current\",\$/  \"version\": \"$version\",/" packages/cli/package.json
  git add packages/cli/package.json
  git commit -q -m "Release $version"
fi
build=$(git rev-list --count HEAD)

echo "== Checking"
bun run typecheck
if wants npm; then bun run test:cli:package; fi

if wants mac; then
  echo "== Building and notarizing the Mac app ($version, build $build)"
  swift/scripts/release-mac.sh "$version" "$build"
  # A name that never changes, for a download link that never changes.
  cp "dist/mac/Story-$version.dmg" dist/mac/Story.dmg
fi
if wants npm; then
  echo "== Building the story command package"
  bun run build:cli:package
fi

echo
echo "Ready to publish $version (build $build): $parts"
wants mac && echo "  - push main and $tag (deploys the host); GitHub release with Story-$version.dmg, Story.dmg, appcast.xml"
wants ios && echo "  - archive and upload the iPhone app to App Store Connect"
wants npm && echo "  - npm publish @ovst/cli@$version"
printf 'Publish? Type yes: '
read answer
[ "$answer" = "yes" ] || { echo "Nothing published. The builds are in dist/."; exit 1; }

git push origin main
if wants mac; then
  git tag -a "$tag" -m "Story $version"
  git push origin "refs/tags/$tag"
  gh release create "$tag" --title "Story $version" --generate-notes \
    "dist/mac/Story-$version.dmg" dist/mac/Story.dmg dist/mac/appcast.xml
fi
if wants ios; then
  echo "== Uploading the iPhone app"
  swift/scripts/release-ios.sh "$version" "$build"
fi
if wants npm; then
  echo "== Publishing the story command"
  npm publish ./dist/npm-cli
fi

echo
echo "Released $version."
wants mac && echo "  Mac: https://github.com/jxe/arbor/releases/tag/$tag  (stable link: https://github.com/jxe/arbor/releases/latest/download/Story.dmg)"
wants ios && echo "  iPhone: add build $build to its group in App Store Connect > TestFlight once it has processed."
wants npm && echo "  npm: if the publish was staged, approve it on npmjs.com; then bunx @ovst/cli@$version --version"
exit 0
