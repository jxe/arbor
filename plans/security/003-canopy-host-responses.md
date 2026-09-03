# Security 003: Harden Canopy responses and rate limiting

> **Drift check**: inspect `packages/canopy/src/host.ts`,
> `tests/integration/canopy`, and `deploy/` before editing. This plan was
> reconciled after the authority-to-Canopy rename; stop if a shared response
> policy or trusted-proxy abstraction has since landed.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Progress**: TODO

## Current evidence

`packages/canopy/src/host.ts` centralizes JSON and HTML helpers, but security
headers are not applied consistently to JSON, SSE, immutable objects, Markdown,
ordinary stored files, and plain error responses. The ordinary-file branch can
return stored bytes without a declared content type.

Pairing-claim throttling uses `cf-connecting-ip`, then the first
`x-forwarded-for` value, then `unknown`. A direct client can forge the forwarded
header unless the listener has an explicit trusted-proxy boundary. The
`pairingClaimAttempts` map also retains keys indefinitely.

## Scope

In scope:

- one response-hardening helper used by every Canopy response path;
- safe MIME/attachment treatment for ordinary stored bytes;
- a connection-peer rate-limit key by default and an explicit trusted-proxy
  policy for deployed reverse proxies;
- bounded cleanup of pairing-attempt state;
- focused Canopy integration tests and deployment documentation.

Out of scope:

- changing pairing expiry, one-use semantics, credential storage, or account
  identity;
- redesigning public Markdown rendering or access-link bootstrap;
- a general distributed rate-limit service or production HA;
- DNS-rebinding protection for the separate loopback arborsync server.

## Steps

### 1. Apply one safe header policy

Introduce one helper in `packages/canopy/src/host.ts` and use it from JSON,
HTML, SSE, object, Markdown, ordinary-file, and plain error responses.

At minimum, every response carries:

- `x-content-type-options: nosniff`;
- `x-frame-options: DENY`; and
- `referrer-policy: no-referrer`.

HTML additionally receives a CSP compatible with the actual rendered Markdown
and access-link bootstrap. The current pages contain inline style and the
bootstrap contains inline script, so verify the selected policy against those
pages rather than copying an unusable generic policy.

Preserve the intentionally different cache contracts: JSON is `no-store`, HTML
and Markdown are `no-cache`, immutable objects remain public/immutable, and SSE
remains non-cacheable.

### 2. Type ordinary stored bytes conservatively

Use a small reviewed extension allowlist for inert image/text types. Unknown or
active types—including SVG and HTML—must return
`application/octet-stream`, `content-disposition: attachment`, and `nosniff`.
Do not import an arborsync-only MIME table into Canopy.

### 3. Make the throttle key trustworthy and bounded

Use `server.requestIP(request)?.address` as the default key. Accept forwarded
addresses only behind an explicit trusted-proxy hop count or equivalent
configuration:

- zero trusted hops ignores forwarding headers;
- `N > 0` selects the Nth address from the right, after validating the chain;
- an unavailable address falls back to the peer and only then a literal shared
  fallback.

Apply that key to pairing claims and prune timestamps/keys older than the
ten-minute pairing-attempt window. Document the proxy setting and the effect of
under- or over-counting trusted hops in `deploy/README.md`.

### 4. Prove the public behavior

Add focused tests under `tests/integration/canopy/` for:

1. headers on JSON, HTML, Markdown, SSE, immutable object, ordinary file, 404,
   and authorization-error responses;
2. HTML-shaped bytes under an unknown extension downloading as octet-stream;
3. the access-link bootstrap and public Markdown page still functioning under
   CSP;
4. spoofed `x-forwarded-for` having no effect with zero trusted hops;
5. the configured right-to-left proxy hop selecting the expected client; and
6. expired pairing-attempt entries being removed without weakening the active
   limit.

## Verification

```sh
bun test tests/integration/canopy
bun run typecheck
bun run build
git diff --check
```

## Done criteria

- [ ] Every Canopy response path carries the shared safe headers.
- [ ] Unknown or active stored files cannot execute inline.
- [ ] Direct clients cannot choose their own rate-limit bucket with a header.
- [ ] Trusted proxy behavior is explicit, documented, and tested.
- [ ] Pairing-attempt state is bounded by its active time window.
- [ ] Pairing, access-link, Markdown, object, and query-stream behavior remain
  intact.

## STOP conditions

- CSP would require breaking the access-link bootstrap without a tested
  replacement.
- The proxy topology cannot be expressed unambiguously by the chosen setting.
- A fix would weaken one-use pairing, expiry, revocation, or credential secrecy.
- The work requires a distributed limiter or broader deployment redesign.
