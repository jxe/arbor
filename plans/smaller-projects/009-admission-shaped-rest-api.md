# Smaller project 009 — Shape the Local Arbor REST API around document admission

- **State:** PLANNED
- **Priority:** P2; after Reliability 005 has run on both platforms
- **Depends on:** [Reliability 005](../_done/reliability/005-client-synchronization-state-machines.md)
  (the admission machine this API serves) and the
  [document admission reference](../../docs/client-state-machines.md)

## Outcome

The Local Arbor REST routes an editor uses map one-to-one onto the document
admission machine's effects and events, so a new editor host composes nothing
on the client side that Arbor Sync already knows. Routes the machine does not
need lose their editor-facing variants.

## Why

Implementing the machine in two editor hosts showed the same client-side
composition twice:

- **Two transports for one event.** `admit` goes to `POST /v1/documents/admit`
  when the snapshot carried an `admissionBasis` and to `POST /v1/mutations`
  with `writeMarkdown` otherwise. The web editor re-reads
  `GET /v1/node?admissionBasis=true` whenever its cached basis is missing or
  its revision moved, then chooses. Swift keeps a per-revision basis cache
  for the same choice. The machine only wants one `admit` whose response
  says whether a digest exists.
- **Observation is assembled by the client.** The machine wants one
  `observed(source, revision, basis?, acceptedRequestDigests)` event. Today a
  host follows `GET /v1/events`, filters by reference, re-reads
  `GET /v1/node`, merges the digests carried by the event with the digests on
  the snapshot, and applies a read-your-writes gate so an earlier accepted
  prefix does not replace a later admitted source. The Swift session
  (`ArborSyncDocumentSession.updates`) is 90 lines of exactly this; the web
  editor does it inline in `PageEditor`.
- **The daemon's role input is a side effect of a read flag.** Reading with
  `admissionBasis=true` is what tells Arbor Sync that disk is now an editor
  mirror. Ending that role relies on a 30 s grace timer because there is no
  close.
- **Own-mutation echo suppression is a second identity.** Editors filter
  events by `mutationID` to skip their own echoes and by request digest to
  wait for authority. For a Canopy-backed document the digest fence subsumes
  the echo check.

## Proposed shape

1. **`POST /v1/documents/open`** — `{ ref, editorID }` returns the document
   snapshot with `admissionBasis` when Canopy-backed, `acceptedRequestDigests`,
   and the transport kind (`canopy` or `local`). Opening is the explicit
   start of the editor-mirror role for the tree. Replaces the
   `admissionBasis=true` read flag.
2. **`POST /v1/documents/admit`** — accepts `admissionBasis` optionally. Without
   it Arbor Sync performs the guarded exact-source write and returns the same
   response shape without a digest. `writeMarkdown` remains available to the
   CLI and scripts under `/v1/mutations`, but editors no longer choose a route.
   Conflict responses always carry `details.kind` (`editor-admission` or
   `workspace-revision`), `resolutions`, and the `current` snapshot, which is
   what the machine's `admissionConflicted` needs.
3. **`GET /v1/documents/observe?ref&editorID&after`** — one SSE stream of
   document snapshots for one open session: each frame carries source,
   revision, basis, and the accepted digests incorporated so far. Arbor Sync
   applies the read-your-writes gate server-side from the retained admission it
   already holds, so a host dispatches `observed` directly. Browsing views keep
   `GET /v1/events`.
4. **`POST /v1/documents/close`** — `{ ref, editorID }` ends the session and,
   when no admission is retained, ends the editor-mirror role at once instead
   of after the grace period. Also lets Arbor Sync drop the session's
   read-your-writes snapshots.
5. **Error classification.** Every failure an `admit` can return states
   `retryable`; the machine's `failed` state depends on it and today
   infers it from status codes on the web.

## What goes away for editors

- The `admissionBasis=true` query flag on `GET /v1/node`.
- Choosing between `/v1/documents/admit` and `/v1/mutations` per document.
- Client-side digest merging and the per-revision basis cache.
- `mutationID` echo filtering on the document view for Canopy-backed
  documents; `isOwnMutation` remains for structural browsing views.

Nothing is removed from the daemon's route table in this project: the CLI,
imports, assets, and browsing views keep their routes. A later cleanup can
retire `writeMarkdown` from `/v1/mutations` once no shipped client sends it.

## Work

1. Add `open`, `observe`, and `close` beside `admit`; keep `GET /v1/node`
   unchanged apart from deprecating the read flag.
2. Move the read-your-writes gate from `ArborSyncDocumentSession` into Arbor
   Sync's observe route.
3. Point both editor hosts at the four routes and delete their composition
   code; both machines are unchanged.
4. Update `docs/arborsync-api.md`, the protocol fixtures for the new frames,
   and `tests/protocol/conformance.ts`.

## Verification

- Both editor hosts dispatch `observed` from a single frame with no
  client-side digest merging.
- The self-sync suite shows the editor-mirror role ending on close rather
  than after the grace period.
- `bun run test:protocol`, `tools/test-arbor-quagmire-local.sh`, and the
  ArborSyncClient tests pass.

## Exit evidence

Record the passing commands and move this file to `plans/_done/`.
