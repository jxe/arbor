# Developing Overstory

This document describes how to work on the repository: setup, what each directory owns, change discipline, and the verification gates. There is no license yet, so it is not a contribution policy.

## Requirements and setup

The TypeScript workspace uses exactly Bun 1.4.2 (pinned in `.bun-version`, `package.json` `packageManager`, and `packages/overstoryd/deploy/Dockerfile.overstoryd`; change all three together), and the cross-language client tests require Swift 6 on macOS. Story for the web (`packages/story-web`) is out of the build and typecheck until Native 022 Plan B rebuilds it as a working-tree client; its browser tests return with it.

```sh
bun install
```

`bun install` exposes checkout-local scripts as `bun run story`, `bun run story-sync`, `bun run overstoryd`, and `bun run overstoryd-merge`. The merge executable runs as a separate Bun process; see [its API and object-store boundary](docs/architecture/overstoryd/merge-tool.md). `bun link` additionally exposes the `story`, `story-sync`, `overstoryd`, and `overstoryd-merge` executables in the shell; the README quickstart uses that form.

### Developing Overstory with Quagmire

Overstory's committed project metadata pins an exact released Quagmire version from
GitHub. That is the default for contributors who are not changing the editor. Do
not replace those committed dependencies with local paths.

Overstory and Quagmire are developed together, so committed Overstory code,
including code on main, may use Quagmire API that the pinned release does not
have yet. Building that code needs the local override below until the next
Quagmire release. Releasing Quagmire and moving both pins to that release is a
separate step from pushing to main.

To develop Overstory and Quagmire together, clone Quagmire beside this checkout
so the layout is as below. The Quagmire directory must be named exactly
`quagmire`: Xcode's package-identity override matches on that name.

```text
src/
├── arbor/
└── quagmire/
```

Create a local Xcode workspace named `swift/Story.local.xcworkspace`, add
`swift/Story.xcodeproj` and the sibling Quagmire package to it, and build the
`Canopy` scheme from that workspace. The workspace is ignored by Git. Xcode
treats the local package as an override for the remote dependency with the same
identity, so Overstory uses the Quagmire working tree while its published project
continues to point at the stable tag.

The Raycast `Swift Apps` extension recognizes this workspace automatically for
both macOS and physical-iPhone builds. It includes the local Quagmire checkout in
its build fingerprint, so an editor change invalidates a previously cached Overstory
build.

The standalone `StoryEditor` package has its own SwiftPM dependency state. Put
it in editable mode once if you run its tests directly:

```sh
cd swift/Packages/StoryEditor
swift package edit quagmire --path ../../../../quagmire
```

Run the local package tests through the repository wrapper:

```sh
swift/scripts/test-story-editor-local.sh
```

SwiftPM removes an editable dependency from `Package.resolved` whenever it runs.
The wrapper retains local editable resolution for the build, then restores the
tracked published lock exactly so local testing does not dirty the repository.

After a tested Quagmire revision is released, first leave the standalone
package's editable mode, update the exact version in both `swift/project.yml`
and `swift/Packages/StoryEditor/Package.swift`, regenerate the project and
standalone lock, then restore the local override:

```sh
swift package --package-path swift/Packages/StoryEditor unedit quagmire
xcodegen generate --spec swift/project.yml --project swift
swift package --package-path swift/Packages/StoryEditor resolve
swift package --package-path swift/Packages/StoryEditor edit quagmire \
  --path ../quagmire
```

Commit `swift/Packages/StoryEditor/Package.resolved` with the matching
Quagmire pin and generated project. Editable mode remains local SwiftPM state;
use the test wrapper above after restoring it so SwiftPM cannot leave the
lockfile dirty.
Keep the local Xcode workspace in place for ongoing coordinated development.

## What owns what

- `docs/overstory-spec/` owns portable behavior, including behavior the reference
  implementation has not built yet; `docs/overstory-spec/conformance/` holds the
  language-neutral vectors. Do not weaken a portable contract to match a
  staged UI, and do not move implementation detail into the specification.
- `status.md` owns current implementation status. Implemented, installed,
  deployed, and verified are separate claims.
- `docs/` is the documentation home. Outside `docs/overstory-spec/`, it owns usage and replaceable implementation choices.
- `plans/` owns remaining work only. A completed plan is deleted after its
  evidence lands in `status.md` or `docs/`; git history is the record.
  Numbers are stable identifiers within a plan directory, not an order.
  Each plan opens with why and when Joe wants it, repeated in
  `plans/README.md`, and carries no priority label. Small tasks and
  install, deploy and soak checks go in `plans/small-work.md`, not their own
  plan; unplanned candidates and open questions go in `plans/ideas.md`.
- `tests/fixtures/` owns reference-implementation fixtures, as opposed to
  the portable vectors under `docs/overstory-spec/conformance/`.
- The host's operating material lives with the host:
  `packages/overstoryd/deploy/` and `packages/overstoryd/migrations/`.

## Change discipline

- Read `git status`, the relevant source, and its tests before trusting
  prose or a plan's status label.
- A protocol change updates the TypeScript and Swift models, the
  conformance vectors, the reference documentation, and focused tests
  together.
- Keep TreeID, logical path, stable key, and tree-boundary scope explicit
  across client, host, and persistence layers.
- Preserve exact Markdown and source fidelity when an operation does not
  require normalization.
- Prefer a direct implementation and the existing vocabulary. Introduce an
  adapter or framework only when a second concrete implementation needs it.
- Preserve unrelated working-tree changes, and never rewrite completed
  historical evidence as if it were current planning.
- Commit the regenerated `swift/Story.xcodeproj` whenever
  `swift/project.yml` changes.

## Vocabulary

Overstory is the system and its protocol. overstoryd is the reference host.
Canopy is the browser family (`swift/`, `packages/story-web/`).
Story names the local tools only: the `story` command, Story Sync, the
`overstory://` scheme, the `.overstory` data home, and `STORY_*` variables.

## Repository map

The [README](README.md#repository-map) has the directory-by-directory map, and
[the reference implementation](docs/architecture/README.md) describes every
package in both languages, runtime ownership, and the layering rules.
Documentation ownership is summarized in [docs/README.md](docs/README.md).

## Verification

Use affected checks as the normal validation while developing a change:

Committing does not require a fresh test run. Reuse checks already run against
unchanged code; run them again when further edits or unresolved failures warrant
it. A request to commit is not a request to broaden verification. Report known
failures and respect Joe's explicit instruction to commit without more checks.

```sh
bun run test:affected
```

It reads the uncommitted changes (add `--base main` to include a branch's
commits, or name paths after `--` when the working tree holds unrelated
work), selects every product test whose import closure contains a changed
file, and adds the gates the change touches: typecheck for TypeScript, the
build for the CLI's closure, a migration's own suite, the performance
benchmark for its closure, and `check:links` for Markdown. `test:protocol`
runs for the wire models, the portable vectors, the reference fixtures, the
Swift packages it tests, and the Mac app's daemon client. A StoryEditor
change runs that package's full suite; any other app change runs the
`StoryAppTests` bundle through `swift/scripts/test-story-app.sh`. Quit a
running debug Canopy first, or the bundle cannot launch. A
changed data file selects the tests that name it. Root configuration, the
test preload, and any file no test names run the whole product suite.
`--list` prints the plan without running it. The closure follows imports and
literal `.ts` paths that tests spawn, not paths computed at runtime, so it is
a focused development check, not a substitute for release verification.

Also run `bun run test:protocol` when an Story Sync or overstoryd HTTP route or
response shape changes: its live scenarios drive those servers from the Swift
clients, which the import graph cannot see.

Run the full gate for periodic releases, before a live migration or install,
or when Joe explicitly requests it. Ordinary commits and plan closure do not
trigger it by themselves. Pushing `main` still deploys overstoryd and requires Joe's
explicit go-ahead:

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
bun run test:performance
bun run check:links
git diff --check
```

`bun run test` is the maintained parallel product suite and deliberately scopes
itself to `tests/unit` and `tests/integration`. Bare `bun test` uses the same
product boundary: `bunfig.toml` excludes all migration tests from default
discovery. Run the migration-specific suite during its rehearsal with
`bun run test:migration packages/overstoryd/migrations/NNN-<name>` as described in
[the migration procedure](packages/overstoryd/migrations/README.md).

`bun run test:protocol` checks the language-neutral fixtures, reference REST
fixtures, and disposable live Story Sync/overstoryd behavior against the Swift
clients, including operation grammar/digests, accepted-root bootstrap, and
independent working-tree durability. The Mac app's daemon client lives in
`swift/StoryApp/StorySync/`, so its suites (`StorySyncClientTests`,
`LoopbackServicesTests`) run in the app-hosted `StoryAppTests` bundle through
`xcodebuild`, which the protocol gate invokes on a Mac. Standalone `swift test`
checks decoding; live-server cases skip when their test URLs are absent. Postgres integration is opt-in:

```sh
OVERSTORYD_TEST_POSTGRES_DSN='postgresql://user:password@127.0.0.1:5432/postgres' \
  bun test tests/integration/postgres.test.ts
```

The Postgres test creates and drops a uniquely named `story_test_*` schema. It does not use an existing application schema.

## Disposable browser smoke test

Use fresh directories rather than the checked-in fixture or your real Overstory data home:

```sh
test_root="$(mktemp -d)"
test_state="$(mktemp -d)"
cp -R tests/fixtures/workspace/. "$test_root/"
STORY_HOME="$test_state" bun run story-sync "$test_root" --port 4317
```

Open `http://127.0.0.1:4317`. Check local navigation, extensionless Markdown URLs, child-link ordering, properties, exact-source edits, undo/redo, external file reconciliation, responsive navigation, and read-only collection rows. For remote presentation, open a public canonical URL through `story open` and directly in a regular browser; HTML and `Accept: text/markdown` should describe the same complete operational document without exposing private representation files.
