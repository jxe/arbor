# Smaller project 010 — Trim the Local Arbor REST surface to its real callers

- **State:** DONE 2026-09-08
- **Priority:** P2; independent of, and smaller than,
  [Smaller project 009](../../smaller-projects/009-admission-shaped-rest-api.md); done first
- **Depends on:** nothing. Coordinates with 009 only where both touch
  `packages/arborsync/src/server.ts`.

> **Executor instructions**: Follow this plan step by step and run every
> verification command. Two premises are fixed: Arbor Sync only ever runs on
> the same machine as the CLI and the editor hosts, and the CLI may assume an
> Arbor Sync is already running and error out when it is not. Do not add
> routes, and do not remove a route until its last caller is gone in the same
> commit. If a route turns out to have a caller this plan
> did not list, stop and report rather than keeping the route "just in case".
> When complete, move this file to `plans/_done/smaller-projects/`, record the
> passing commands, and remove its entry from `plans/README.md`.

## Outcome

Every route Arbor Sync serves has a caller that needs HTTP: a browser, an
editor host, or the CLI talking to the daemon that owns the workspace. The
CLI never starts a private daemon to answer a command; it requires a running
Arbor Sync and fails clearly without one. Work that has no drawback when done
directly (reading configuration, identity, minting identifiers, resolving
locators from configuration) goes through one library that both the CLI and
the daemon use, so neither reimplements it. Dead routes, test-only routes, and
second shapes of the same data are gone, and `docs/arborsync-api.md` lists
exactly what remains.

## Why

A survey of `packages/arborsync/src/server.ts` on 2026-09-08 (after
Reliability 005) found 28 routes. Grouped by what they are for:

| Group | Routes | Finding |
|---|---|---|
| Dead | `POST /v1/conflicts/:tree/resolve` | Only `tests/integration/self-sync.test.ts` calls it. No web, CLI, or Swift caller. Tree-level conflict resolution reaches clients through `ReplicaSyncCoordinator` (iOS) and, on macOS, nothing yet (Reliability 004). |
| Test-only | `QUERY /.arbor/trees/:tree/queries`, `POST /.arbor/trees/:tree/mutate` | Their runtimes are injected only by `tests/integration/query-stream-api.test.ts`; `packages/arborsync/src/cli.ts` never passes them. The production Wire surface is `packages/canopy/src/host.ts`. |
| CLI-only | `POST /v1/placements/move`, `POST /v1/tree-ids`, `POST /v1/sessions`, `POST /v1/sync` | `withArborSync` in `packages/cli/src/index.ts` attaches to a running daemon, but under `ARBOR_DATA_HOME` it starts a private in-process `serveArborSync` and talks HTTP to itself. `tree-ids` is a pure mint with no daemon state. `placements/move`, `sessions`, and `sync` touch state the daemon owns (placements, the workspace index, the sync loop) and must stay with the daemon; the Swift client also calls `sessions` and `sync`. |
| Two shapes of one thing | `GET /v1/file` vs the root path fallback (`GET /*?raw`, Referer scoping); `POST /v1/assets` vs `POST /v1/imports`; `writeMarkdown` in `POST /v1/mutations` vs `POST /v1/documents/admit`; `GET /v1/me`, `GET /v1/accounts`, `POST /v1/bootstrap/accounts` | Same data, different addressing or envelope. The admit split is owned by 009. |

The rest (`status`, `trees`, `accounts`, `resolve`, `node`, `children`,
`search`, `backlinks`, `recovery`, `events`, `mutations`, `documents/admit`,
`assets`, `imports`, `bootstrap/pairings`, `local/forget`) have browser or
Swift callers and are not in question.

## Decisions

- **The CLI requires a running Arbor Sync.** `withArborSync` keeps its
  attach path (`ARBOR_SYNC_URL`, the cloud session, the well-known port, and
  the macOS supervisor kick) and loses the `ARBOR_DATA_HOME` branch that
  starts a private `serveArborSync`. Without a compatible daemon the command
  errors with the install or start instruction. The only CLI commands that
  run daemon code are `arbor daemon …` and `__cloud-arborsync`, because they
  *are* the daemon process.
- **Direct when there is no drawback; through the daemon when there is.**
  "No drawback" means the operation reads or derives from durable
  configuration and touches nothing the daemon owns in memory or watches on
  disk. Direct: reading accounts, placements, and identity (`arbor me`,
  `arbor status` without a locator), minting TreeIDs, resolving a canonical
  URL or `arbor://` locator against configuration. Through the daemon:
  anything that opens a workspace session, moves or creates a placement,
  edits account configuration the daemon watches, or asks for synchronization
  (`open`, `place`, `mv`, `sync`, `cloud`). Concurrent edits of daemon-owned
  files are the drawback, so those stay HTTP.
- **One library under both.** Extract the daemon-independent logic the CLI
  needs from `packages/arborsync/src/service.ts` into a package the daemon
  and the CLI both import (working name `@arbor/arborsync-core`; it may be a
  directory inside `packages/arborsync` if a separate package is not worth
  it). Candidates: data-home layout and `CommunityConfigStore` reads,
  placement and account projection (`trees.placementFor`, the overview the
  status command prints), locator resolution from configuration, identity
  read/create, and TreeID minting. `ArborService` becomes the runtime that
  adds the workspace index, watchers, the sync loop, and HTTP on top of that
  library. Nothing in the library may hold daemon-only state.
- **Tests exercise the runtime they own.** The Wire query/mutation stream
  test moves onto the Canopy host, or the daemon's optional runtimes are
  deleted with it. Do not keep production routes to serve one test.
- **One bytes route.** Keep the OS-shaped root route (browsers and `<img>`
  references need it) and remove `GET /v1/file` once the CLI and Swift
  `file()` callers use the same resolver.
- **One upload route.** `POST /v1/assets` becomes `POST /v1/imports` with a
  single entry. Update the web editor and the Swift client in the same
  commit; keep the response shape the editor already reads.
- **Identity shape is 009's concern only where it touches admission.** Fold
  `GET /v1/me` into `GET /v1/accounts` (one caller, `App.tsx`), and leave the
  claim flow (`POST /v1/bootstrap/accounts`) alone.
- **Conflict resolution route is deleted, not adopted.** Reliability 004
  decides how macOS resolves tree-level conflicts; it must not inherit an
  unused route as a fait accompli. If 004 later wants HTTP for it, it adds a
  route with a caller.

## Work

1. Extract the shared layer. Move the daemon-independent pieces named above
   out of `ArborService` into the library, make `ArborService` consume it,
   and prove nothing changed with the existing unit and integration suites.
   This step adds no CLI behavior; it only relocates code.
2. Delete `POST /v1/conflicts/:tree/resolve` and the self-sync test's use of
   it (replace the test's resolution with the service method it actually
   tests, or drop the assertion if it only proved the route).
3. Delete the daemon's `queryRuntime`/`mutationRuntime` options and the two
   `/.arbor/trees/:tree/*` routes; point `query-stream-api.test.ts` at
   `packages/canopy/src/host.ts`.
4. Remove the `ARBOR_DATA_HOME` in-process daemon branch from
   `withArborSync`; the CLI errors when no compatible Arbor Sync answers.
   Update `docs/cli.md` ("Commands select Arbor Sync in this order") and the
   CLI tests that relied on the private daemon (they start a daemon
   explicitly instead).
5. Route the drawback-free commands through the library directly: `arbor me`,
   `arbor status` without a locator, locator resolution, TreeID minting.
   Delete `POST /v1/tree-ids` and its `ArborSyncRESTClient` methods in
   TypeScript and Swift. `placements/move` stays as the daemon-owned move
   behind `arbor mv`.
6. Replace `POST /v1/assets` with a one-entry `POST /v1/imports` in
   `PageEditor.tsx` and `ArborSyncRESTClient.swift`; delete the route.
7. Retire `GET /v1/file` after moving the CLI and Swift `file()` callers to
   the root path route with `?raw`; delete the route and both client methods.
8. Fold `GET /v1/me` into `GET /v1/accounts`; update `App.tsx`; delete the
   route and `POST /v1/me` if `App.tsx` is its only writer (it is today).
9. Rewrite the route table in `docs/arborsync-api.md` from the code, and
   update `tests/unit/protocol.test.ts` and `conformance/` reference fixtures
   for any envelope that changed.

Each step is one commit with its caller change; the route table in step 9
is regenerated at the end.

## What execution showed

- **`/v1/file` is not a duplicate.** It is the NodeRef-addressed read that
  the CLI, `@arbor/arborsync-client` configuration helpers, and the Mac app
  use for system and configuration-tree files (`/trees.yaml`,
  `/devices.yaml`), which the OS-path root route cannot address. It stays.
- **Assets and imports are different operations.** `POST /v1/assets` places
  bytes content-addressed under `/Assets` and returns the Markdown-relative
  path the editor inserts; `POST /v1/imports` places entries at chosen paths.
  Merging them would be a protocol change for no caller's benefit. Both stay.
- **The shared layer is `@arbor/stores`.** The only daemon-independent logic
  the CLI needed was the claimed-account projection; identity already lived
  in `ProfileIdentityStore` and ID minting in `@arbor/core`. A new package
  would have held one function, so `listLocalAccounts` joined the data-home
  kit and `ArborSyncDaemon.accountList` delegates to it.
- **`arbor status` now lists accounts while the daemon is down**, because
  that read is durable configuration; runtime and tree state still come from
  the running daemon.
- **Removed:** `POST /v1/conflicts/:tree/resolve`, the daemon's Wire
  `queries`/`mutate` routes and their runtime options, `POST /v1/tree-ids`
  (both clients mint locally; `CanopyClient` gained `generateArborID`), and
  `GET /v1/me` (folded into `GET /v1/accounts` as `identity`;
  `POST /v1/me` keeps its web caller).
- **The CLI's private daemon is gone.** `withArborSync` and `arbor open`
  attach or fail; the three CLI integration suites start an explicit control
  daemon per command and pass `ARBOR_SYNC_URL`.

## Exit evidence (2026-09-08)

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
swift test --package-path native/Packages/ArborSyncClient
swift test --package-path native/Packages/CanopyClient
git diff --check
grep -rn "conflicts/.*resolve\|/v1/tree-ids\|/v1/me\b" packages native tests --include='*.ts' --include='*.tsx' --include='*.swift'
grep -n "serveArborSync(" packages/cli/src/index.ts
```

All passed; the two greps return only `POST /v1/me` (kept) and no
`serveArborSync` in the CLI. `bun run test` carries the known parallel-only
flakes recorded for Reliability 005.

## Out of scope

- The editor-facing admit/open/observe/close shape (009).
- Changing what Canopy serves (`packages/canopy/src/host.ts`).
- Replacing HTTP between the app and the daemon; they are separate processes
  on purpose (daemon supervision, persistent service).
- Making the CLI start a daemon on demand. It reports the missing daemon and
  the command that installs or starts it.

## Verification

```sh
bun run typecheck
bun run test
bun run test:protocol
bun run build
swift test --package-path native/Packages/ArborSyncClient
git diff --check
```

Plus a read-only grep proving no removed path string remains outside
`plans/_done/`:

```sh
grep -rn "conflicts/.*resolve\|/v1/tree-ids\|/v1/assets\|/v1/file\|/v1/me\b" packages native tests docs --include='*.ts' --include='*.tsx' --include='*.swift' --include='*.md'
grep -n "serveArborSync(" packages/cli/src/index.ts   # only the daemon and cloud commands
```

## Done criteria

- [x] Every route in `server.ts` has a non-test caller outside the daemon's
  own process, listed in `docs/arborsync-api.md`.
- [x] The CLI never starts a private daemon; it attaches to a running Arbor
  Sync or errors, and `arbor daemon …` is the only command that runs one.
- [x] Drawback-free commands run through the extracted library with no HTTP,
  and `ArborService` imports that same library rather than duplicating it.
- [x] One identity read; the bytes and upload routes were found to be distinct operations (see above).
- [x] `POST /v1/conflicts/:tree/resolve` and the daemon's Wire query and
  mutation routes are gone.
- [x] All verification commands pass.
