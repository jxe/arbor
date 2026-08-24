# Plan 013: Build the Swift ArborWire package

> **Executor instructions**: Implement an independent Foundation-only wire client from shared fixtures. Do not copy TypeScript implementation details, add SwiftUI/Keychain UI, or build a local replica. Run live behavior only against a temporary local authority.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- native/Packages spec/fixtures spec/wire.md packages/wire tests/protocol package.json`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 007, 008, and 010
- **Category**: protocol/client
- **Planned at**: Arbor `dc34126`, 2026-08-23

## Why this matters

The iOS replica needs direct `updates-v1` access without importing Bun, arbord, SwiftUI, Hunch, or the server's merge implementation. Independent decoding against shared exact fixtures is the conformance proof; translating TypeScript types informally would leave the highest-risk sync boundary unverified.

## Current state

- `native/Packages/ArborClient` implements arbord REST JSON/SSE and now also carries the initial Foundation-only `ArborAuthorityClient` compatibility surface for refs, objects, accepted updates, complete conflicts, and pairing/devices. Keep that public surface working.
- No Swift canonical CBOR implementation, strict returned-graph validator, or authority watch parser exists yet.
- Plan 007 owns exact file/directory object and sync-result fixtures; Plan 010 owns pairing/device HTTP shapes.

## Package boundary

Create `native/Packages/ArborWire` as the independent implementation behind the accepted authority surface, preserving or forwarding the existing `ArborAuthorityClient` API while adopters migrate, with:

- deterministic CBOR file/directory encode/decode and object hashing;
- discovery, descriptor/ref, object, accepted-update submission, watch, accepted-history, typed immediate conflict, pairing claim, and device list/revoke client APIs;
- exact serialized request retry for ambiguous sync outcomes;
- injected credential provider; app/Keychain ownership stays outside the package.

The decoder rejects noncanonical maps, duplicate keys/names, invalid UTF-8/hashes, unknown required object types, wrong root kinds, cycles, malformed result references, and malformed SSE. It rehashes exact bytes and validates graph shape before trusting current, merged, or draft contents.

## Scope

**In scope**: standalone package, shared fixture loader, protocol/client tests, root conformance hook.

**Out of scope**: SwiftUI, QR scanning, Keychain implementation, materialized trees, merge, search/indexing, Quagmire, ArborClient redesign.

## Steps

1. Create the Swift package targeting iOS/macOS 27 with no third-party dependency unless a reviewed dependency demonstrably enforces Arbor's deterministic CBOR subset.
2. Implement narrow canonical CBOR primitives required by fixtures and exact object hashing.
3. Model `updates-v1` current/accepted/merged/conflict results, opaque acceptance/watch cursors, accepted-history records, stable conflict reasons, and device/pairing responses with strict required fields and forward-compatible descriptive fields.
4. Implement URLSession requests, exact successful-outcome replay, history pagination, complete immediate conflict-draft decoding, and byte-level LF/CRLF SSE framing. The package must not interpret or reproduce merge policy; conflicts have no server resource to fetch later.
5. Consume every shared valid/invalid object and protocol fixture. Add a local authority harness for create/sync/watch/history/conflict-draft/pairing/revoke.
6. Extend `bun run test:protocol` or a new unified command to run both TypeScript and Swift wire conformance.

## Verification

```sh
swift test --package-path native/Packages/ArborWire
bun run test:sync-merge
bun run test:protocol
git diff --check
```

Expected: Swift re-encodes every valid file/directory object byte-identically, decodes every sync outcome, validates returned graphs/drafts, rejects every invalid fixture, and contains no Markdown/tree merge implementation; local live tests pass; package imports only Foundation/system modules.

## STOP conditions

- One canonical file/directory byte/hash differs from TypeScript.
- Consuming a sync result would require Swift to reproduce the server merge algorithm.
- A dependency accepts encodings Arbor must reject.
- SSE correctness would rely on line APIs that lose blank frame separators.
- Pairing secrets would enter ordinary Arbor URLs or logs.

## Maintenance note

ArborWire is wire-authority transport; ArborClient remains arbord REST. Do not merge them merely because both use URLSession.
