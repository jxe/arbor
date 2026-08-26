# Plan 005: Decode percent-encoding once, at the HTTP boundary

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plan/hardening/README.md`.
>
> **Drift check (run first)**: `git diff --stat 4247481..HEAD -- packages/core/src/logical-path.ts packages/core/src/logical-url.ts packages/arborsync/src/server.ts packages/fs/src/workspace-fs.ts`
> Also run `git status --short` on those paths. If the excerpts under "Current
> state" do not match the live code, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — path handling is load-bearing for both correctness and the
  traversal-rejection security property. Read the whole plan before starting.
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `4247481`, 2026-07-31

## Why this matters

`normalizeTreePath` percent-decodes its input, but it is called with **logical
paths**, not URLs — and it is called after the HTTP layer has already decoded
once. Two things follow.

A file whose name contains `%` breaks. Verified by running the real function:
`canonicalNodePath("/Q3 100%.md")` throws `URIError`. That makes the file's
parent directory 500 in a tracked tree (the call at
`packages/fs/src/workspace-fs.ts:405` sits outside the surrounding try/catch),
while in the local scope the same file is silently dropped from the listing
instead. Names like `50% off.md` are ordinary in real notes.

Worse, decoding is not idempotent in a way that preserves identity:
`canonicalNodePath("/a%2Fb.md")` returns `/a/b` — a single file is
reinterpreted as a two-segment path, so two distinct files can collide on one
logical identity.

The traversal check is not currently defeated, because it runs after the final
decode. But that safety rests entirely on call ordering. The invariant "a path
is decoded exactly once, at the boundary" is what makes the check sound, and
today that invariant is violated in at least two places. This plan restores it.

## Current state

Files involved:

- `packages/core/src/logical-path.ts` — `normalizeTreePath` / `canonicalNodePath`; the decode to remove.
- `packages/core/src/logical-url.ts` — resolves authored links; calls the above.
- `packages/arborsync/src/server.ts` — HTTP boundary; already decodes before calling in.
- `packages/fs/src/workspace-fs.ts` — directory listing; the 500 site.
- `packages/arborsync/src/fs-service.ts` — local-scope listing; the silent-drop site.

`packages/core/src/logical-path.ts:1-19`:

```ts
export class PathEscapeError extends Error {}

export function normalizeTreePath(input: string): string {
  const decoded = decodeURIComponent(input || "/").replaceAll("\\", "/");
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new PathEscapeError(`Unsafe workspace path: ${input}`);
  }
  return `/${parts.join("/")}`;
}

/** Canonical browser/API identity for x.md, x/, or x/_index.md. */
export function canonicalNodePath(input: string): string {
  const path = normalizeTreePath(input);
  if (path === "/_index.md") return "/";
  if (path.endsWith("/_index.md")) return path.slice(0, -"/_index.md".length) || "/";
  if (path.endsWith(".md")) return path.slice(0, -3) || "/";
  return path;
}
```

The directory listing that throws, `packages/fs/src/workspace-fs.ts:400-406`:

```ts
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || RESERVED.has(entry.name) || isTransactionTemporary(entry.name)) continue;
      const logicalName = iCloudPlaceholderLogicalName(entry.name) ?? entry.name;
      const physical = `${node.path === "/" ? "" : node.path}/${logicalName}`;
      paths.add(logicalName.endsWith(".md") ? canonicalNodePath(physical) : normalizeTreePath(physical));
    }
```

Note the `try` that follows is around `this.resolve(path)` on the next lines —
the `paths.add(...)` above it is unprotected. Here `entry.name` comes from
`readdir`: it is a real on-disk filename, never percent-encoded, so decoding it
is unambiguously wrong.

The HTTP boundary that already decodes, `packages/arborsync/src/server.ts:509`:

```ts
        let surface = await service.fileSurface(decodeURIComponent(logicalPath), raw).catch(() => null);
```

and the referer-derived path just below it, `packages/arborsync/src/server.ts:515-521`:

```ts
          const referer = request.headers.get("referer");
          const refererPath = referer ? new URL(referer).pathname.replace(/^\/render(?=\/|$)/, "") : null;
          if (refererPath?.startsWith("/")) {
            surface = await service.fileSurfaceInScopeOf(
              decodeURIComponent(refererPath),
              decodeURIComponent(logicalPath),
              raw,
```

**The security property that must survive.** `tests/unit/path.test.ts:22` asserts
that a percent-encoded traversal attempt (`%2e%2e`) is rejected. It passes today
*because* `normalizeTreePath` decodes. Once the decode moves out, that
rejection has to happen at the boundary instead — otherwise this plan trades a
correctness bug for a security regression. Step 3 exists specifically to keep
that test meaningful.

Repo conventions:

- `packages/core` is the browser-safe shared layer; the Swift client mirrors it
  (`native/Packages/ArborClient`). Prefer keeping `normalizeTreePath`'s exported
  signature unchanged.
- Unit tests: `tests/unit/path.test.ts` and `tests/unit/logical-url.test.ts` are
  the existing exemplars for this area. `bun:test`, plain function calls.

## Commands you will need

| Purpose      | Command                                          | Expected on success             |
|--------------|--------------------------------------------------|---------------------------------|
| Typecheck    | `bun run typecheck`                              | exit 0, no output               |
| Tests        | `bun test`                                       | all pass (155 before this plan) |
| Path unit    | `bun test tests/unit/path.test.ts`               | all pass                        |
| URL unit     | `bun test tests/unit/logical-url.test.ts`        | all pass                        |
| Server integ.| `bun test tests/integration/server.test.ts`      | all pass                        |
| Protocol     | `bun run test:protocol`                          | exit 0 (needs a Swift toolchain — skip and say so if absent) |

## Scope

**In scope**:

- `packages/core/src/logical-path.ts`
- `packages/core/src/logical-url.ts` (only if it double-decodes — see step 2)
- `packages/arborsync/src/server.ts` (boundary decode + `URIError` handling)
- `tests/unit/path.test.ts` (add cases)
- `tests/integration/server.test.ts` (add a case)

**Out of scope** (do NOT touch):

- `packages/fs/src/workspace-fs.ts` and `packages/arborsync/src/fs-service.ts` —
  once `normalizeTreePath` stops decoding, their calls become correct as
  written. Do not "also fix" the try/catch asymmetry between them here; note
  it in your report instead.
- `native/` — the Swift mirror of this logic. If the TypeScript contract
  changes in a way Swift must follow, report it; do not edit Swift in this plan.
- `packages/render/src/App.tsx` — the client also builds URLs; leave it unless
  typecheck forces a change, and report it if it does.

## Git workflow

- Branch: `advisor/005-decode-paths-once`
- Commit message style from `git log`: short imperative sentence, no prefix.
  Example: `Decode logical paths once, at the HTTP boundary`.
- Commit per step where the tree is green; steps 1–3 should land together since
  the tree is inconsistent between them.
- Do NOT push or open a PR.

## Steps

### Step 1: Reproduce both defects

```bash
bun -e 'import { canonicalNodePath } from "./packages/core/src/logical-path.ts"; try { console.log("100%:", canonicalNodePath("/Q3 100%.md")); } catch (e) { console.log("100% THROWS:", e.constructor.name); } console.log("a%2Fb.md ->", canonicalNodePath("/a%2Fb.md"));'
```

Expected before the fix: `100% THROWS: URIError` and `a%2Fb.md -> /a/b`.

If both lines already behave correctly (`/Q3 100%` and `/a%2Fb`), the fix has
been applied already — STOP and report.

### Step 2: Remove the decode from `normalizeTreePath`

In `packages/core/src/logical-path.ts`, drop the `decodeURIComponent(...)` call.
The first line becomes:

```ts
  const decoded = (input || "/").replaceAll("\\", "/");
```

Rename the local if you like (`normalized` reads better now), but keep the
exported function names and signatures unchanged.

Update the doc comment on `normalizeTreePath` to state the new contract
explicitly — one sentence, in the repo's voice, e.g.:
`/** Normalizes an already-decoded logical path. Callers decode percent-encoding at the HTTP boundary. */`
This contract line is the whole point of the change; do not skip it.

Then check `packages/core/src/logical-url.ts` for its own `decodeURIComponent`
calls (`grep -n "decodeURIComponent" packages/core/src/logical-url.ts`). If it
decodes a path *before* passing it to `normalizeTreePath`/`canonicalNodePath`,
that decode is now the single one for that path and should stay. If it decodes
and the value also flows through the server's boundary decode, remove the inner
one. Reason it through per call site; there are only a few.

**Verify**: re-run the step 1 script. Expected: `100%: /Q3 100%` and
`a%2Fb.md -> /a%2Fb`.

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test tests/unit/path.test.ts` → the `%2e%2e` traversal test
now FAILS (the encoded traversal is no longer decoded into `..`). This failure
is expected and is fixed in step 3.

### Step 3: Move traversal rejection to the boundary

The security property from `tests/unit/path.test.ts:22` must still hold for
requests arriving over HTTP.

In `packages/arborsync/src/server.ts`, the decode at `:509` and the two at
`:518-520` are the boundary. Introduce a single helper in that file, e.g.:

```ts
function decodeRequestPath(value: string): string { ... }
```

It must:

- `decodeURIComponent` the value.
- Catch `URIError` and throw the existing `ProtocolError` with code
  `"unsafe-path"` and status **400** — match how `assertSameOrigin` at
  `packages/arborsync/src/server.ts:38-44` constructs a `ProtocolError`, so the
  error flows through the same envelope. A malformed encoding currently falls
  through to a generic 500; 400 is correct.
- Feed the decoded result through `normalizeTreePath` so traversal is rejected
  once, at the boundary, on the decoded value. `normalizeTreePath` throws
  `PathEscapeError`; confirm the server already maps that to a 400 response
  (`grep -n "PathEscapeError" packages/arborsync/src/server.ts`) and if it does
  not, map it the same way as `ProtocolError` with `"unsafe-path"`.

Replace all three `decodeURIComponent(...)` call sites at `:509` and `:518-520`
with this helper. Also guard the `new URL(referer)` call at `:516` — a
malformed `Referer` header currently throws out to the generic 500 handler;
wrap it so a bad referer simply yields `null`.

Then update `tests/unit/path.test.ts`: the `%2e%2e` case now belongs at the
boundary, not in `normalizeTreePath`. Change that unit test to assert the new
contract — `normalizeTreePath("/%2e%2e/x")` returns the literal `/%2e%2e/x`
(a file legitimately named `%2e%2e` is not traversal) — and add the traversal
assertion to the integration layer in step 5. Do not simply delete the case.

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test tests/unit/path.test.ts` → all pass.

### Step 4: Add unit cases for percent-bearing names

In `tests/unit/path.test.ts`, add:

1. `canonicalNodePath("/Q3 100%.md")` → `/Q3 100%` (does not throw).
2. `canonicalNodePath("/a%2Fb.md")` → `/a%2Fb` (stays one segment).
3. `normalizeTreePath("/../x")` still throws `PathEscapeError` (literal `..`
   rejection is unaffected).
4. `normalizeTreePath("/a\0b")` still throws `PathEscapeError`.

**Verify**: `bun test tests/unit/path.test.ts` → all pass.

### Step 5: Add an end-to-end test through the server

In `tests/integration/server.test.ts`, add two cases. Read the file's existing
setup first — it starts a real arborsync and issues `fetch` calls; follow that
harness exactly rather than building a new one.

1. **The user-visible fix**: create a fixture file whose name contains `%`
   (e.g. `Q3 100%.md`), then request the parent directory's children
   (`GET /v1/children?path=...`) and assert the response is 200 and the listing
   includes that file. Before this plan that request would 500.
2. **The security property**: request a path containing an encoded traversal
   attempt (`%2e%2e`) at a mutating or file route and assert the response is
   **400** with the `unsafe-path` error code — not 200, not 500. This is the
   assertion that replaces the unit test moved in step 3; it is the most
   important test in this plan.

**Verify**: `bun test tests/integration/server.test.ts` → all pass.

### Step 6: Full gate

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test` → all pass.

**Verify**: `bun run test:protocol` → exit 0. This is the cross-language
conformance gate and it exercises path handling against the Swift client. If no
Swift toolchain is available in your environment, skip it and **say so
explicitly in your report** — do not claim it passed.

## Test plan

- Unit (`tests/unit/path.test.ts`): the four cases in step 4, plus the rewritten
  `%2e%2e` contract case from step 3.
- Integration (`tests/integration/server.test.ts`): the two cases in step 5 —
  percent-bearing filename lists successfully, and encoded traversal is
  rejected with 400.
- Regression proof: after the change, temporarily revert step 3's boundary
  rejection and confirm the step 5 traversal test FAILS. Restore it. A boundary
  check that no test exercises is the exact failure mode this plan exists to
  prevent.
- `bun run test:protocol` is the cross-language gate; run it if you can.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0
- [ ] `grep -n "decodeURIComponent" packages/core/src/logical-path.ts` returns
      no matches
- [ ] `normalizeTreePath` carries a doc comment stating it takes an
      already-decoded path
- [ ] The step 5 traversal test returns 400 with `unsafe-path`, and fails when
      the boundary check is reverted
- [ ] The step 1 script prints `/Q3 100%` and `/a%2Fb`
- [ ] `packages/fs/src/workspace-fs.ts` and `packages/arborsync/src/fs-service.ts`
      are unmodified
- [ ] `git status --short` shows no modified files outside the In-scope list
- [ ] `bun run test:protocol` passes, or its absence is reported explicitly
- [ ] `plan/hardening/README.md` status row for 005 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The step 1 script already shows correct behavior.
- After step 2, typecheck errors appear in files outside the In-scope list
  (particularly `packages/render/` or `packages/client/`) — that means another
  caller depends on the decoding behavior and the change needs re-scoping.
- You find a **third** decode of the same path on any single request path that
  you cannot confidently attribute to one boundary. Report the call chain
  rather than guessing which to remove.
- `bun run test:protocol` fails after the change — the Swift client mirrors
  this logic and a contract change may need to land on both sides together.
- Removing the decode makes any existing test fail in a way step 3 does not
  explain.

## Maintenance notes

- The new contract is: **URLs are decoded exactly once, in
  `packages/arborsync/src/server.ts`, and everything downstream of that receives
  decoded logical paths.** Any future entry point that accepts a URL-shaped
  path (a new route, a new CLI argument, a new client) must decode at its own
  boundary and must run traversal rejection there.
- `packages/core/src/logical-path.ts` is mirrored in Swift under
  `native/Packages/ArborClient`. If the Swift `normalizeTreePath` equivalent
  also decodes, it now diverges from TypeScript — flag that in your report as
  follow-up work; the conformance suite may or may not catch it.
- A reviewer should scrutinize step 3 hardest: the traversal rejection moving
  from a widely-called pure function to a single boundary helper is the risky
  part of this change. Confirm every `decodeURIComponent` in `server.ts` goes
  through the helper.
- Deliberately deferred: the inconsistency where
  `packages/fs/src/workspace-fs.ts:405` lets a path error 500 while
  `packages/arborsync/src/fs-service.ts:287` silently swallows it. Once paths stop
  throwing on `%`, this matters much less, but the two sites should eventually
  agree on a policy.
