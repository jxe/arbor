# Security 011: Story Sync answers only its own user

**Why and when:** Joe tried the Mac download from a second account on his Mac on 2026-10-11, and the app there was about to attach to the sync helper his own account was running. Story Sync listens on a fixed loopback port and does not ask who is calling, so on a shared Mac one person's helper serves another person's processes. Do this before the Mac download goes beyond a few friends who each have their own Mac.

> **Executor instructions**: Use disposable `STORY_HOME` directories and `STORY_CREDENTIAL_STORE=file` for every experiment. Do not touch Joe's data home, his installed app or the live host. The exposure below is read from the source; step 1 confirms it by experiment before anything is designed around it.

## Status

- **Effort**: M
- **Risk**: MEDIUM. Every client of Story Sync changes how it connects: the Mac app, the `story` command and the tests.
- **Depends on**: nothing
- **Category**: security

## What exists

- Story Sync binds `127.0.0.1` (`packages/story-sync/src/server.ts`) on port 4317 (`STORY_SYNC_PORT` in `packages/cli/src/daemon.ts`, `defaultPort` in `swift/StoryApp/StorySync/StorySyncProcessSupervisor.swift`). A loopback port is shared by everyone logged in to the Mac.
- Its only request checks are in `assertSameOrigin` (`packages/story-sync/src/http.ts`): the Host header must be loopback, and a write with an Origin header must be same-origin. That stops a web page; it does not identify a local process.
- The helper holds its user's device credentials and serves their trees, accounts, pairing and placement routes (`sync-http.ts`, `account-http.ts`, `browser-http.ts`).
- The Mac app attaches to whatever answers `/v1/status` on the port as `story-sync` with protocol `v1` (`attachIfCompatible`). A second user's app therefore attaches to the first user's helper instead of starting its own.
- Cloud sessions already use port 0 and record their origin in the session's private data home.

## What a second user can do, as read from the source

Read the first user's pages and account list, create a pairing offer or an agent bundle for their account, and write to their placed folders through the helper. None of this has been tried; step 1 does.

## Decisions to make

- **How a caller proves it is the same user.** Three candidates:
  - A Unix domain socket in the data home, mode 0600. The operating system enforces it and no secret exists. Bun and URLSession both support it; the browser-facing editor (`story open`, Web 025) cannot use one and would need a loopback listener of its own.
  - A bearer token in a 0600 file in the data home, required on every request. Keeps the loopback port and works for a browser, at the cost of a secret to handle in three clients.
  - A per-user port recorded in a 0600 file. Fixes the wrong-helper attach but leaves the routes open to anyone who scans ports, so it is not enough alone.
- **Whether the fixed port stays** for the browser editor, and what it serves without a credential.

## Steps

1. **Confirm.** In a test, start Story Sync with a disposable data home and call its routes from a process with a different `STORY_HOME` and no shared state; then, by hand, from a second macOS account. Record what answered.
2. **Decide** the caller check with Joe, and write it into `docs/architecture/story-sync/` before changing code.
3. **Implement** in Story Sync, then in the Mac supervisor and REST client, the `story` command, and the test helpers. The app must start its own helper when the one on the port is not its user's.
4. **Check** with two macOS accounts: each runs its own helper, and neither can read the other's status. Gate: `bun run test:affected`, `bun run test:protocol`, `swift/scripts/test-story-app.sh`.
5. **Close out.** Record the evidence in `status.md` and delete this plan.
