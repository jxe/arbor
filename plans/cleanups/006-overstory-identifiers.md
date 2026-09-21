# Cleanup 006: Rename code identifiers and UI copy to the Overstory vocabulary

Status: READY. Sole user; no compatibility shims.

The 2026-09-20 reorganization renamed packages, directories, fixtures, and
prose to the Overstory vocabulary (Overstory the system and protocol, canopyd
the host, Canopy the browsers, Arbor the local tools) but deliberately left
code identifiers and UI strings alone so that the rename could be verified
by the existing suites. This plan finishes the job.

## Scope

1. **TypeScript identifiers.** The seventeen `Wire*` names in `packages/`
   (`WireClient`, `WireTransportError`, `WireUnsupportedOperation`,
   `WireHTTPError`, `wireCollectionFile`, and the rest) and the `Canopy*`
   classes in `client` and `canopyd` that mean the host rather than the
   browser (`CanopyAccountStore`, `CanopyWatchRunner`, `CanopyObjectStore`).
   Pick one spelling per concept (`ProtocolClient`, `HostAccountStore`) and
   rename with the type checker as the guide.
2. **Swift identifiers.** The 81 `Wire*` names in `swift/Packages`
   (`ArborWireClient`, `ArborWireValidationError`, `WireModels`,
   `WireObjects`, and the rest), the `Arbor*` view and model types in
   `CanopyApp/`, and the `Arbor*` file names in `CanopyEditor`.
3. **UI copy.** "Make This an Arbor Tree", "This Arbor client is up to date",
   "Disconnect this browser from Arbor?", and the other user-visible strings
   that name the system; the app is Canopy and the trees are Overstory
   trees. Update the quoted strings in `docs/implementing-editors/design.md` and the tests that
   assert them in the same commit.
4. **`-v2` file names.** After [Cleanup 002](002-retire-v1-account-and-local-state-adapters.md)
   retires the v1 readers, rename `account-config-v2.ts`,
   `account-policy-v2.ts`, `account-v2.ts`, their tests, and the
   `./account-config-v2` export subpath to the plain names.
5. **`tests/fixtures/canopy/wire-merge.json`** and the `wire-format`
   marker file name inside the iOS working tree are on-disk names; leave the
   marker (it is installed data) and rename the fixture only.

## Verification

`bun run typecheck`, `bun run test`, `bun run test:protocol`, the Swift
package suites, and a macOS app build. No wire bytes change, so no host
deploy is needed; the app rename in step 3 is an ordinary app install.
