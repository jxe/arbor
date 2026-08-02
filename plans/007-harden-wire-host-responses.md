# Plan 007: Harden community-host responses and the anonymous rate-limit key

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 4247481..HEAD -- packages/wire/src/host.ts`
> Also run `git status --short packages/wire/src/host.ts`. If the excerpts
> under "Current state" do not match the live code, treat it as a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `4247481`, 2026-07-31

## Why this matters

In `arbor serve` mode the wire host is a **public origin on the internet** —
`deploy/`, `railway.toml`, and `Dockerfile.host` exist precisely to put it
there. Two weaknesses follow from that.

**Stored file bytes are served with no declared content type.** Markdown gets an
explicit HTML wrapper, but every other file is returned raw with no
`content-type`, so browsers content-sniff it. On a tree with public read — or
public *write*, where anyone may push — an HTML payload therefore becomes
stored script on the community origin. That origin is where the link-access
bootstrap page handles the raw access secret from `location.hash` and splices a
fetched response into the live document, so script running there can exfiltrate
link secrets. No response sets `x-content-type-options`, `content-security-policy`,
or `x-frame-options`, so there is no second line of defense.

**The anonymous push rate limit is keyed on a client-controlled header.** The
bucket key is the first element of `x-forwarded-for`, which a client sends and
which the deployed Caddy reverse proxy appends to rather than replaces. Varying
one header defeats the limit entirely — and on a public-write tree that limit is
the only abuse control, with each push running a full graph validation and
writing objects to the volume. The `|| "anonymous"` fallback has the opposite
problem: on a direct (unproxied) deployment every legitimate client shares one
bucket and they rate-limit each other.

## Current state

Files involved:

- `packages/wire/src/host.ts` — the community host's HTTP surface.
- `deploy/Caddyfile` — the reverse proxy in the documented deployment.

The response helpers, `packages/wire/src/host.ts:18-20`:

```ts
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
```

There is a sibling `html(...)` helper used at `:66`, `:360`, and `:370` — find
it with `grep -n "^function html" packages/wire/src/host.ts`.

The untyped file response, `packages/wire/src/host.ts:355-367`:

```ts
          const objectValue = decodeWireObject(await authority.object(hash));
          if (objectValue.type === "file") {
            const name = parts.at(-1) ?? tree.canonicalPath.split("/").at(-1) ?? "Arbor";
            const body = new TextDecoder().decode(objectValue.bytes);
            if (name.endsWith(".md")) {
              return html(`<!doctype html>...<pre>${escapeHTML(body)}</pre>`);
            }
            return new Response(objectValue.bytes.buffer.slice(
              objectValue.bytes.byteOffset,
              objectValue.bytes.byteOffset + objectValue.bytes.byteLength,
            ) as ArrayBuffer);
          }
```

That final `new Response(...)` carries no headers at all.

The rate limiter, `packages/wire/src/host.ts:279-287`:

```ts
          if (!account) {
            const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
            const window = Math.floor(Date.now() / 60_000);
            const usage = anonymousPushes.get(key);
            if (usage?.window === window && usage.count >= 60) return json({ error: "rate-limit" }, 429);
            anonymousPushes.set(key, usage?.window === window
              ? { window, count: usage.count + 1 }
              : { window, count: 1 });
          }
```

`anonymousPushes` is declared around `packages/wire/src/host.ts:130` and is
never pruned, so it also grows without bound under remote control.

The server is created with `Bun.serve({ ... })` at the bottom of the file.
Bun exposes the connection peer address via `server.requestIP(request)` — you
will need a reference to the server object inside `fetch`, which in Bun is
available as the second argument to `fetch(request, server)`.

Repo conventions:

- Responses are built through the small `json(...)` / `html(...)` helpers rather
  than inline `new Response` where possible. Extend those helpers rather than
  sprinkling headers at call sites.
- Errors are plain `Error` with short sentences; typed errors
  (`RefConflictError`, `AlreadyClaimedError`, `ReservedBoundaryConflictError`)
  are defined in `packages/wire/src/authority.ts` and mapped by `instanceof` in
  the catch block at `packages/wire/src/host.ts:376-380`.
- Wire host tests: `tests/integration/wire-host.test.ts` (106 lines) and
  `tests/integration/community-hosting.test.ts`. Both start a real authority
  and issue `fetch` calls. Use `wire-host.test.ts` as the structural exemplar.

## Commands you will need

| Purpose      | Command                                              | Expected on success             |
|--------------|------------------------------------------------------|---------------------------------|
| Typecheck    | `bun run typecheck`                                  | exit 0, no output               |
| Tests        | `bun test`                                           | all pass (155 before this plan) |
| Wire host    | `bun test tests/integration/wire-host.test.ts`       | all pass                        |
| Community    | `bun test tests/integration/community-hosting.test.ts` | all pass                      |

## Scope

**In scope**:

- `packages/wire/src/host.ts`
- `tests/integration/wire-host.test.ts` (add tests)
- `deploy/README.md` (document the trusted-proxy setting added in step 3)

**Out of scope** (do NOT touch):

- `packages/wire/src/authority.ts` — the access model and its error types.
- `packages/wire/src/cbor.ts` — decoder hardening is `plans/003-*`.
- `packages/arbord/src/server.ts` — the local browse daemon is a different
  surface with different threat assumptions.
- `deploy/Caddyfile` — changing proxy configuration for existing deployments is
  an operational decision, not a code change. Document what is needed instead.
- Per-tree byte quotas and object-reachability indexing — both are real
  follow-ups, both are larger than this plan.

## Git workflow

- Branch: `advisor/007-harden-wire-host-responses`
- Commit message style from `git log`: short imperative sentence, no prefix.
  Example: `Declare content types and key rate limits on the peer address`.
- Do NOT push or open a PR.

## Steps

### Step 1: Add hardening headers to every response

Introduce a single shared header set in `packages/wire/src/host.ts`, applied by
the `json(...)` and `html(...)` helpers and by the raw-bytes response:

- `x-content-type-options: nosniff` — on every response.
- `x-frame-options: DENY` — on every response.
- `content-security-policy` — restrictive. The host serves its own inline
  `<style>` and, on the bootstrap page at `:66`, an inline `<script>`. A policy
  of `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`
  is a reasonable starting point. **Verify it against the actual pages in step
  4** — an over-tight CSP that breaks the link bootstrap is worse than none,
  because the bootstrap is how shared links open at all.

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test tests/integration/wire-host.test.ts` → all pass.

### Step 2: Declare a content type for stored file bytes

Replace the bare `new Response(objectValue.bytes...)` at
`packages/wire/src/host.ts:363` with a response that declares its type.

Use a conservative allowlist keyed on the filename extension (`name` is already
in scope at `:357`):

- A small map of known-safe types — images (`.png`, `.jpg`, `.jpeg`, `.gif`,
  `.webp`, `.svg` — **exclude `.svg`**, it is an active content type in
  browsers), plain text (`.txt`), `application/json` for `.json`, and so on.
  There is already a MIME map in `packages/arbord/src/server.ts` (`grep -n "MIME"`);
  read it for reference but do **not** import across the package boundary —
  copy the entries you need, since `@arbor/wire` should not depend on `@arbor/arbord`.
- Everything not on the allowlist gets
  `content-type: application/octet-stream` **and**
  `content-disposition: attachment`. Together with `nosniff` from step 1, that
  makes an uploaded HTML file download rather than execute.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Key the rate limiter on the connection peer, not a client header

Change the `fetch` handler signature to `async fetch(request, server)` and
derive the bucket key from `server.requestIP(request)?.address`.

Because the documented deployment puts Caddy in front, add an explicit
trusted-proxy setting rather than trusting `x-forwarded-for` implicitly:

- Read a configuration value — e.g. an option on the serve function or an
  environment variable such as `ARBOR_TRUSTED_PROXIES` holding a hop count.
  Follow how the file already reads configuration (`grep -n "process.env" packages/wire/src/host.ts`
  and the surrounding serve options) and match that pattern.
- When the hop count is **0** (the default), use the peer address and ignore
  `x-forwarded-for` entirely.
- When it is **N > 0**, take the Nth-from-the-right element of
  `x-forwarded-for` — the right-hand entries are the ones appended by trusted
  proxies, so they cannot be spoofed by the client. Never take the first.
- If no key can be determined, fall back to the peer address; only if that is
  also unavailable use a literal fallback string.

Also prune `anonymousPushes` so it cannot grow without bound: on each write,
drop entries whose `window` is older than the current one. That is a two-line
sweep and removes the remote-growth problem entirely.

Document the new setting in `deploy/README.md`: its name, that it must be set
to the number of trusted proxy hops (1 for the documented Caddy deployment),
and what goes wrong if it is left at 0 behind a proxy (all clients share the
proxy's bucket) or set too high (clients can spoof).

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Test the response headers and the limiter key

Add tests to `tests/integration/wire-host.test.ts`, following its existing
harness (start a real authority, `fetch` against it).

1. **Content type**: push a tree containing a file with an unrecognized
   extension whose bytes are HTML-shaped, fetch it through the public route,
   and assert `content-type` is `application/octet-stream` and
   `content-disposition` is `attachment`. This is the important one.
2. **Hardening headers**: assert `x-content-type-options: nosniff` on a JSON
   response, an HTML response, and the raw-bytes response.
3. **Markdown still renders**: fetch a `.md` file and assert the response is
   still HTML with the escaped body — the existing behavior must not regress.
4. **Spoofed XFF shares one bucket**: with the trusted-proxy hop count at its
   default of 0, issue anonymous pushes to a public-write tree while varying
   `x-forwarded-for` on each request, and assert the limiter still triggers a
   429. Before this change, varying the header avoided it entirely.
5. **Bootstrap page works under CSP**: fetch the link-access bootstrap route
   (`packages/wire/src/host.ts:66`) and assert it returns 200 with its inline
   script intact. This does not prove the browser will execute it — so also
   read the CSP you set and confirm by inspection that `script-src` permits the
   inline script. If you are not confident, loosen the CSP and say so in your
   report rather than shipping a policy that silently breaks shared links.

**Verify**: `bun test tests/integration/wire-host.test.ts` → all pass, 5 new tests.

**Verify**: `bun test tests/integration/community-hosting.test.ts` → all pass.

### Step 5: Full gate

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test` → all pass.

## Test plan

- Five integration tests in `tests/integration/wire-host.test.ts` as listed in
  step 4. Tests 1 and 4 are the regressions this plan exists to prevent; tests
  3 and 5 are the "did I break the product" guards.
- Structural pattern: the existing tests in `tests/integration/wire-host.test.ts`.
- `tests/integration/community-hosting.test.ts` is the broader integration
  check — it exercises claim, share, and access flows through this same host.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0, including both wire integration suites
- [ ] `grep -n 'x-forwarded-for' packages/wire/src/host.ts` shows the header
      used only under an explicit trusted-proxy hop count, never as the
      first-element default
- [ ] Test 4 fails when the limiter is reverted to the header-keyed version
      (verify explicitly, then restore)
- [ ] Every `Response` construction in `packages/wire/src/host.ts` carries
      `x-content-type-options: nosniff`
- [ ] The raw-bytes path declares a `content-type`
- [ ] `deploy/README.md` documents the trusted-proxy setting
- [ ] `deploy/Caddyfile` is unmodified
- [ ] `git status --short` shows no modified files outside the In-scope list
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `server.requestIP(request)` is unavailable or returns null in the test
  environment — report what Bun's API offers in the installed version rather
  than falling back to the spoofable header.
- The CSP from step 1 breaks the link-access bootstrap page and you cannot find
  a policy that both restricts content and permits that page's inline script.
  Report it; shipping without CSP is acceptable if the other headers land.
- Adding `content-disposition: attachment` breaks an existing test that expects
  inline rendering of a non-Markdown file — that would mean inline serving is
  intentional for some type, and the allowlist needs widening deliberately.
- Any change appears to require touching `packages/wire/src/authority.ts`.

## Maintenance notes

- The allowlist in step 2 is a security boundary, not a convenience feature.
  Adding a type to it means asserting that browsers cannot be made to execute
  it. `.svg` and `.html` must never be on it. `.pdf` is borderline — leave it
  off.
- The trusted-proxy hop count must be kept in sync with the actual deployment
  topology. If a second proxy is ever added in front of Caddy, the count
  changes; if it is not updated, the limiter becomes spoofable again.
- A reviewer should check step 3 hardest: confirm the code never reads the
  *first* element of `x-forwarded-for`, under any configuration.
- Deliberately deferred, and worth their own plans: per-tree byte quotas on
  push (the count-based limit does not bound disk); the object-readability
  check at `packages/wire/src/authority.ts:745` scanning every tree's graph on
  an unauthenticated route; and HTTP status codes derived by regex-matching
  English error text at `packages/wire/src/host.ts:382`, which silently
  reclassifies an authorization denial as a 400 whenever an error message is
  reworded.
