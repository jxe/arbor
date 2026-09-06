# Security 004: Complete access-link sharing without leaking secrets

> **Drift check:** inspect `packages/cli/src/index.ts`,
> `packages/render/src/App.tsx`,
> `packages/arborsync/src/service.ts`, `packages/stores/src/visits.ts`, the Wire
> client request boundary, native URL handling, and `docs/client.md`. Stop if
> browser and native recipients can already traverse a protected multi-page tree
> with protected assets, edit when granted write access, survive ordinary
> navigation, and revoke promptly without retaining the raw secret.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH
- **Progress:** TODO
- **Written against:** `aaba38a`

## Problem

The client contract says raw secrets never enter loopback URLs, browser history,
visit records, logs, or diagnostics. Canopy's public bootstrap reads the link
fragment in the remote origin and sends `Arbor-Access-Link` as a header for one
fetch. That proves the authority accepts the credential, but it is not yet a
complete recipient experience:

- the raw fragment remains in browser history;
- ordinary links, reloads, and protected assets do not reliably retain access;
- no real-browser test traverses a protected multi-page tree;
- native Arbor cannot open an access-link URL; and
- a write-capable link has no complete recipient editing flow.

Local Arbor also lacks the equivalent out-of-band handoff:

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

A link fragment must remain usable throughout an authorized recipient session
without becoming durable navigation or cache state. The native private-link
creation surface stays absent until the view-only flow meets this plan's gates;
its `Can edit` choice stays absent until linked editing meets them too.

## Required design

1. At Canopy's public bootstrap, extract the fragment and immediately replace
   the visible/history URL with its credential-free canonical form before
   fetching protected content. Exchange the secret through
   `Arbor-Access-Link` for a random, revocation-aware browser-session
   capability. Store only an opaque session identifier in an `HttpOnly`,
   `Secure`, `SameSite=Strict` cookie; keep the raw secret out of cookies, DOM,
   browser storage, logs, errors, analytics, and subsequent URLs.
2. Scope each browser-session capability to the access-link digest and tree.
   Recheck the live ACL on every protected document, object, and asset request,
   so removal or permission reduction takes effect without waiting for session
   expiry. Support multiple tree capabilities in one browser session without
   widening any grant to another tree.
3. Make ordinary same-tree links, reload, back/forward navigation, nested-tree
   boundaries, and protected assets work through that session. Crossing into a
   tree not covered by the capability must use its public/account access or
   fail closed. Clear the session capability when the browser session ends and
   provide no reconnect or offline promise.
4. Parse the access fragment at the CLI/operating-system launch boundary,
   before constructing any loopback browser URL. Separate the credential from
   the fragment-free canonical locator before browser history, recent visits,
   breadcrumbs, diagnostics, React state, or ordinary locator resolution see
   it. Browser-side parsing may remain only as defense in depth; it is too late
   to be the primary handoff because the secret would already be in the
   loopback URL.
5. Replace the loopback location immediately with the credential-free browse
   location. Do not preserve the secret in `history.state`, React state that is
   serialized, query parameters, or error messages.
6. Extend the local client/daemon remote-resolution boundary with an explicit
   ephemeral access-link input. Transport it in a request header or body, never
   inside the locator. Do not overload account bearer credentials.
7. Pass that credential through `fetchRemoteProjection()` into its `WireClient`
   and `WireProjection` object/boundary reads, using the normative
   `Arbor-Access-Link` header for resolve, node, children, and object requests
   needed by the visit. Keep it in memory only for the active visit/session.
8. Normalize and persist visit identity from the fragment-free locator.
   Existing visit records containing a fragment must be ignored or rewritten
   without reproducing the secret in logs or diagnostics.
9. Register the access-link URL with native Arbor and apply the same immediate
   fragment separation before opening a remote tree. Keep the secret only in
   the active in-memory visit/session and propagate it to every required Wire
   read. A cold reopen of a credential-free recent visit must not regain access.
10. Deliver link-authorized editing only through the normal reviewed update
    path, with the link credential on every required read/update request and a
    real recipient UI. Do not expose `Can edit` link creation while only the
    authority-level permission exists. Revocation or downgrade during editing
    must fail safely without losing the recipient's unsent local draft.
11. Keep account-authenticated browsing unchanged and do not create a general
   credential store as part of this fix.

## Scope

Expected files include:

- `packages/cli/src/index.ts`;
- `packages/render/src/App.tsx`;
- `packages/client/src/index.ts`;
- `packages/arborsync/src/server.ts` and `service.ts`;
- `packages/wire/src/client.ts` if its request helper needs a link header;
- `packages/stores/src/visits.ts`;
- Canopy's bootstrap/session handling and protected asset responses;
- native URL registration and open handling;
- focused browser, native, and integration tests; and
- `docs/client.md` only if implementation details need clarification.

Out of scope: changing the public `#arbor-access=` link format, storing raw link
secrets for later visits, account-token redesign, offline link access, or
widening a link beyond its ACL tree.

## Verification

Add tests proving:

1. A real browser opens, reloads, and follows links through at least two
   protected pages and one protected asset using a read link.
2. The public and loopback URLs are scrubbed before protected content renders.
3. Browser history/storage, cookies, `VisitedTreeStore` JSON, visit properties,
   diagnostics, and test-visible request URLs contain no raw secret or encoded
   copy of it.
4. Canopy receives the raw secret only through `Arbor-Access-Link`; later
   requests carry only an opaque browser-session identifier.
5. Revoking or downgrading a link affects the next document, object, asset, and
   update request, including an already-open browser session.
6. Native Arbor can open a link-authorized tree without putting the secret in
   loopback URLs, recents, diagnostics, or persisted state.
7. Revisiting the credential-free cached record never grants live access after
   the in-memory credential is gone.
8. Invalid/revoked link errors do not echo the credential.
9. A write link can edit through the normal update/conflict path before its
   creation control is exposed; a read link cannot write.

Run:

```sh
bun test tests/integration/canopy/update-host.test.ts tests/integration/system-trees.test.ts
bun run typecheck
bun run test:e2e
swift test --package-path native/Packages/ArborSync
xcodebuild -project native/Arbor.xcodeproj -scheme Arbor -destination 'generic/platform=iOS Simulator' build
xcodebuild -project native/Arbor.xcodeproj -scheme Arbor -destination 'platform=macOS' build
git diff --check
```

## Done criteria

- [ ] Canopy browser recipients can traverse and reload protected pages and assets.
- [ ] Public and local handoff scrub the raw fragment before protected content renders.
- [ ] No raw access-link secret enters a cookie, loopback URL, or durable navigation state.
- [ ] Durable visits contain only credential-free locators and snapshots.
- [ ] Link-authorized native browsing uses the normative request header.
- [ ] Live ACL rechecks make revocation and downgrade effective on the next request.
- [ ] Read-link and write-link recipient behavior is proven independently.
- [ ] Native link creation returns only after view links pass every
      browser/native gate; `Can edit` returns only after the editing gate.
- [ ] Account-authenticated and public browsing behavior remains unchanged.
- [ ] Focused integration and browser tests prove both success and non-persistence.

## STOP conditions

- The operating-system handoff cannot deliver the secret without first writing
  it to browser history; return with platform-specific alternatives.
- Standard browser navigation cannot use a scoped, revocation-aware session
  without persisting the raw secret or widening the grant; return with the
  competing navigation/session designs rather than shipping a partial router.
- The only workable design persists the secret for reconnect or offline cache.
- Wire requests cannot carry link authorization without conflating it with an
  account credential or widening access to unrelated trees.
