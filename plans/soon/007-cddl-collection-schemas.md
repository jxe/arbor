# Apps 007: Declarative CDDL collection schemas — remaining work

## Status

**P1 · IMPLEMENTED, NOT VERIFIED ON SWIFT, NOT CUT OVER.** The profile, vectors,
pure package, version-2 descriptors, host/merge/Arbor Sync switch, QuickJS
removal, retired-version-1 policy and the offline converter are implemented and
tested in TypeScript; the evidence is in [status.md](../../status.md#declarative-collection-schemas--2026-09-24)
and [the architecture](../../docs/architecture/collection-schema/README.md). The
contract is [child backings §2.4–2.5](../../docs/overstory-spec/06-child-backings.md#24-collection-schema-profile).
Nothing here authorizes live-data, installed-app or public-host changes. Read
[DEVELOPMENT.md](../../DEVELOPMENT.md) first.

## 1. Verify the Swift edits on macOS

The Swift changes were made without a Swift toolchain and have not compiled:

- `swift/Packages/Overstory/Sources/Overstory/ProtocolObjects.swift`:
  `ProtocolCollectionFileDescriptor.schemaSources`, default `version: 2`, and
  directory validation that pairs version 1 with `schema.ts` and version 2 with
  `schema.cddl`.
- `swift/Packages/Overstory/Tests/OverstoryTests/OverstoryTests.swift`: nine
  invalid object vectors.
- `swift/Packages/CanopyWorkingTree/Tests/CanopyWorkingTreeTests/UpdateCoordinatorTests.swift`:
  the descriptor round trip is parameterized over version 2 and retired
  version 1.

**Verify:** `swift test --package-path swift/Packages/Overstory`,
`swift test --package-path swift/Packages/CanopyWorkingTree`,
the moved `CanopyAppTests` Arbor Sync client suites, and
`bun run test:protocol` (which runs the Swift suites) → exit 0. Fix any
compile error in place without changing the contract.

## 2. Inventory, convert and cut over (separately authorized)

Follow [migration 021](../../packages/canopyd/migrations/021-cddl-collection-schemas/README.md):
an operator inventory with `--dry-run` over every placement and any host-only
tree, a hand-written `schema.cddl` or recorded decision for each blocked
collection, backups and idle placements, deployment of the new host, conversion,
the converted trees' ordinary updates, and the matching iPhone build.

**Verify:** the migration's runbook checks, every placement idle, each
converted collection page listing its rows, and `status.md` recording
installed and deployed separately. Then delete this plan and its index entries.
