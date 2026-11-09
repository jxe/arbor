#!/bin/sh
set -eu

# One release of everything people install: the Mac app (a GitHub release
# with the notarized DMG and the Sparkle appcast), the iPhone app (an upload
# to App Store Connect, for TestFlight) and the story command (@ovst/cli on
# npm), all at one version. With npm it also publishes @ovst/usl, the schema
# language that cranberries uses, when its own version isn't on npm yet.
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
# (swift/scripts/release-ios.sh), `gh` logged in, dmgbuild installed
# (swift/scripts/make-dmg.sh). With an App Store
# Connect API key named in ~/.appstoreconnect/story.env (STORY_ASC_KEY_ID and
# STORY_ASC_ISSUER_ID), the uploaded build is also added to the TestFlight group
# STORY_TESTFLIGHT_GROUP (default Friends) and submitted for beta review;
# without it, do that by hand. npm publishes from GitHub Actions
# (.github/workflows/publish-npm.yml) through npm's trusted publishing, with no
# token or one-time password, so nothing here needs anyone at the keyboard after
# "Publish?".
# Every step prints its number and the time since the start.
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
started=$(date +%s)
step_number=0
step() {
  step_number=$((step_number + 1))
  elapsed=$(( $(date +%s) - started ))
  printf '\n== [%d] %s  (%d:%02d)\n' "$step_number" "$1" $((elapsed / 60)) $((elapsed % 60))
}
wants() { case ",$parts," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
for part in $(printf '%s' "$parts" | tr ',' ' '); do
  case $part in mac|ios|npm) ;; *) echo "error: unknown part $part" >&2; exit 2 ;; esac
done

tag="v$version"
[ "$(git branch --show-current)" = "main" ] || { echo "error: release from main" >&2; exit 1; }
[ -z "$(git status --short)" ] || { echo "error: the working tree has changes; commit or stash them" >&2; exit 1; }
# Start from origin's main, so the push at the end isn't refused.
git pull -q --rebase origin main
if wants mac && git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "error: $tag already exists" >&2; exit 1
fi
if wants npm && npm view "@ovst/cli@$version" version >/dev/null 2>&1; then
  echo "error: @ovst/cli $version is already on npm" >&2; exit 1
fi
if wants mac || wants npm; then gh auth status >/dev/null 2>&1 || { echo "error: gh is not logged in" >&2; exit 1; }; fi
if wants mac; then python3 -c 'import dmgbuild' 2>/dev/null || { echo "error: dmgbuild is not installed; run python3 -m pip install dmgbuild" >&2; exit 1; }; fi

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
      step "Releasing Quagmire $target"
      echo "Quagmire main is $(git -C "$quagmire" rev-list --count "refs/tags/$pinned..HEAD") commits past $pinned:"
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
    step "Moving the Quagmire pins from $pinned to $target"
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
# What is built, tagged and published, even if the push below picks up later commits.
built=$(git rev-parse HEAD)

step "Checking"
bun run typecheck
if wants npm; then bun run test:cli:package; fi

# The iPhone archive builds beside the Mac app, and mostly while Apple notarizes it.
ios_archive=
stop_ios_archive() {
  if [ -n "$ios_archive" ]; then pkill -P "$ios_archive" 2>/dev/null || true; kill "$ios_archive" 2>/dev/null || true; fi
}
trap stop_ios_archive EXIT
if wants ios; then
  step "Archiving the iPhone app in the background (log: dist/ios/archive.log)"
  mkdir -p dist/ios
  swift/scripts/release-ios.sh "$version" "$build" --archive-only > dist/ios/archive.log 2>&1 &
  ios_archive=$!
fi

if wants mac; then
  step "Building and notarizing the Mac app ($version, build $build)"
  swift/scripts/release-mac.sh "$version" "$build"
  # A name that never changes, for a download link that never changes.
  cp "dist/mac/Story-$version.dmg" dist/mac/Story.dmg
fi
if [ -n "$ios_archive" ]; then
  step "Finishing the iPhone archive"
  archive_status=0
  wait "$ios_archive" || archive_status=$?
  ios_archive=
  if [ "$archive_status" != 0 ]; then
    tail -n 30 dist/ios/archive.log >&2
    echo "error: the iPhone archive failed; its log is dist/ios/archive.log" >&2
    exit 1
  fi
fi

echo
echo "Ready to publish $version (build $build): $parts"
{ wants mac || wants ios; } && echo "  - built with Quagmire $target"
wants mac && echo "  - push main and $tag (deploys the host); GitHub release with Story-$version.dmg, Story.dmg, appcast.xml; the tag publishes the host image ghcr.io/jxe/overstoryd:$version (and :latest) from GitHub Actions"
wants ios && echo "  - upload the iPhone app to App Store Connect, then add it to its TestFlight group"
wants npm && echo "  - from GitHub Actions, npm publish @ovst/cli@$version, its four platform builds and any new @ovst/usl"
printf 'Publish? Type yes: '
read answer
[ "$answer" = "yes" ] || { echo "Nothing published. The builds are in dist/."; exit 1; }

step "Pushing main"
# Others may push while this builds; merge their commits, so what was built stays on main.
git push origin main || { git pull -q --no-rebase --no-edit origin main && git push origin main; }
npm_run=
if wants npm; then
  step "Starting the npm publish on GitHub Actions"
  previous_run=$(gh run list --workflow publish-npm.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')
  gh workflow run publish-npm.yml --ref main -f commit="$built"
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 5
    npm_run=$(gh run list --workflow publish-npm.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')
    [ "$npm_run" != "$previous_run" ] && break
    npm_run=
  done
  [ -n "$npm_run" ] || echo "warning: could not find the npm publish run; see https://github.com/jxe/arbor/actions/workflows/publish-npm.yml" >&2
fi
if wants mac; then
  step "Publishing the GitHub release"
  git tag -a "$tag" -m "Story $version" "$built"
  git push origin "refs/tags/$tag"
  # The DMG upload sometimes times out, and gh then removes the release; one retry.
  gh release create "$tag" --title "Story $version" --generate-notes \
    "dist/mac/Story-$version.dmg" dist/mac/Story.dmg dist/mac/appcast.xml \
    || { sleep 5; gh release create "$tag" --title "Story $version" --generate-notes \
      "dist/mac/Story-$version.dmg" dist/mac/Story.dmg dist/mac/appcast.xml; }
fi
if wants ios; then
  step "Uploading the iPhone app"
  # With the API key, the upload doesn't depend on Xcode's own sign-in, which lapses.
  (
    if [ -f "$HOME/.appstoreconnect/story.env" ]; then
      set -a
      . "$HOME/.appstoreconnect/story.env"
      set +a
    fi
    swift/scripts/release-ios.sh "$version" "$build" --upload-only
  )
  if [ -f "$HOME/.appstoreconnect/story.env" ]; then
    step "Waiting for Apple, then adding the build to TestFlight"
    # In a subshell, so the key stays with the steps that use it.
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
npm_failed=
if [ -n "$npm_run" ]; then
  step "Waiting for the npm publish"
  gh run watch "$npm_run" --exit-status >/dev/null || npm_failed=1
fi
elapsed=$(( $(date +%s) - started ))
echo
printf 'Released %s in %d:%02d.\n' "$version" $((elapsed / 60)) $((elapsed % 60))
wants mac && echo "  Mac: https://github.com/jxe/arbor/releases/tag/$tag  (stable link: https://github.com/jxe/arbor/releases/latest/download/Story.dmg)"
if wants ios; then
  if [ "${testflight_failed:-}" = "1" ]; then echo "  iPhone: add build $build to its group in App Store Connect > TestFlight once it has processed."
  else echo "  iPhone: build $build is in its TestFlight group."; fi
fi
if [ -n "$npm_failed" ]; then
  echo "error: the npm publish failed; see gh run view $npm_run --log-failed, then rerun tools/release.sh $version --only npm" >&2
  exit 1
fi
wants npm && echo "  npm: a staged version appears once npm's review finishes; then npx @ovst/cli@$version --version"
exit 0
