# Working in Arbor

These instructions apply to the whole repository.

## Sources of truth

- Read `git status`, the relevant source, and its tests before trusting prose or plan status.
- `status.md` owns current implementation status. `spec.md` and `spec/` own portable behavior, including behavior the reference implementation has not built yet.
- `docs/` records usage, replaceable implementation choices, and client design. Do not move implementation details into the portable specification.
- `plans/` contains only remaining work. Move completed executor plans to `plans/_done/` and preserve their identifiers and verification evidence.
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
