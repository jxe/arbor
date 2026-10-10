# swift

The Swift side of Overstory: the protocol and client packages that mirror
the TypeScript workspace, and the Story app for macOS and iOS.

| Package | Purpose | TypeScript twin | Depends on |
|---|---|---|---|
| [`Overstory`](Packages/Overstory/README.md) | Protocol models, canonical CBOR, SSE, the HTTP client, contracts, operations, resource policy | `protocol` | |
| [`OverstoryObjectStore`](Packages/OverstoryObjectStore/README.md) | Object stores: overlay, directory, host-backed | `object-store` | Overstory |
| [`StoryKit`](Packages/StoryKit/README.md) | Workspace models and coordinator, the editor source, logical URLs and titles, the browser tab controller | | |
| [`OverstoryWorkingTree`](Packages/OverstoryWorkingTree/README.md) | The durable working tree, update machine and coordinator, admission queue, entry actions, conflict review | `client` | StoryKit, OverstoryObjectStore, Overstory |
| [`OverstoryClient`](Packages/OverstoryClient/README.md) | Credentials, placement service, watch runner, account YAML, resource consent | `client` | StoryKit, OverstoryWorkingTree, OverstoryObjectStore, Overstory, Yams |
| [`StoryEditor`](Packages/StoryEditor/README.md) | The Quagmire editor host, document binding, Markdown codec | | StoryKit, Quagmire |

`StoryApp/` is the app target (SwiftUI, the story-sync helper service, the
launchd plist, entitlements) and `StoryAppTests/` its test bundle.
`StoryApp/StorySync/` is the Mac's client of the daemon (the loopback REST
client, credential provider and object store, the process supervisor, and
their models), compiled only for macOS; its twin is the CLI's
`packages/cli/src/daemon-client.ts`. The packages above are platform-neutral. The app
is named Story. Its bundle identifier stays `org.nxhx.Arbor` for now, as do
the keychain service names, so installed data and pairing are found; the
launchd label is `org.nxhx.story.sync` and the support directory is
`~/Library/Application Support/Story`.

## The Xcode project is generated

`Story.xcodeproj` is generated from `project.yml` by xcodegen and committed.
After editing `project.yml`, regenerate and commit the result:

```sh
xcodegen generate --spec swift/project.yml --project swift
```

Do not edit `project.pbxproj` by hand. The app's pre-build script bundles
`packages/story-sync/src/cli.ts` with Bun and copies `@parcel/watcher` from
`packages/fs/node_modules`, so `bun install` must have run.

## Tests

Each package has its own `Tests/` directory and runs with
`swift test --package-path swift/Packages/<Name>`. The cross-language
gate, `bun run test:protocol`, runs several of them against the shared
conformance vectors and disposable live services. `scripts/hosted-smoke.ts`
starts a local host, claims an account into the app's disposable data home,
and runs `StoryAppTests` through xcodebuild.

`StoryEditor` depends on a pinned Quagmire release. Never run
`swift build` on it standalone while it is in editable mode; use
`swift/scripts/test-story-editor-local.sh` and see [DEVELOPMENT.md](../DEVELOPMENT.md#developing-overstory-with-quagmire).

## Naming

Package names before 2026-09-20: `ArborWire` (now `Overstory`),
`ArborObjectStore` (`OverstoryObjectStore`), `CanopyClient`
(`OverstoryClient`), `ArborWorkingTree` (`OverstoryWorkingTree`), `ArborKit`
(`StoryKit`), `ArborQuagmire` (`StoryEditor`). Type names followed on
2026-09-24: `Wire*` and `ArborWire*` protocol types became `Protocol*`
(`ArborWireClient` is `ProtocolClient`, `WireModels.swift` is
`ProtocolModels.swift`), host-meaning `Canopy*` types became `Host*`
(`HostObjectStore`, `HostWatchRunner`), and the app's and editor's `Arbor*`
types and files became `Canopy*`.

Until 2026-10-10 the app, its Xcode project and its scheme were named
Canopy, and three packages carried that name: `CanopyAppKit` (now
`StoryKit`), `CanopyEditor` (`StoryEditor`) and `CanopyWorkingTree`
(`OverstoryWorkingTree`). `Canopy*` types became `Story*`, account types
that describe an account on a host became `HostAccount*`, and
protocol-meaning `Arbor*` names became `Overstory*` (`OverstoryLocator`).
`Story*` names belong to the device product: the app, the `story` command and
Story Sync. `Overstory*` names belong to the protocol and its generic client
machinery.
