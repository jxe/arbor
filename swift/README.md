# swift

The Swift side of Overstory: the protocol and client packages that mirror
the TypeScript workspace, and the Canopy app for macOS and iOS.

| Package | Purpose | TypeScript twin | Depends on |
|---|---|---|---|
| [`Overstory`](Packages/Overstory/README.md) | Protocol models, canonical CBOR, SSE, the HTTP client, contracts, operations, resource policy | `protocol` | |
| [`OverstoryObjectStore`](Packages/OverstoryObjectStore/README.md) | Object stores: overlay, layered, directory, host-backed | `object-store` | Overstory |
| [`CanopyAppKit`](Packages/CanopyAppKit/README.md) | Workspace models and coordinator, the editor source, logical URLs and titles, the browser tab controller | | |
| [`CanopyWorkingTree`](Packages/CanopyWorkingTree/README.md) | The durable working tree, update machine and coordinator, admission queue, entry actions, conflict review | `client` | CanopyAppKit, OverstoryObjectStore, Overstory |
| [`OverstoryClient`](Packages/OverstoryClient/README.md) | Credentials, placement service, watch runner, account YAML, resource consent | `client` | CanopyAppKit, CanopyWorkingTree, OverstoryObjectStore, Overstory, Yams |
| [`CanopyEditor`](Packages/CanopyEditor/README.md) | The Quagmire editor host, document binding, Markdown codec | | CanopyAppKit, Quagmire |

`CanopyApp/` is the app target (SwiftUI, the arborsync helper service, the
launchd plist, entitlements) and `CanopyAppTests/` its test bundle.
`CanopyApp/ArborSync/` is the Mac's client of the daemon (the loopback REST
client, credential provider and object store, the process supervisor, and
their models), compiled only for macOS; its twin is the CLI's
`packages/cli/src/daemon-client.ts`. The packages above are platform-neutral. The app
is named Canopy; its bundle identifier stays `org.nxhx.Arbor`, as do the
launchd label and the support directory, so installed data is found.

## The Xcode project is generated

`Canopy.xcodeproj` is generated from `project.yml` by xcodegen and committed.
After editing `project.yml`, regenerate and commit the result:

```sh
xcodegen generate --spec swift/project.yml --project swift
```

Do not edit `project.pbxproj` by hand. The app's pre-build script bundles
`packages/arborsync/src/cli.ts` with Bun and copies `@parcel/watcher` from
`packages/fs/node_modules`, so `bun install` must have run.

## Tests

Each package has its own `Tests/` directory and runs with
`swift test --package-path swift/Packages/<Name>`. The cross-language
gate, `bun run test:protocol`, runs several of them against the shared
conformance vectors and disposable live services. `scripts/hosted-smoke.ts`
starts a local host, claims an account into the app's disposable data home,
and runs `CanopyAppTests` through xcodebuild.

`CanopyEditor` depends on a pinned Quagmire release. Never run
`swift build` on it standalone while it is in editable mode; use
`swift/scripts/test-canopy-editor-local.sh` and see [DEVELOPMENT.md](../DEVELOPMENT.md#developing-overstory-with-quagmire).

## Naming

Package names before 2026-09-20: `ArborWire` (now `Overstory`),
`ArborObjectStore` (`OverstoryObjectStore`), `CanopyClient`
(`OverstoryClient`), `ArborWorkingTree` (`CanopyWorkingTree`), `ArborKit`
(`CanopyAppKit`), `ArborQuagmire` (`CanopyEditor`). Type names followed on
2026-09-24: `Wire*` and `ArborWire*` protocol types became `Protocol*`
(`ArborWireClient` is `ProtocolClient`, `WireModels.swift` is
`ProtocolModels.swift`), host-meaning `Canopy*` types became `Host*`
(`HostObjectStore`, `HostWatchRunner`), and the app's and editor's `Arbor*`
types and files became `Canopy*`. `Arbor*` names that remain belong to the
local tools: Arbor Sync, `arbor://` locators, and the `.arbor` data home.
