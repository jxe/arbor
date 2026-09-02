# @arbor/wire

Shared Arbor server protocol and replica support. This package defines immutable wire objects, update JSON/types/identity, and the TypeScript Wire client. It must not depend on the server implementation, SQLite, server history, access internals, or the merge engine.

The `updates/` directory is the complete public update boundary:

- `types.ts` — request, result, conflict, access, pairing, and accepted-update values;
- `json.ts` — strict JSON/base64 transport encoding and decoding;
- `intent.ts` — the canonical CBOR semantic intent and its derived request digest.

Server-only behavior belongs in `@arbor/canopy`.
