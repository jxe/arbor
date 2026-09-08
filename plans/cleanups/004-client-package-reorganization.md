# Cleanup 004 — Carve the four thick client packages

- **State:** CARVED; awaiting macOS verification
- **Priority:** P1; precedes Reliability 005
- **Depends on:** nothing; Reliability 005 and 006 depend on the resulting
  package layout

## Outcome

Rename and re-carve the TypeScript and Swift code so that each of the two
client roles in [Reliability 005](../reliability/005-client-synchronization-state-machines.md)
has one package per language, and each package is thick enough to host that
role's state machine:

| Package | Talks to | Will host |
|---|---|---|
| `@arbor/arborsync-client` (`packages/arborsync-client`) | Local Arbor REST | machine A (document admission), the scoped browser API, configuration actions |
| `@arbor/canopy-client` (`packages/canopy-client`) | Arbor Wire | machine B (direct Canopy synchronization), durable pending state, account claims |
| `ArborSyncClient` (`native/Packages/ArborSyncClient`) | Local Arbor REST | the Arbor Sync workspace provider and document session, daemon supervision |
| `CanopyClient` (`native/Packages/CanopyClient`) | Arbor Wire | machine B, `ReplicaSyncCoordinator`, durable sync control, credentials and account service |

The stateless transports stay separate beneath them: `@arbor/wire` and
`ArborWire` for Canopy; the REST wrapper is a file inside each Arbor Sync
client package because it is small. Durable stores stay separate dependencies:
`@arbor/fs`, `@arbor/stores`, and `ArborReplica`.

The daemon (`@arbor/arborsync`) imports `@arbor/canopy-client` as a library. It
does not become the package.

## Decisions

- **Machine A's Swift home is `ArborKit`, not `ArborSyncClient`.**
  `ArborDocumentBinding` drives a `WorkspaceDocumentSession`, which on iOS is
  `ReplicaDocumentSession`. The admission reducer is therefore
  provider-agnostic on Swift and lives next to that protocol. `ArborSyncClient`
  supplies only the session adapter. In TypeScript the web editor only ever
  talks to Arbor Sync, so the reducer lives in `@arbor/arborsync-client`.
- **Account and credential code rides inside the Canopy client packages.**
  `account-bootstrap.ts`, `Credentials.swift`, and
  `AccountConfigurationYAML.swift` talk to Canopy and are not synchronization,
  but they do not justify a fifth package.
- **The thick client takes its store as a dependency.** `TreeSynchronizer`
  receives materialization, placement registry, and event-sink ports from the
  daemon instead of importing `Workspace`, `TreeManager`, `EventBus`, and
  `materializeTree` directly. `sync-state.ts` keeps its own per-tree file
  serialization because Reliability 005 requires that to stay where it is.
- **`ProtocolError` moves to `@arbor/core`.** The Canopy client raises one
  protocol conflict, and the daemon's REST layer maps `ProtocolError` to a
  status. A shared error type is smaller than an injected error factory.
- **`LogicalURL.swift` and `JSONValue` move to `ArborKit`.** They are the only
  reason `ArborKit`, `ArborReplica`, and `ArborQuagmire` import `ArborClient`.
  Moving them breaks the cycle that would otherwise stop `ArborSyncClient`
  from implementing `ArborKit`'s `WorkspaceProvider`.

## Work

1. TypeScript: rename `@arbor/client` to `@arbor/arborsync-client`; move
   `render/src/api.ts` and `render/src/configuration.ts` into it.
   `editor-coordinator.ts` stays in `render`; Reliability 005 extracts its
   reducer into the client package.
2. TypeScript: create `@arbor/canopy-client` from `tree-sync.ts`,
   `sync-state.ts`, `editor-admission.ts`, and `account-bootstrap.ts`, with
   the daemon-facing ports named above. Move `ProtocolError` to `@arbor/core`.
3. Swift: move `LogicalURL.swift` and `JSONValue` into `ArborKit`; rename
   `ArborClient` to `ArborSyncClient` and fold `ArborSyncWorkspaceProvider`
   and `ArborSyncProcessSupervisor` into it; move
   `SecurityScopedWorkspaceBookmarkStore` to `ArborKit`; delete
   `ArborProviders`.
4. Swift: rename `ArborSync` to `CanopyClient`.
5. Update `native/project.yml`, the Xcode project, `tests/protocol/conformance.ts`,
   `DEVELOPMENT.md`, `docs/`, and every active plan that names the old paths
   (Reliability 004, 005, 006; Cleanups 001, 002; Security 002, 004; Smaller
   projects 002, 006, 007, 008; Testing 001). Historical `_done` plans keep
   their original paths.

## What the carve showed

- **The daemon coupling was shallow.** `TreeSynchronizer` read two fields of
  `Workspace`, four methods of `TreeManager`, and `EventBus.emit`. Three port
  interfaces in `packages/canopy-client/src/ports.ts` cover it, and the class is
  generic over the workspace shape so the daemon passes its own `Workspace`
  without a cast.
- **`@arbor/fs` and `@arbor/stores` are direct dependencies of
  `@arbor/canopy-client`**, not ports. `sync-state.ts` owns its per-tree files
  and `account-bootstrap.ts` snapshots a directory during a claim. "Store as a
  dependency" holds at the package level; it is not an abstraction the
  synchronizer needs today.
- **The Swift cycle-breaker was locator logic.** `ArborKit`, `ArborReplica`,
  and `ArborQuagmire` depended on the REST client only for `LogicalURL.swift`
  and `JSONValue`, which had lived there since before `ArborKit` existed.
- **The provider contract test spans both providers.** It now lives in
  `ArborSyncClientTests` with a test-only dependency on `ArborReplica`. If it
  grows, a dedicated contract test package is the cleaner home.
- **`Package.resolved` hashes will move.** Renaming a package changes its
  manifest hash, so the first `swift package resolve` after this change
  rewrites `originHash` in `CanopyClient` and `ArborQuagmire`; the pinned
  Yams and Quagmire revisions do not change.

## Verification

- `bun run typecheck`, `bun run test`, `bun run build`.
- `swift test` on `ArborKit`, `ArborSyncClient`, `CanopyClient`, `ArborReplica`,
  and `tools/test-arbor-quagmire-local.sh`. These need a macOS toolchain and
  cannot run in the Linux session that performs the carve; run them before
  merging.
- `tests/protocol/conformance.ts` names the new package paths.
- No relative Markdown link in the repository resolves to an old path.

## Exit evidence

Record the passing commands, then move this file to
`plans/_done/cleanups/` and remove its entry from `plans/README.md`.
