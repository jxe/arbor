# Plan 001: Publish the final Quagmire 0.1.0 and prove remote consumption

> **Final status: DONE.** Quagmire commit `4049fd4` is tagged `0.1.0`, and Hunch commit `a1e8379` consumes that exact remote package. Preserve this file as completion evidence; do not execute it again.

> **Executor instructions**: Follow this plan in order. Use a disposable clone
> for history rewriting. Never run `git filter-repo` in the live Hunch checkout.
> Publish exactly the implemented Quagmire/Hunch foundation; do not redesign it
> during extraction. Update this plan's row in
> `plans/native/execution.md` when complete.
>
> **Drift checks (run first)**:
>
> ```sh
> git -C /Users/joe/src/hunch diff --stat ef37cc6..HEAD -- \
>   Packages/Quagmire project.yml Hunch.xcodeproj README.md CONTRIBUTING.md CLAUDE.md plans
> git -C /Users/joe/src/arbor diff --stat 05bcf35..HEAD -- \
>   native plan spec packages
> ```
>
> Stop if either foundation commit is unavailable. If the Quagmire package
> boundary, Hunch dependency graph, or existing extraction plan changed,
> compare the live code to this plan and stop on a material mismatch.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: implemented foundation recorded in `plans/records/history.md`
- **Category**: migration
- **Planned at**: Arbor `84fc705`, Hunch `4c35f37`, 2026-08-18
- **Reconciled**: 2026-08-19 after foundation completion

## Why this matters

The implemented foundation leaves Quagmire's intended first public API proven
locally in Hunch: one neutral document-link row, H1-H6 representation, raw
fallback, a specified stable-`BlockID` lifecycle, and the complete existing
Hunch interaction set. It is still embedded as a local subtree. Publishing that
finished, format-neutral boundary gives Hunch and TreeHopper one independently
versioned editor dependency while separating release/history failures from
TreeHopper integration. The tag is not safe until remote SwiftPM resolution and
bundled resources work in Hunch.

## Current state

- `/Users/joe/src/hunch/Packages/Quagmire/Package.swift:1-36` declares the
  `Quagmire` package/product/module, iOS/macOS 26, Swift 6, EmojiKit, sound and
  emoji resources, behavior tests, and a normal-import public API test.
- `/Users/joe/src/hunch/Packages/Quagmire/README.md:22-44` deliberately documents
  a local dependency because no repository or `0.1.0` exists yet.
- `/Users/joe/src/hunch/plans/editor-extraction-plan.md:738-800` already defines
  the history-preserving extraction, untagged remote test, tag-after-success,
  and exact-version Hunch adoption sequence. Follow it unless live evidence
  requires a correction.
- `/Users/joe/src/hunch/Packages/Quagmire/Tests/QuagmirePublicAPITests/PublicAPIConsumerTests.swift:5-26`
  proves that a minimal host implements only synchronous `persistCommit` and
  async `flush`.
- The behavior suite currently contains a timing-sensitive test at
  `DocumentUndoControllerTests.swift:28-67`: it sleeps 850 ms to observe a
  750 ms checkpoint. It failed once during this survey and passed in isolation.
  A nondeterministic test is not an acceptable release gate.
- Hunch consumes Quagmire by local path in
  `/Users/joe/src/hunch/project.yml:23-40`; the generated Xcode project is
  tracked output and must be regenerated, not hand-edited.
- The implemented foundation is a hard precondition. Before extraction, confirm
  Quagmire/Hunch contain one `documentLink`/`referenceID` row API, no `.subpage`
  compatibility model, exact H1-H6 representation, raw fallback, the complete
  identity-lifecycle tests, no Markdown/source-provenance API, and passing Hunch
  behavior gates. If not, stop rather than publishing the older boundary.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Package tests | `cd /Users/joe/src/hunch && swift test --package-path Packages/Quagmire` | all foundation package tests pass; no timing failure |
| Package release matrix | `cd /Users/joe/src/hunch && Packages/Quagmire/scripts/verify.sh` | tests and clean macOS/iOS Simulator package builds exit 0; resources load |
| Generate Hunch project | `cd /Users/joe/src/hunch && xcodegen generate --spec project.yml --project .` | exit 0; project reflects remote package |
| Hunch macOS tests | `xcodebuild test -project Hunch.xcodeproj -scheme Hunch -destination 'platform=macOS' -derivedDataPath /tmp/hunch-quagmire-release-macos-tests CODE_SIGNING_ALLOWED=NO` | exit 0 |
| Hunch macOS build | `xcodebuild build -project Hunch.xcodeproj -scheme Hunch -destination 'platform=macOS' -derivedDataPath /tmp/hunch-quagmire-release-macos-build CODE_SIGNING_ALLOWED=NO` | exit 0 |
| Hunch iOS build | `xcodebuild build -project Hunch.xcodeproj -scheme Hunch -destination 'platform=iOS Simulator,id=C76DE979-27D7-4BE5-AD11-3FC223402AB9' -derivedDataPath /tmp/hunch-quagmire-release-ios CODE_SIGNING_ALLOWED=NO` | exit 0 on the existing iOS 27 simulator |
| Diff check | `git -C /Users/joe/src/hunch diff --check` | no output |

Run Xcode commands sequentially. Do not launch an installed Hunch and mistake it
for the built artifact.

## Scope

**In scope**:

- The timing-sensitive Quagmire test and directly related test helper.
- Quagmire release docs/scripts at the extracted repository root.
- A new standalone `quagmire` GitHub repository created from a disposable clone.
- Hunch's package declaration, generated project, and dependency docs.

**Out of scope**:

- Any public Quagmire model/host redesign beyond the implemented foundation.
- Arbor source, protocol, or client changes; those are already implemented.
- A demo app, CI workflow, package split, plugin system, or compatible-version
  requirement.
- Changes to Hunch recovery hashes, Markdown, `.history`, app bundle ID, or UI.
- Any history rewrite in `/Users/joe/src/hunch`.

## Git workflow

- Use focused branches. Keep the Hunch release-preparation commit separate from
  the dependency switch commit.
- Match the repository's imperative message style, e.g.
  `Complete Quagmire extraction milestone 6`.
- Push/tag only the new Quagmire repository as required by this plan. Do not
  push unrelated Hunch or Arbor work.

## Steps

### Step 1: Stabilize and freeze the local release gate

Replace the fixed-delay checkpoint test with a deterministic eventual
expectation/continuation bounded by a generous timeout. Retain a direct test of
the configured checkpoint duration so the behavioral constant is still covered.
Correct the README statement that suggestions run “on every render”; the
implementation snapshots suggestions once per completion-trigger change.

Run the package test suite twice from a clean package state. Both consecutive
runs must pass before continuing.

Before the first run, execute the stale-row and forbidden-source-API searches
from the implemented foundation and confirm the single `documentLink` API, H1-H6/raw tests, and
complete `BlockID` lifecycle tests are present. This is a release precondition,
not an invitation to redesign them here.

**Verify**:

```sh
cd /Users/joe/src/hunch
swift test --package-path Packages/Quagmire
swift test --package-path Packages/Quagmire
Packages/Quagmire/scripts/verify.sh
```

Expected: every command exits 0; the checkpoint test is green both times; the
public API and resource tests pass.

### Step 2: Extract history in a disposable clone

Create a temporary directory with `mktemp -d`, clone Hunch into it, and run:

```sh
git filter-repo --path Packages/Quagmire/ --path-rename Packages/Quagmire/:
```

Confirm the root contains `Package.swift`, `Sources`, `Tests`, `README.md`,
`ARCHITECTURE.md`, `CONTRIBUTING.md`, `LICENSE`, and `scripts/verify.sh`.
Confirm `git log --follow` for representative source files includes meaningful
pre-extraction history. Remove only subtree-era paths in docs/scripts; do not
squash into a source-only import.

**Verify**: run `scripts/verify.sh` from the extracted repository root. Expected:
exit 0 with no reference to `/Users/joe/src/hunch` or `Packages/Quagmire`.

### Step 3: Push an untagged commit and test it as a remote dependency

Create the standalone repository, push the tested default branch, but do not tag
it. In a Hunch branch, replace the local package path with the remote URL pinned
to that exact commit revision. Regenerate the project. Remove the local subtree
only after SwiftPM resolves the remote dependency and both platform builds pass.

Check that Hunch and its app-hosted test target link exactly one Quagmire product
and that sounds/emoji resources resolve from `Bundle.module`.

**Verify**: project generation, macOS tests, macOS build, and iOS 27 build from
the command table all exit 0 after a clean SwiftPM resolution.

### Step 4: Tag 0.1.0 and adopt the exact version

Tag the exact remote commit that passed Step 3 as `0.1.0`. Change Hunch from the
revision pin to an exact `0.1.0` dependency, resolve from clean state, regenerate,
and rerun the package and Hunch gates. Update installation docs only now that
the real URL and tag exist.

Keep exact `0.x` requirements while the public surface is settling.

**Verify**:

```sh
rg -n 'path: Packages/Quagmire|revision:' /Users/joe/src/hunch/project.yml
test ! -d /Users/joe/src/hunch/Packages/Quagmire
```

Expected: `rg` returns no matches; the local subtree is absent; the resolved
dependency is exactly `0.1.0`; the full command table passes.

## Test plan

- Make the checkpoint regression deterministic in the existing undo-controller
  suite; do not lower the test's semantic expectation.
- Preserve the normal-import public consumer test.
- Preserve resource smoke tests for every bundled sound/resource family.
- Run Hunch integration tests because a package-only success cannot detect
  duplicate linking, missing resources, or generated-project mistakes.

## Done criteria

- [ ] Two consecutive Quagmire package test runs and `scripts/verify.sh` pass.
- [ ] The new repository retains meaningful file history.
- [ ] Hunch resolves Quagmire from the tagged remote at exact `0.1.0`.
- [ ] No local `Packages/Quagmire` remains in Hunch.
- [ ] Hunch macOS tests and sequential macOS/iOS 27 builds pass remotely.
- [ ] Package resources load through the remote dependency.
- [ ] Public installation docs name only the real URL/tag.
- [ ] The tag contains exactly the implemented one-row, H1-H6/raw, stable-identity,
      format-neutral public boundary; no extraction-time redesign entered
      `0.1.0`.
- [ ] `plans/native/execution.md` marks Plan 001 DONE.

## STOP conditions

- Extraction loses meaningful history.
- Either foundation commit is unavailable, or the local
  package still exposes `.subpage` alongside `documentLink`.
- The package passes only through a local override or links twice in Hunch.
- A resource is available locally but missing through remote SwiftPM.
- Fixing a release failure appears to require changing Hunch data formats,
  recovery hashes, or editor behavior.
- A new material naming/trademark collision appears.

## Maintenance notes

`0.1.0` deliberately captures the implemented pre-integration foundation,
not the older Hunch-specific subpage API. TreeHopper is the second host in Plan
003. The one-row API, H1-H6 representation, raw fallback, and stable identity
lifecycle are already public in 0.1; source provenance remains host-private.
Integration must not revive a second row type or three-way mention API.
