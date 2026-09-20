# Working in Arbor

These instructions apply to the whole repository.

## Sources of truth

- Read `git status`, the relevant source, and its tests before trusting prose or plan status.
- `status.md` owns current implementation status. `spec.md` and `spec/` own portable behavior, including behavior the reference implementation has not built yet.
- `docs/` records usage, replaceable implementation choices, and client design. Do not move implementation details into the portable specification.
- `plans/` contains only remaining work. Delete completed or superseded executor plans; git history is the record. Put lasting verification evidence in `status.md` or `docs/` before deleting.
- Numbers are stable identifiers within a plan directory, not an implicit execution order; indexes own priority and dependencies.

## Change discipline

- Preserve exact Markdown/source fidelity when an operation does not require normalization.
- Keep TreeID, logical path, stable-key, and tree-boundary scope explicit across client, server, and persistence layers.
- Protocol changes must update the TypeScript and Swift models, language-neutral conformance fixtures, reference API documentation, and focused tests together.
- Do not weaken an aspirational portable contract merely to match a staged reference UI.
- Prefer a direct implementation and existing vocabulary. Introduce a general adapter or framework only when a second concrete implementation requires it.
- Preserve unrelated working-tree changes. Do not rewrite completed historical evidence as if it were current planning.

## Verification

Use the smallest focused tests while developing, then run the relevant gates from `DEVELOPMENT.md`. At minimum, documentation-only changes require a repository-wide relative-link check and `git diff --check`; path moves also require every affected build or fixture test.

## Quagmire development

- Keep the committed Quagmire dependencies in `canopy-swift/project.yml` and
  `canopy-swift/Packages/CanopyEditor/Package.swift` pinned to the same exact GitHub
  release. Never commit a local path in either source of truth.
- Local Canopy app development uses the ignored
  `canopy-swift/Canopy.local.xcworkspace`, which contains `Canopy.xcodeproj` and the
  sibling `../../quagmire` checkout. Open and build that workspace so Xcode's
  local package overrides the released dependency without changing published
  project metadata.
- Standalone `CanopyEditor` package tests have separate SwiftPM state. Put that
  package in editable mode with
  `swift package --package-path canopy-swift/Packages/CanopyEditor edit quagmire --path ../quagmire`,
  then run its tests through `tools/test-arbor-quagmire-local.sh`. Raw SwiftPM
  test commands rewrite the tracked lockfile while the dependency is editable;
  the wrapper preserves the published resolution around the local test.
- Before changing the exact Quagmire release, take that standalone package out
  of editable mode, resolve the new release so its tracked `Package.resolved`
  records the same version, then restore editable mode. Do not commit a lockfile
  with the edited Quagmire dependency omitted.
- Test coordinated changes locally before releasing Quagmire. Once the tested
  revision is tagged, update both exact Arbor pins, regenerate
  `canopy-swift/Canopy.xcodeproj` from `canopy-swift/project.yml`, and commit that dependency
  bump separately. A second remote-package build is not part of this workflow.
