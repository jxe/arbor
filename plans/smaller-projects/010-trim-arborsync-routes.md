# Smaller project 010 — Trim the Local Arbor REST surface to its real callers

- **State:** PLANNED
- **Priority:** P2; independent of, and smaller than,
  [Smaller project 009](009-admission-shaped-rest-api.md); do this first
- **Depends on:** nothing. Coordinates with 009 only where both touch
  `packages/arborsync/src/server.ts`.

> **Executor instructions**: Follow this plan step by step and run every
> verification command. Arbor Sync is a local daemon that only ever runs on
> the same machine as the CLI and the editor hosts; treat that as a fixed
> premise. Do not add routes, and do not remove a route until its last caller
> is gone in the same commit. If a route turns out to have a caller this plan
> did not list, stop and report rather than keeping the route "just in case".
> When complete, move this file to `plans/_done/smaller-projects/`, record the
> passing commands, and remove its entry from `plans/README.md`.

## Outcome

Every route Arbor Sync serves has a caller that needs HTTP: a browser, an
editor host, or a different process. Same-process CLI work calls the service
directly. Dead routes, test-only routes, and second shapes of the same data
are gone, and `docs/arborsync-api.md` lists exactly what remains.

## Why

A survey of `packages/arborsync/src/server.ts` on 2026-09-08 (after
Reliability 005) found 28 routes. Grouped by what they are for:

| Group | Routes | Finding |
|---|---|---|
| Dead | `POST /v1/conflicts/:tree/resolve` | Only `tests/integration/self-sync.test.ts` calls it. No web, CLI, or Swift caller. Tree-level conflict resolution reaches clients through `ReplicaSyncCoordinator` (iOS) and, on macOS, nothing yet (Reliability 004). |
| Test-only | `QUERY /.arbor/trees/:tree/queries`, `POST /.arbor/trees/:tree/mutate` | Their runtimes are injected only by `tests/integration/query-stream-api.test.ts`; `packages/arborsync/src/cli.ts` never passes them. The production Wire surface is `packages/canopy/src/host.ts`. |
| Same-process CLI | `POST /v1/placements/move`, `POST /v1/tree-ids`, `POST /v1/sessions`, `POST /v1/sync` | `packages/cli/src/index.ts` starts an in-process `serveArborSync` and then talks HTTP to itself. Each has a direct method: `moveLocalPlacement`, `generateArborID` (pure, no daemon state), `openSession`, `synchronizeNow`. The Swift client also calls `/v1/sessions` and `/v1/sync`; those stay. |
| Two shapes of one thing | `GET /v1/file` vs the root path fallback (`GET /*?raw`, Referer scoping); `POST /v1/assets` vs `POST /v1/imports`; `writeMarkdown` in `POST /v1/mutations` vs `POST /v1/documents/admit`; `GET /v1/me`, `GET /v1/accounts`, `POST /v1/bootstrap/accounts` | Same data, different addressing or envelope. The admit split is owned by 009. |

The rest (`status`, `trees`, `accounts`, `resolve`, `node`, `children`,
`search`, `backlinks`, `recovery`, `events`, `mutations`, `documents/admit`,
`assets`, `imports`, `bootstrap/pairings`, `local/forget`) have browser or
Swift callers and are not in question.

## Decisions

- **The CLI calls the service, not HTTP, when it owns the daemon.** When the
  CLI has started `serveArborSync` in-process, it holds the `ArborService`
  and should use it. When it attaches to an already-running daemon
  (`ARBOR_SYNC_URL` or the persistent service), HTTP stays, because that is
  a different process. The route survives only if the attached case needs
  it: `sessions` and `sync` do (Swift uses them too); `placements/move` and
  `tree-ids` do not need HTTP at all, since a move is a local filesystem and
  configuration edit and an ID mint is pure.
- **Tests exercise the runtime they own.** The Wire query/mutation stream
  test moves onto the Canopy host, or the daemon's optional runtimes are
  deleted with it. Do not keep production routes to serve one test.
- **One bytes route.** Keep the OS-shaped root route (browsers and `<img>`
  references need it) and make `GET /v1/file` a thin alias or remove it once
  the CLI and Swift `file()` callers use the same resolver. Prefer removal;
  the NodeRef-shaped variant exists only because it predates the root route.
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

1. Delete `POST /v1/conflicts/:tree/resolve` and the self-sync test's use of
   it (replace the test's resolution with the service method it actually
   tests, or drop the assertion if it only proved the route).
2. Delete the daemon's `queryRuntime`/`mutationRuntime` options and the two
   `/.arbor/trees/:tree/*` routes; point `query-stream-api.test.ts` at
   `packages/canopy/src/host.ts`.
3. In `packages/cli/src/index.ts`, replace the four same-process HTTP calls
   with direct `ArborService` calls when the CLI owns the daemon; keep HTTP
   only on the attached path for `sessions` and `sync`. Delete
   `POST /v1/placements/move` and `POST /v1/tree-ids`, and their
   `ArborSyncRESTClient` methods in TypeScript and Swift.
4. Replace `POST /v1/assets` with a one-entry `POST /v1/imports` in
   `PageEditor.tsx` and `ArborSyncRESTClient.swift`; delete the route.
5. Retire `GET /v1/file` after moving the CLI and Swift `file()` callers to
   the root path route with `?raw`; delete the route and both client methods.
6. Fold `GET /v1/me` into `GET /v1/accounts`; update `App.tsx`; delete the
   route and `POST /v1/me` if `App.tsx` is its only writer (it is today).
7. Rewrite the route table in `docs/arborsync-api.md` from the code, and
   update `tests/unit/protocol.test.ts` and `conformance/` reference fixtures
   for any envelope that changed.

Each step is one commit with its caller change; the route table in step 7
is regenerated at the end.

## Out of scope

- The editor-facing admit/open/observe/close shape (009).
- Changing what Canopy serves (`packages/canopy/src/host.ts`).
- Replacing HTTP between the app and the daemon; they are separate processes
  on purpose (daemon supervision, persistent service).

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
grep -rn "conflicts/.*resolve\|placements/move\|/v1/tree-ids\|/v1/assets\|/v1/file\|/v1/me\b" packages native tests docs --include='*.ts' --include='*.tsx' --include='*.swift' --include='*.md'
```

## Done criteria

- [ ] Every route in `server.ts` has a non-test caller outside the daemon's
  own process, listed in `docs/arborsync-api.md`.
- [ ] The CLI makes no HTTP call to a daemon it started in-process.
- [ ] One bytes route, one upload route, one identity read.
- [ ] `POST /v1/conflicts/:tree/resolve` and the daemon's Wire query and
  mutation routes are gone.
- [ ] All verification commands pass.
