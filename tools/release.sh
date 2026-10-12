#!/bin/sh
set -eu

# One release of everything people install: the Mac app (a GitHub release
# with the notarized DMG and the Sparkle appcast), the iPhone app (an upload
# to App Store Connect, for TestFlight) and the story command (@ovst/cli on
# npm), all at one version.
#
#   tools/release.sh <version>            e.g. tools/release.sh 0.1.1
#   tools/release.sh <version> --only mac,ios,npm    any subset, comma-separated
#   tools/release.sh <version> --quagmire 0.11.0     Quagmire's version, if released
#
# The apps build against the Quagmire release that swift/project.yml pins, not
# the sibling checkout. When ../quagmire's main has moved past that pin, this
# first releases it (the next minor version unless --quagmire names one), after
# asking, and commits both pins moved to it.
#
# It builds and checks everything first and publishes only at the end, after
# asking once. The build number is the commit count, so it rises with every
# release. Pushing main, which this does, also deploys the host.
#
# Needs: a clean main, the Developer ID certificate and the story-notary
# keychain profile (swift/scripts/release-mac.sh), Xcode signed in to the team
# (swift/scripts/release-ios.sh), `gh` and `npm` logged in. With an App Store
# Connect API key named in ~/.appstoreconnect/story.env (STORY_ASC_KEY_ID and
# STORY_ASC_ISSUER_ID), the uploaded build is also added to the TestFlight group
# STORY_TESTFLIGHT_GROUP (default Friends) and submitted for beta review;
# without it, do that by hand. Approve the npm publish if npm stages it.
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

usage() { echo "usage: $0 <version> [--only mac,ios,npm] [--quagmire X.Y.Z]" >&2; exit 2; }
semver() { printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }
version=${1:-}
semver "$version" || usage
shift
parts=mac,ios,npm
quagmire_version=
while [ $# -gt 0 ]; do
  case $1 in
    --only) parts=${2:?--only needs a list such as mac,npm}; shift 2 ;;
    --quagmire) quagmire_version=${2:?--quagmire needs a version such as 0.11.0}; semver "$quagmire_version" || usage; shift 2 ;;
    *) usage ;;
  esac
done
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

# The apps build against the pinned Quagmire release. If Quagmire's main has
# moved past the pin, release it and move both pins (and the editor's lock) to it.
if wants mac || wants ios; then
  quagmire="$repository_root/../quagmire"
  [ -d "$quagmire/.git" ] || { echo "error: no Quagmire checkout at ../quagmire" >&2; exit 1; }
  [ "$(git -C "$quagmire" branch --show-current)" = "main" ] || { echo "error: ../quagmire is not on main" >&2; exit 1; }
  [ -z "$(git -C "$quagmire" status --short)" ] || { echo "error: ../quagmire has changes; commit or stash them" >&2; exit 1; }
  git -C "$quagmire" fetch -q --tags origin main
  [ "$(git -C "$quagmire" rev-parse HEAD)" = "$(git -C "$quagmire" rev-parse origin/main)" ] \
    || { echo "error: ../quagmire main does not match origin/main; push or pull it" >&2; exit 1; }

  pinned=$(sed -n '/^  Quagmire:$/,/exactVersion/s/^    exactVersion: //p' swift/project.yml)
  editor_pinned=$(sed -n 's|.*"https://github.com/jxe/quagmire.git", exact: "\(.*\)").*|\1|p' swift/Packages/StoryEditor/Package.swift)
  semver "$pinned" || { echo "error: no Quagmire exactVersion in swift/project.yml" >&2; exit 1; }
  [ "$editor_pinned" = "$pinned" ] || { echo "error: StoryEditor pins Quagmire $editor_pinned but swift/project.yml pins $pinned" >&2; exit 1; }

  quagmire_head=$(git -C "$quagmire" rev-parse HEAD)
  if [ "$(git -C "$quagmire" rev-list -n 1 "refs/tags/$pinned")" = "$quagmire_head" ]; then
    target=$pinned
  else
    # Already released at HEAD (say, by hand) needs only the pins moved.
    target=$(git -C "$quagmire" tag --points-at HEAD | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t . -k 1,1n -k 2,2n -k 3,3n | tail -n 1 || true)
    if [ -z "$target" ]; then
      if [ -n "$quagmire_version" ]; then
        target=$quagmire_version
      else
        latest=$(git -C "$quagmire" tag | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t . -k 1,1n -k 2,2n -k 3,3n | tail -n 1)
        target=$(printf '%s\n' "$latest" | awk -F . '{ print $1 "." $2 + 1 ".0" }')
      fi
      git -C "$quagmire" rev-parse --verify --quiet "refs/tags/$target" >/dev/null \
        && { echo "error: Quagmire $target already exists; pass --quagmire with a new version" >&2; exit 1; }
      echo "== Quagmire main is $(git -C "$quagmire" rev-list --count "refs/tags/$pinned..HEAD") commits past $pinned:"
      git -C "$quagmire" log --format='  %s' "refs/tags/$pinned..HEAD"
      printf 'Release Quagmire %s now (pushes its main and tag)? Type yes: ' "$target"
      read answer
      [ "$answer" = "yes" ] || { echo "Nothing released. Pass --quagmire X.Y.Z to choose its version."; exit 1; }
      # Quagmire's release requires its README's install example to name the version.
      sed -i '' "s/exact: \"[0-9]*\.[0-9]*\.[0-9]*\"/exact: \"$target\"/" "$quagmire/README.md"
      if [ -n "$(git -C "$quagmire" status --short)" ]; then
        git -C "$quagmire" commit -q -m "Release $target" README.md
        git -C "$quagmire" push -q origin main
      fi
      "$quagmire/scripts/release.sh" "$target"
      "$quagmire/scripts/release.sh" "$target" --push
    fi
  fi

  if [ "$target" != "$pinned" ]; then
    echo "== Moving the Quagmire pins from $pinned to $target"
    sed -i '' "/^  Quagmire:\$/,/exactVersion/s/^    exactVersion: $pinned\$/    exactVersion: $target/" swift/project.yml
    sed -i '' "s|\"https://github.com/jxe/quagmire.git\", exact: \"$pinned\"|\"https://github.com/jxe/quagmire.git\", exact: \"$target\"|" swift/Packages/StoryEditor/Package.swift
    # The generated project, edited to match project.yml as xcodegen would write it.
    [ "$(grep -c "version = $pinned;" swift/Story.xcodeproj/project.pbxproj)" = "1" ] \
      || { echo "error: expected one 'version = $pinned;' in swift/Story.xcodeproj/project.pbxproj" >&2; exit 1; }
    sed -i '' "s/version = $pinned;/version = $target;/" swift/Story.xcodeproj/project.pbxproj
    # Resolve the editor's lock in a copy, so an editable-mode Quagmire in the
    # real package (see DEVELOPMENT.md) can't leak a local path into it.
    lock_work=$(mktemp -d)
    rsync -a --exclude .build --exclude .swiftpm swift/Packages/ "$lock_work/"
    swift package --package-path "$lock_work/StoryEditor" resolve >/dev/null
    cp "$lock_work/StoryEditor/Package.resolved" swift/Packages/StoryEditor/Package.resolved
    rm -rf "$lock_work"
    grep -q "\"version\" : \"$target\"" swift/Packages/StoryEditor/Package.resolved \
      || { echo "error: the StoryEditor lock did not resolve Quagmire $target" >&2; exit 1; }
    git add swift/project.yml swift/Story.xcodeproj/project.pbxproj \
      swift/Packages/StoryEditor/Package.swift swift/Packages/StoryEditor/Package.resolved
    git commit -q -m "Use Quagmire $target"
  fi
  # Build against the pin, even where Story.local.xcworkspace overrides it.
  STORY_USE_PINNED_PACKAGES=1
  export STORY_USE_PINNED_PACKAGES
fi

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
{ wants mac || wants ios; } && echo "  - built with Quagmire $target"
wants mac && echo "  - push main and $tag (deploys the host); GitHub release with Story-$version.dmg, Story.dmg, appcast.xml"
wants ios && echo "  - archive and upload the iPhone app to App Store Connect, then add it to its TestFlight group"
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
  if [ -f "$HOME/.appstoreconnect/story.env" ]; then
    # In a subshell: the key is for this step, and the upload above signs in through Xcode.
    (
      set -a
      . "$HOME/.appstoreconnect/story.env"
      set +a
      bun tools/testflight.ts distribute "$version" "$build" \
        --group "${STORY_TESTFLIGHT_GROUP:-Friends}" \
        --notes "${STORY_TESTFLIGHT_NOTES:-Story $version. Pair with your Mac from Sync & Accounts, or tap Look Around First to try the editor on sample pages.}"
    ) || { testflight_failed=1; echo "warning: the build is uploaded but was not added to its TestFlight group; do that in App Store Connect" >&2; }
  else
    testflight_failed=1
  fi
fi
if wants npm; then
  echo "== Publishing the story command"
  npm publish ./dist/npm-cli
fi

echo
echo "Released $version."
wants mac && echo "  Mac: https://github.com/jxe/arbor/releases/tag/$tag  (stable link: https://github.com/jxe/arbor/releases/latest/download/Story.dmg)"
if wants ios; then
  if [ "${testflight_failed:-}" = "1" ]; then echo "  iPhone: add build $build to its group in App Store Connect > TestFlight once it has processed."
  else echo "  iPhone: build $build is in its TestFlight group."; fi
fi
wants npm && echo "  npm: if the publish was staged, approve it on npmjs.com; then bunx @ovst/cli@$version --version"
exit 0
