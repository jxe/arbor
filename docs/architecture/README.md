# Overstory reference implementation

This document records the architecture and operating choices of the current
reference implementation. It is informative; the normative contracts live in
[docs/overstory-spec/README.md](../overstory-spec/README.md), and [status.md](../../status.md) says which of the
behavior below is installed or deployed.

## By subcomponent

- [Protocol and object stores](protocol/README.md): encoding, identity, transport, conflict inspection, and resource policy.
- [Host: overstoryd](overstoryd/README.md): acceptance, durability, merge and execution sidecars.
- [Client stack](client-stack/README.md): working-tree synchronization, exact retries, and conflict recovery.
- [Story Sync and local tools](story-sync/README.md): daemon ownership, placed folders, private state, and CLI.
- [Story apps](story-browser/README.md): editor runtime ownership, local state, and recovery.
- [Executable-document runtime](apps-runtime/README.md): queries and mutations.
- [Collection schemas](collection-schema/README.md): the declarative `schema.cddl` parser, validator, and collection-file codec.

## Components

Five components, two languages. Every TypeScript package lives under
`packages/<name>` and is published as `@ovst/<name>`; every Swift
package lives under `swift/Packages/<Name>`.

| Component | TypeScript | Swift | Owns |
|---|---|---|---|
| Overstory protocol | `protocol`, `object-store` | `Overstory`, `OverstoryObjectStore` | The specification in code: identifiers, node model, canonical CBOR, hashing, objects and snapshots, update contracts, resource policy, the document format, configuration formats, HTTP and SSE transport; the content-addressed object store |
| Host | `overstoryd`, `overstoryd-merge`, `merge-protocol`, `tree-merge`, `collection-schema`, `apps-runtime` | | Communities, accounts, hosted trees, acceptance, public pages; the merge sidecar, its JSON contract and the snapshot tree merge; declarative collection schemas; the executable-document runtime |
| Client stack | `client`, `fs` | `OverstoryClient`, `OverstoryWorkingTree` | Synchronizing a working tree against a host: update machine, admission queue, account bootstrap, filesystem materialization |
| Story Sync and CLI | `story-sync`, `cli` | the `Story` app target's `StorySync/` (macOS) | The per-user daemon, its loopback REST API and clients, the `story` command |
| Story apps | `story-web` | `StoryKit`, `StoryEditor`, the `Story` app target | The human interface |

Layering: `protocol` depends on nothing in the workspace; `apps-runtime`
and `collection-schema` depend only on `protocol`, and `tree-merge` only on
`protocol` and `collection-schema`; `overstoryd`
and `overstoryd-merge` share only `object-store` and `merge-protocol`, and
neither imports the other (only the sidecar and Story Sync recovery use
`tree-merge`); the host
and client packages never depend on `story-sync*`; `cli` and `story-web` may
depend on anything. Swift mirrors
this: `Overstory` is a leaf, `OverstoryObjectStore` depends on it,
`OverstoryWorkingTree` on both plus `StoryKit`, and `OverstoryClient` and
`StoryEditor` sit above. Each daemon client lives with its only caller: the
TypeScript one in `packages/cli/src/daemon-client.ts`, the Swift one (REST
client, loopback credential provider and object store, process supervisor,
models) in `swift/StoryApp/StorySync/`, compiled for macOS only. The app's
account operations go through one protocol, `HostAccountService`
(`swift/StoryApp/HostAccountService.swift`), with two implementations:
iOS keeps accounts in `OverstoryClient`'s Keychain stores, and the Mac keeps
them in the data home through the daemon's onboarding routes, so the daemon
and the CLI share them ([local state](story-browser/local-state.md)).

### TypeScript packages

| Package | Purpose | Depends on |
|---|---|---|
| `protocol` | `model/` (types, identifiers, CBOR, hashing, logical paths and URLs, resource policy, errors, SSE), `objects.ts` and `snapshots.ts`, `updates/` (request and accepted contracts, JSON, intent digests, deltas), `transport.ts` (the HTTP client), `documents/` (Markdown and directory documents, child links, titles, document merge), `config/` (account, device, placement, resource configuration and the private data home) | `@noble/hashes`, `yaml` |
| `object-store` | Immutable hash-sharded storage with verified reads, durable writes, and reachability walks | protocol |
| `fs` | `WorkspaceFS`: logical-node reads, discovery and watching; `materializeTree` ([README](../../packages/fs/README.md)) | protocol, `@parcel/watcher` |
| `client` | Account bootstrap, pairing and wire, device keys, and the data home they share with the daemon: the profile identity, `placements.yaml`, and the setup lock; it never imports `story-sync` | protocol, fs |
| `overstoryd` | Access and claims, accounts and profiles, boundaries, the public page, resource effects and execution authority, schema and the SQLite authority, `updates/` (decision, reconcile, graph validation, stores, observations, watch frames, source edits), the merge sidecar adapter and log entries, account-configuration merging, projection, the `overstoryd` CLI ([README](../../packages/overstoryd/README.md)) | protocol, object-store, collection-schema, apps-runtime, merge-protocol |
| `overstoryd-merge` | The merge sidecar: the question loop and its in-memory cache replayed from log entries, snapshot choices, intent engine and model, format rules, Markdown and web formats, retained states in memory, log decisions and checkpoints, the `overstoryd-merge` CLI ([merge sidecar](overstoryd/merge-tool.md)) | protocol, object-store, merge-protocol, tree-merge, tree-sitter, saxes |
| `merge-protocol` | The contract between overstoryd and a merge sidecar: log entries, the merge question and answer, refusal codes; no merge logic ([writing a sidecar](overstoryd/writing-a-sidecar.md)) ([README](../../packages/merge-protocol/README.md)) | protocol, zod |
| `tree-merge` | The three-way snapshot tree merge with its Markdown and collection-file rules and model hashes ([README](../../packages/tree-merge/README.md)) | protocol, collection-schema |
| `collection-schema` | The Overstory CDDL collection profile: parser, profile checks, validator, CSV cell conversion, generated declarations, logical names, the bounded schema cache, and the collection-file codec; pure, with no code execution, filesystem, or network ([README](collection-schema/README.md)) | protocol, `csv-parse` |
| `apps-runtime` | Query core and node queries, the SQLite engine, live streams and observers, mutations, authoring API, host integration, and `collections/` (the projection-provider contract types) ([README](../../packages/apps-runtime/README.md)) | protocol |
| `story-sync` | The daemon: workspace and editor, tree manager, sync and account HTTP, browser routes, filesystem object source and node surfaces, events, and `state/` (tree registry and placement sync metadata, connections, local accounts, providers, object index); `recovery/`, the separate tree-recovery tool, which merges candidates with `tree-merge` | protocol, client, fs, apps-runtime, collection-schema, tree-merge |
| `cli` | `story`: daemon supervision, identity, placement, moves, cloud sessions; `daemon-client.ts` is its `StorySyncRESTClient` for the daemon's loopback surface | story-sync, protocol, fs |
| `story-web` | The browser editor (React, BlockNote, Vite); out of the build and typecheck until [Web 025](../../plans/story-web/025-story-web.md) rebuilds it as a working-tree client; its stale imports of the deleted `@ovst/story-sync-client` are Web 025's to replace | protocol |

### Swift packages

| Package | Purpose | Depends on |
|---|---|---|
| `Overstory` | Protocol models, canonical CBOR, the SSE parser, the HTTP client, authored and accepted contracts, operations, transitions, resource policy, the network log | |
| `OverstoryObjectStore` | The `ObjectStore` protocol with overlay, directory, and host-backed stores; every store verifies bytes against their hash | Overstory |
| `StoryKit` | Workspace models and provider protocol, the workspace coordinator, logical URLs and display titles, the editor source, the browser tab controller | |
| `OverstoryWorkingTree` | `WorkingTree` and its state store, `UpdateMachine` and `UpdateCoordinator`, durability, the snapshot bridge, `SourceAdmissionQueue`, entry actions and transfer, conflict review | StoryKit, OverstoryObjectStore, Overstory |
| `OverstoryClient` | Credentials, the placement service, `HostWatchRunner`, tree configuration YAML, resource consent | StoryKit, OverstoryWorkingTree, OverstoryObjectStore, Overstory, Yams |
| `StoryEditor` | The Quagmire editor host and surface, document binding, the Markdown codec | StoryKit, Quagmire |

`swift/Story.xcodeproj` is generated from `swift/project.yml`
by xcodegen and committed; see [swift/README.md](../../swift/README.md).

## Verification machinery

Bun tests, TypeScript checking, shared JSON and SSE fixtures, and Swift
Package Manager tests. The usual gates are in [DEVELOPMENT.md](../../DEVELOPMENT.md).
Diagnostics that are not gates: `FILES=1000 bun tests/performance/snapshot-acceptance-cost.ts`
(acceptance latency and per-phase timings through a disposable host) and
`bun tests/performance/benchmark-merge-tool.ts` (the engine alone, in memory) and
`bun tests/performance/benchmark-merge-replay.ts` (an in-process sidecar: one checkpoint
with K conflicting files, and cold replay of chains with concurrent work; it prints a
digest of every answer, which an engine change that must not change answers keeps). Language-neutral vectors under
[`docs/overstory-spec/conformance/`](../overstory-spec/conformance/README.md) are the portable part; reference
API and algorithm fixtures live under [`tests/fixtures/`](../../tests/fixtures/README.md).
