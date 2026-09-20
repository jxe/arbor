# Developing Overstory

This document describes how to work on the reference implementation. It is not a contribution or licensing policy.

## Requirements and setup

The TypeScript workspace uses exactly Bun 1.3.14 (a newer Bun canary crashed the parallel test suite; pinned in `.bun-version`, `package.json` `packageManager`, and `deploy/Dockerfile.canopyd`; change all three together), and the cross-language client tests require Swift 6 on macOS. Canopy for the web (`packages/canopy-web`) is out of the build and typecheck until Native 022 Plan B rebuilds it as a working-tree client; its browser tests return with it.

```sh
bun install
```

`bun install` exposes checkout-local scripts as `bun run arbor`, `bun run arborsync`, `bun run canopyd`, and `bun run arbor-merge`. The merge executable runs as a separate Bun process; see [its API and object-store boundary](docs/merge-tool.md). `bun link` additionally exposes the `arbor`, `arborsync`, `canopyd`, and `arbor-merge` executables in the shell; the README quickstart uses that form.

### Developing Overstory with Quagmire

Overstory's committed project metadata pins an exact released Quagmire version from
GitHub. That is the default for contributors who are not changing the editor. Do
not replace those committed dependencies with local paths.

To develop Overstory and Quagmire together, clone Quagmire beside this checkout
so the layout is as below. The Quagmire directory must be named exactly
`quagmire`: Xcode's package-identity override matches on that name.

```text
src/
├── arbor/
└── quagmire/
```

Create a local Xcode workspace named `canopy-swift/Canopy.local.xcworkspace`, add
`canopy-swift/Canopy.xcodeproj` and the sibling Quagmire package to it, and build the
`Canopy` scheme from that workspace. The workspace is ignored by Git. Xcode
treats the local package as an override for the remote dependency with the same
identity, so Overstory uses the Quagmire working tree while its published project
continues to point at the stable tag.

The Raycast `Swift Apps` extension recognizes this workspace automatically for
both macOS and physical-iPhone builds. It includes the local Quagmire checkout in
its build fingerprint, so an editor change invalidates a previously cached Overstory
build.

The standalone `CanopyEditor` package has its own SwiftPM dependency state. Put
it in editable mode once if you run its tests directly:

```sh
cd canopy-swift/Packages/CanopyEditor
swift package edit quagmire --path ../../../../quagmire
```

Run the local package tests through the repository wrapper:

```sh
tools/test-arbor-quagmire-local.sh
```

SwiftPM removes an editable dependency from `Package.resolved` whenever it runs.
The wrapper retains local editable resolution for the build, then restores the
tracked published lock exactly so local testing does not dirty the repository.

After a tested Quagmire revision is released, first leave the standalone
package's editable mode, update the exact version in both `canopy-swift/project.yml`
and `canopy-swift/Packages/CanopyEditor/Package.swift`, regenerate the project and
standalone lock, then restore the local override:

```sh
swift package --package-path canopy-swift/Packages/CanopyEditor unedit quagmire
xcodegen generate --spec canopy-swift/project.yml --project canopy-swift
swift package --package-path canopy-swift/Packages/CanopyEditor resolve
swift package --package-path canopy-swift/Packages/CanopyEditor edit quagmire \
  --path ../quagmire
```

Commit `canopy-swift/Packages/CanopyEditor/Package.resolved` with the matching
Quagmire pin and generated project. Editable mode remains local SwiftPM state;
use the test wrapper above after restoring it so SwiftPM cannot leave the
lockfile dirty.
Keep the local Xcode workspace in place for ongoing coordinated development.

## Repository map

The [README](README.md#repository-map) has the directory-by-directory map, and
[the reference implementation](docs/reference-implementation.md) describes every
package in both languages, runtime ownership, and the layering rules.
Documentation ownership is summarized in [docs/README.md](docs/README.md).

## Verification

Run the maintained automated gates from the repository root:

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
bun run test:performance
bun test tests/unit/canopyd-merge tests/integration/canopyd-merge
swift test --package-path canopy-swift/Packages/ArborSyncClient
git diff --check
```

`bun run test` is the maintained parallel product suite and deliberately scopes
itself to `tests/unit` and `tests/integration`. Bare `bun test` uses the same
product boundary: `bunfig.toml` excludes all migration tests from default
discovery. Run the migration-specific suite during its rehearsal with
`bun run test:migration migrations/NNN-<name>` as described in
[the migration procedure](migrations/README.md).

`bun run test:protocol` checks the language-neutral fixtures, reference REST
fixtures, and disposable live Arbor Sync/canopyd behavior against the Swift
clients, including operation grammar/digests, accepted-root bootstrap, and
independent working-tree durability. Standalone `swift test` checks decoding; live-server cases skip when
their test URLs are absent. Postgres integration is opt-in:

```sh
ARBOR_TEST_POSTGRES_DSN='postgresql://user:password@127.0.0.1:5432/postgres' \
  bun test tests/integration/postgres.test.ts
```

The Postgres test creates and drops a uniquely named `arbor_test_*` schema. It does not use an existing application schema.

## Disposable browser smoke test

Use fresh directories rather than the checked-in fixture or your real Overstory data home:

```sh
test_root="$(mktemp -d)"
test_state="$(mktemp -d)"
cp -R tests/fixtures/workspace/. "$test_root/"
ARBOR_DATA_HOME="$test_state" bun run arborsync "$test_root" --port 4317
```

Open `http://127.0.0.1:4317`. Check local navigation, extensionless Markdown URLs, child-link ordering, properties, exact-source edits, undo/redo, external file reconciliation, responsive navigation, recovery, and read-only collection rows. For remote presentation, open a public canonical URL through `arbor open` and directly in a regular browser; HTML and `Accept: text/markdown` should describe the same complete operational document without exposing private representation files.

