# Contributing

This repository does not yet have an open-source license; licensing is
awaiting legal advice. Until it has one, external contributions cannot be
accepted. The notes below describe how the repository is worked on so that
reading it, and preparing for that day, is easier.

## Setup and verification

[DEVELOPMENT.md](DEVELOPMENT.md) covers setup (Bun 1.3.14, Swift 6 on macOS,
the optional Quagmire checkout) and the verification gates. The short form:

```sh
bun install
bun run typecheck
bun run test
bun run test:protocol
bun tools/check-links.ts
git diff --check
```

## Where things live and who owns what

- `spec.md` and `spec/` own portable behavior, including behavior the
  reference implementation has not built yet. Do not weaken a portable
  contract to match a staged UI.
- `status.md` owns current implementation status. Implemented, installed,
  deployed, and verified are separate claims.
- `docs/` owns usage and replaceable implementation choices. Implementation
  detail does not move into the specification.
- `plans/` owns remaining work only. A completed plan is deleted after its
  evidence lands in `status.md` or `docs/`; git history is the record.
- `conformance/` owns language-neutral vectors; `tests/fixtures/` owns
  reference-implementation fixtures.

The [README's repository map](README.md#repository-map) lists every directory.

## Change discipline

- A protocol change updates the TypeScript and Swift models, the conformance
  vectors, the reference documentation, and focused tests together.
- Keep TreeID, logical path, stable key, and tree-boundary scope explicit
  across client, host, and persistence layers.
- Preserve exact Markdown and source fidelity when an operation does not
  require normalization.
- Prefer a direct implementation and the existing vocabulary. Introduce an
  adapter or framework only when a second concrete implementation needs it.
- Commit the regenerated `canopy-swift/Canopy.xcodeproj` whenever
  `canopy-swift/project.yml` changes.

## Vocabulary

Overstory is the system and its protocol. canopyd is the reference host.
Canopy is the browser family (`canopy-swift/`, `packages/canopy-web/`).
Arbor names the local tools only: the `arbor` command, Arbor Sync, the
`arbor://` scheme, the `.arbor` data home, and `ARBOR_*` variables.
