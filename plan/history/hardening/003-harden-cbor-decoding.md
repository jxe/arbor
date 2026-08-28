# Plan 003: Harden the CBOR decoder against hostile wire bytes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plan/history/hardening/README.md`.
>
> **Drift check (run first)**: `git diff --stat 4247481..HEAD -- packages/wire/src/cbor.ts packages/wire/src/objects.ts`
> Also run `git status --short` on those paths — the working tree was already
> dirty when this plan was written. If the excerpts under "Current state" do
> not match the live code, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `4247481`, 2026-07-31
- **Completed**: 2026-08-24 as part of native Plan 013 conformance work

## Why this matters

`decodeCBOR` is the first code to touch bytes that arrive from a remote peer:
the wire host runs it on every pushed object, and the wire client runs it on
every object fetched from a server. It currently has three gaps.

1. Map entries are assigned onto a plain `{}`, so a `__proto__` key replaces
   the decoded object's prototype with attacker-supplied data instead of
   becoming an own property. `decodeWireObject` then reads `record.type` and
   `record.bytes` with ordinary property access, which cannot distinguish an
   inherited property from an own one — and its result drives filesystem
   materialization.
2. `decodeAt` recurses into arrays and maps with no depth limit, so a deeply
   nested graph overflows the stack inside the request handler. On the
   community host that is an unauthenticated single-request crash.
3. Duplicate map keys are accepted last-wins, and keys in non-canonical order
   are accepted. The *encoder* in this same file is scrupulously canonical
   (length-then-bytewise ordering), so the decoder should reject what the
   encoder would never produce — content addressing depends on exactly one
   byte sequence decoding to a given value.

None of this is currently known to be exploitable end to end — `validateGraph`
re-hashes every object, which limits the blast radius. But the decoder is the
component that should be most defensive in the package, and today it is the
least.

## Current state

Files involved:

- `packages/wire/src/cbor.ts` — canonical CBOR encoder and decoder.
- `packages/wire/src/objects.ts` — `decodeWireObject` consumes decoded maps.
- `packages/wire/src/host.ts` — calls the decoder on unauthenticated input.

The map branch of the decoder, `packages/wire/src/cbor.ts:122-133`:

```ts
  if (major === 5) {
    const result: Record<string, unknown> = {};
    let offset = length.offset;
    for (let index = 0; index < length.value; index += 1) {
      const key = decodeAt(bytes, offset);
      const item = decodeAt(bytes, key.offset);
      if (typeof key.value !== "string") throw new Error("Arbor CBOR map keys must be strings");
      result[key.value] = item.value;
      offset = item.offset;
    }
    return { value: result, offset };
  }
  throw new Error(`Unsupported CBOR major type ${major}`);
}
```

The array branch immediately above it, `packages/wire/src/cbor.ts:111-119`:

```ts
  if (major === 4) {
    const result: unknown[] = [];
    let offset = length.offset;
    for (let index = 0; index < length.value; index += 1) {
      const item = decodeAt(bytes, offset);
      result.push(item.value);
      offset = item.offset;
    }
    return { value: result, offset };
  }
```

The public entry point, `packages/wire/src/cbor.ts:136-140`:

```ts
export function decodeCBOR(bytes: Uint8Array): unknown {
  const decoded = decodeAt(bytes, 0);
  if (decoded.offset !== bytes.length) throw new Error("Trailing CBOR bytes");
  return decoded.value;
```

The encoder's canonical map-key ordering lives at
`packages/wire/src/cbor.ts:26-33` and `:57-64` — it sorts keys by UTF-8 byte
length first, then bytewise (`compareBytes`). That is the ordering the decoder
must enforce. Read those lines before writing step 3.

The consumer, `packages/wire/src/objects.ts:47-52` (`decodeWireObject`), reads
`record.type` / `record.bytes` / `record.entries` off the decoded value with
plain property access.

Repo conventions:

- Errors here are thrown as plain `Error` with a short sentence, e.g.
  `throw new Error("Trailing CBOR bytes")`. Match that style; do not introduce
  a new error class in this plan.
- Wire unit tests live in `tests/unit/wire.test.ts`, using `bun:test` with
  `describe`/`test`/`expect`. That file is your structural exemplar — read it
  before writing tests; it already imports from the `@arbor/wire` package entry
  rather than by relative path.

## Commands you will need

| Purpose      | Command                                        | Expected on success             |
|--------------|------------------------------------------------|---------------------------------|
| Typecheck    | `bun run typecheck`                            | exit 0, no output               |
| Tests        | `bun test`                                     | all pass (155 before this plan) |
| Wire unit    | `bun test tests/unit/wire.test.ts`             | all pass                        |
| Wire integ.  | `bun test tests/integration/wire-host.test.ts` | all pass                        |

## Scope

**In scope**:

- `packages/wire/src/cbor.ts`
- `tests/unit/wire.test.ts` (add tests)

**Out of scope** (do NOT touch):

- `packages/wire/src/objects.ts` — `decodeWireObject`'s validation is the
  subject of separate work; hardening the decoder is sufficient here and
  keeps the diff reviewable.
- `packages/canopy/src/canopy.ts` — `validateGraph`'s checks stay as they are.
- The **encoder** functions in `cbor.ts`. Changing encoding changes every
  object hash in existence. This plan is decode-side only.
- `packages/wire/src/host.ts` — rate limiting and response headers are
  `plan/unverified/001-ci.md`.

## Git workflow

- Branch: `advisor/003-harden-cbor-decoding`
- Commit message style from `git log`: short imperative sentence, no prefix.
  Example: `Reject non-canonical and prototype-polluting CBOR maps`.
- Do NOT push or open a PR.

## Steps

### Step 1: Reproduce the two decoder behaviors

Run this to confirm the starting state:

```bash
bun -e 'import { decodeCBOR, encodeCanonicalCBOR } from "./packages/wire/src/cbor.ts"; const proto = new Uint8Array([0xa1, 0x69, 0x5f, 0x5f, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x5f, 0x5f, 0xa1, 0x64, 0x74, 0x79, 0x70, 0x65, 0x64, 0x66, 0x69, 0x6c, 0x65]); const out = decodeCBOR(proto); console.log("own props:", Object.getOwnPropertyNames(out)); console.log("inherited type:", out.type); const dup = new Uint8Array([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]); console.log("duplicate key:", JSON.stringify(decodeCBOR(dup)));'
```

Expected before the fix: `own props: []`, `inherited type: file`, and
`duplicate key: {"a":2}`.

If the script throws instead, the decoder already rejects these — STOP and
report, since the plan's premise no longer holds.

### Step 2: Build maps without a prototype and reject duplicate keys

In the `major === 5` branch of `packages/wire/src/cbor.ts`:

- Replace `const result: Record<string, unknown> = {};` with a null-prototype
  object: `const result: Record<string, unknown> = Object.create(null);`
- Before assigning, reject a repeated key:
  `if (key.value in result) throw new Error("Duplicate CBOR map key");`
  (With a null-prototype object, `in` is safe — there are no inherited keys to
  collide with.)

**Verify**: re-run the step 1 script. Expected now: the first `decodeCBOR` call
either throws or returns an object whose `own props` is `["__proto__"]` and
whose prototype is unchanged; the duplicate-key call throws
`Duplicate CBOR map key`.

**Verify**: `bun test tests/unit/wire.test.ts` → all pass. If a test fails
because `expect(...).toEqual({...})` no longer matches a null-prototype object,
that is a real interaction — see the STOP conditions before adjusting the test.

### Step 3: Enforce canonical key ordering

Still in the `major === 5` branch, track the previous key's UTF-8 bytes and
require each subsequent key to sort strictly after it, using the same ordering
the encoder produces: shorter UTF-8 byte length first, then bytewise
comparison. Reuse the encoder's existing `compareBytes` helper (defined near
`packages/wire/src/cbor.ts:26-33`) rather than writing a second comparator; if
it is not exported within the module scope, use it directly since it is in the
same file.

Throw `new Error("Non-canonical CBOR map key order")` on violation.

**Verify**: `bun test tests/unit/wire.test.ts` → all pass. The existing test
`encodes maps deterministically and hashes exact DAG-CBOR bytes` round-trips
encoder output through the decoder, so it proves the encoder's ordering
satisfies the new check.

### Step 4: Bound recursion depth

Add a depth parameter to `decodeAt` with a modest ceiling — 64 is ample for
Arbor's object shapes (a wire object is a map of scalars, or a map containing
one array of small maps). Increment on entry to the array and map branches;
throw `new Error("CBOR nesting too deep")` past the ceiling.

Keep `decodeCBOR`'s public signature unchanged: it calls `decodeAt(bytes, 0)`
with the depth defaulted.

**Verify**:

```bash
bun -e 'import { decodeCBOR } from "./packages/wire/src/cbor.ts"; let bytes = new Uint8Array([0x01]); for (let i = 0; i < 200; i += 1) { const next = new Uint8Array(bytes.length + 1); next[0] = 0x81; next.set(bytes, 1); bytes = next; } try { decodeCBOR(bytes); console.log("NO ERROR - depth limit missing"); } catch (e) { console.log("threw:", e.message); }'
```

Expected: `threw: CBOR nesting too deep` (not a `RangeError` about stack size).

### Step 5: Add unit tests

Add a `describe` block to `tests/unit/wire.test.ts` — follow the existing file's
import style (`from "@arbor/wire"`); if `decodeCBOR` is not exported from the
package entry, import it from the module path used elsewhere in that file and
note which you used.

Cover four cases:

1. A map with a `__proto__` key does not alter the decoded object's prototype
   (assert `Object.getPrototypeOf(decoded)` is `null`, and that a plain
   property lookup for an unset key returns `undefined`).
2. Duplicate map keys throw.
3. Non-canonically ordered map keys throw.
4. Deeply nested input throws the depth error rather than a `RangeError`.

Plus one positive control: `decodeCBOR(encodeCanonicalCBOR(value))` round-trips
a representative nested value unchanged, proving the new checks do not reject
legitimate encoder output.

**Verify**: `bun test tests/unit/wire.test.ts` → all pass, 5 new tests.

### Step 6: Full gate

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test` → all pass.

## Test plan

- Five new tests in `tests/unit/wire.test.ts` as listed in step 5.
- Structural pattern: the existing `describe("canonical tree objects", ...)`
  block in the same file.
- The positive-control round-trip is the one that protects against
  over-rejection; do not skip it.
- `tests/integration/wire-host.test.ts` and
  `tests/integration/community-hosting.test.ts` exercise real push/fetch paths
  through this decoder. Both must still pass — that is the practical proof the
  hardening did not break the live protocol.

## Done criteria

Final status: complete. The TypeScript decoder now uses null-prototype maps, rejects duplicate and noncanonical keys, enforces minimal lengths and a depth ceiling, and validates strict UTF-8. Plan 013 also closed the separately noted wire-object validation gap against shared invalid fixtures.

ALL must hold:

- [x] `bun run typecheck` exits 0
- [x] `bun test` exits 0, including `tests/integration/wire-host.test.ts` and
      `tests/integration/community-hosting.test.ts`
- [x] The step 1 reproduction script now throws or shows an unpolluted
      prototype, and the duplicate-key case throws
- [x] The step 4 depth script prints `threw: CBOR nesting too deep`
- [x] `grep -n "Object.create(null)" packages/wire/src/cbor.ts` returns a match
- [x] No encoder function in `packages/wire/src/cbor.ts` was modified
      (`git diff packages/wire/src/cbor.ts` touches only the decode path)
- [x] The broader files are the explicitly reconciled Plan 013 implementation,
      which also closes the deferred strict wire-object gap.
- [x] `plan/history/hardening/README.md` records completed historical plan 003

## STOP conditions

Stop and report back if:

- The step 1 script throws before any change is made.
- Any existing test fails after step 2 for a reason other than
  `toEqual` prototype strictness. If it *is* prototype strictness (bun's
  `toEqual` comparing a null-prototype object against an object literal), you
  may adjust that single assertion to compare own properties — but say so
  explicitly in your report.
- Enforcing canonical key order (step 3) causes
  `tests/integration/community-hosting.test.ts` to fail, which would mean some
  producer in this repo emits non-canonical maps. Do not relax the check to
  make it pass; report which producer it is.
- You find yourself needing to change `encodeCanonicalCBOR` or `hashObject`.

## Maintenance notes

- The decoder is now stricter than the CBOR specification in one respect: it
  rejects valid-but-non-canonical input. That is deliberate — Arbor's content
  addressing means exactly one byte sequence should decode to a given value. If
  a future interop requirement demands lenient decoding, it needs a separate
  lenient entry point, not a relaxation of this one.
- The depth ceiling of 64 is a policy choice. If a legitimate object shape ever
  approaches it, raise it deliberately rather than removing the check.
- A reviewer should confirm the diff touches only `decodeAt` and its helpers,
  never the encoder.
- Deliberately deferred: `decodeWireObject` in `packages/wire/src/objects.ts`
  still accepts directory entry names like `""`, `"."`, and `".."` — the
  server-side invariant lives in `validateGraph` and is not on the client read
  path. That is a real gap and worth its own plan; it is not fixed here.
