# Security 004: Keep access-link secrets out of local navigation state

> **Drift check:** inspect `packages/cli/src/index.ts`,
> `packages/render/src/App.tsx`,
> `packages/arborsync/src/service.ts`, `packages/stores/src/visits.ts`, the Wire
> client request boundary, and `docs/client.md`. Stop if local remote browsing
> already transports link credentials outside locator strings and persists only
> credential-free visit locators.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED
- **Progress:** TODO
- **Written against:** `421e384`

## Problem

The client contract says raw secrets never enter loopback URLs, browser history,
visit records, logs, or diagnostics. Canopy's public bootstrap correctly reads
the link fragment in the remote origin and sends `Arbor-Access-Link` as a
header. Local Arbor does not yet have the equivalent out-of-band handoff:

- `launchedRemoteLocation()` accepts the complete `browse` query value;
- both CLI browser-launch paths put `target.remoteURL`, including any access
  fragment, into the loopback `browse` query parameter;
- remote locators are passed through normal resolve/navigation state;
- `remoteSnapshot()` canonicalizes the full input URL and gives it to
  `VisitedTreeStore`;
- the visit store derives its key from and persists that locator; and
- `fetchRemoteProjection()` constructs a bearer-only `WireClient`, then uses
  `WireProjection` for object and boundary reads, so the link credential is not
  available as `Arbor-Access-Link` anywhere along the current projection path.

A link fragment must remain usable for local browsing without becoming durable
navigation or cache state.

## Required design

1. Parse the access fragment at the CLI/operating-system launch boundary,
   before constructing any loopback browser URL. Separate the credential from
   the fragment-free canonical locator before browser history, recent visits,
   breadcrumbs, diagnostics, React state, or ordinary locator resolution see
   it. Browser-side parsing may remain only as defense in depth; it is too late
   to be the primary handoff because the secret would already be in the
   loopback URL.
2. Replace the loopback location immediately with the credential-free browse
   location. Do not preserve the secret in `history.state`, React state that is
   serialized, query parameters, or error messages.
3. Extend the local client/daemon remote-resolution boundary with an explicit
   ephemeral access-link input. Transport it in a request header or body, never
   inside the locator. Do not overload account bearer credentials.
4. Pass that credential through `fetchRemoteProjection()` into its `WireClient`
   and `WireProjection` object/boundary reads, using the normative
   `Arbor-Access-Link` header for resolve, node, children, and object requests
   needed by the visit. Keep it in memory only for the active visit/session.
5. Normalize and persist visit identity from the fragment-free locator.
   Existing visit records containing a fragment must be ignored or rewritten
   without reproducing the secret in logs or diagnostics.
6. Keep account-authenticated browsing unchanged and do not create a general
   credential store as part of this fix.

## Scope

Expected files include:

- `packages/cli/src/index.ts`;
- `packages/render/src/App.tsx`;
- `packages/client/src/index.ts`;
- `packages/arborsync/src/server.ts` and `service.ts`;
- `packages/wire/src/client.ts` if its request helper needs a link header;
- `packages/stores/src/visits.ts`;
- focused browser/integration tests; and
- `docs/client.md` only if implementation details need clarification.

Out of scope: changing public share-link format, storing link secrets for later
visits, account-token redesign, or changing Canopy access semantics.

## Verification

Add tests proving:

1. Opening a link-authorized remote tree locally succeeds.
2. The loopback URL is scrubbed before the visit renders.
3. browser history, `VisitedTreeStore` JSON, visit properties, diagnostics, and
   test-visible request URLs contain no raw secret or encoded copy of it.
4. Canopy receives the secret only through `Arbor-Access-Link`.
5. Revisiting the credential-free cached record never grants live access after
   the in-memory credential is gone.
6. Invalid/revoked link errors do not echo the credential.

Run:

```sh
bun test tests/integration/canopy/update-host.test.ts tests/integration/system-trees.test.ts
bun run typecheck
bun run test:e2e
git diff --check
```

## Done criteria

- [ ] No raw access-link secret enters a loopback URL or durable navigation state.
- [ ] Durable visits contain only credential-free locators and snapshots.
- [ ] Link-authorized local browsing uses the normative request header.
- [ ] Account-authenticated and public browsing behavior remains unchanged.
- [ ] Focused integration and browser tests prove both success and non-persistence.

## STOP conditions

- The operating-system handoff cannot deliver the secret without first writing
  it to browser history; return with platform-specific alternatives.
- The only workable design persists the secret for reconnect or offline cache.
- Wire requests cannot carry link authorization without conflating it with an
  account credential or widening access to unrelated trees.
