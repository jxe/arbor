# Working in Overstory

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

Use the smallest focused tests while developing, then run the relevant gates from `DEVELOPMENT.md`. At minimum, documentation-only changes require a repository-wide relative-link check (`bun tools/check-links.ts`) and `git diff --check`; path moves also require every affected build or fixture test.

## Quagmire development

The pinning rules, the local workspace override, the editable-mode test
wrapper, and the release sequence are in
[DEVELOPMENT.md](DEVELOPMENT.md#developing-overstory-with-quagmire). The
short version: both pins (`canopy-swift/project.yml` and
`canopy-swift/Packages/CanopyEditor/Package.swift`) name the same exact
release; never commit a local path; run standalone `CanopyEditor` tests only
through `tools/test-arbor-quagmire-local.sh`; never `swift build` that
package standalone while it is in editable mode.

## Vocabulary

Overstory is the system and the protocol; canopyd is the reference host;
Canopy is the browser family; Arbor names only the local tools (`arbor`,
Arbor Sync, `arbor://`, `.arbor`, `ARBOR_*`).
