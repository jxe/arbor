# Arbor reference implementation

This document records replaceable architecture and operating choices in the current reference implementation. It is informative. The normative contracts live in [spec.md](../spec.md).

## Repository and runtimes

The reference implementation is a Bun/TypeScript workspace. Major packages separate core logical/protocol types, provider-owned filesystem documents and mutation, local arbord HTTP service, stores and private state, shared wire objects/protocol/client code, server-only authority behavior, CLI, server rendering, and the Arbor web React application. `@arbor/wire` has no server or database dependency; the single-process `@arbor/authority` package depends on it and owns hosting, accepted-update storage, access, claims, and merging.

The Apple reference client is a Foundation-only Swift 6 package under `native/Packages/ArborClient`. Native Arbor and Hunch integrate that package without making SwiftUI, Clamshell, actor structure, `URLSession`, or package paths part of REST v1.

Arbor web uses React and BlockNote. Markdown remains canonical: arbord returns complete operational directory source, BlockNote edits a server-derived block view, and the browser serializes exact/block-granular source for every content write. Child-link reorder is a source write; physical moves remain structural.

## Sandboxes and generated files

The current schema/script direction uses isolated JavaScript workers, with QuickJS/Wasm available for deterministic evaluation. Only declared libraries such as `zod` are bundled into a schema realm. Time, stack, and memory limits and the absence of filesystem/network/process authority enforce the public store/script contracts.

Generated TypeScript declarations live with the per-workspace private state, including a tree registry at `workspaces/<stateID>/types/tree.gen.d.ts`; arbord never needs to create a generated directory inside the browsed tree. Arbor-owned TypeScript compiler and language-service hosts include that declaration as an extra root file, so scripts do not name its machine-local path or require an authored `tsconfig` change. Bundles, code hashes, validators, manifests, caches, and generated database declarations are reproducible output. Their names and locations may change without changing authored formats.

## Durability and observation

The local implementation uses a private intent journal, recovery bookkeeping, filesystem observation, and a 1,024-event in-memory SSE replay buffer. Completed mutation identities currently remain available indefinitely through the existing journal. A daemon restart changes the event epoch and clients resynchronize.

Current private paths include `workspaces.json`, per-workspace directories under `workspaces/<stateID>/`, `journal/` and `journal/mutations/`, `index.sqlite`, `types/tree.gen.d.ts`, safe system records under `system/`, and platform credential-store references. These names are documented for maintainers and migration tooling only. Other implementations may choose a different layout, and ordinary clients must not depend on it.

The exact journal records, replay-window size, retry count, temporary filenames, watcher classifications, recovery database schema, and credential reference layout are tuning/implementation choices. They must still satisfy durable acknowledgement, idempotent retry, lossless resync, secrecy, and last-valid control-file behavior.

[`trees.yaml`](../spec/system.md#placement-registry-treesyaml) and `${ARBOR_DATA_HOME:-~/.arbor}` are exceptions: their public placement/data-home contract is normative. Other files in the data home are private. Credentials use the platform credential store where available and must never be copied into `trees.yaml`.

## Wire encoding, reconciliation, and hosting

The TypeScript wire package implements deterministic CBOR objects, SHA-256 addressing, filesystem snapshots, strict update JSON/base64, canonical semantic request identity, shared result types, and the authority client. Any use of JavaScript `localeCompare`, platform enumeration order, or noncanonical CBOR would be a conformance bug; the wire requires lexicographic UTF-8 entry ordering.

The server-only authority package implements access and claims, public HTTP projection, graph validation, accepted-update reconciliation, the sole three-way merge engine, and private storage. Update handling is separated into small decision, reconciliation, merge, and transactional store modules even though they run in one process. The authority retains every accepted root and its reachable objects indefinitely. Accepted history is internal: the HTTP surface exposes neither an accepted-history collection nor non-current objects, including to writers.

For a state-changing update, the authority canonicalizes the all-string semantic value `{ base, candidate, tree, version: "updates-v1" }` and hashes its UTF-8 JSON with SHA-256. The successful accepted row stores that digest for replay. Supplied object envelopes are transport aids and do not change identity; `current` and conflict outcomes remain stateless. Rejected candidates and complete conflict drafts are returned to and retained by the client, not stored as authority history.

The reference `arbor serve` can run locally or behind a deployment provider. Provider environment detection, volume paths, Railway/Hetzner recipes, bootstrap migration variables, credential rotation, backup/restore commands, and operator reset procedures belong in deployment documentation, not the CLI or wire spec.

## Client mechanics

The TypeScript and Swift clients are hand-maintained against common fixtures. Their local arbord REST clients currently allow three total attempts for an ambiguous mutation outcome, prepare a mutation once, and reuse its exact bytes and mutation ID. They also expose observation helpers that buffer from a snapshot cursor before draining child pages. The Swift client uses actors and `AsyncThrowingStream`; the TypeScript client supplies the browser-facing wrapper.

Authority updates are a separate retry domain. They carry an accepted base, candidate root, and immutable-object envelope, with no caller-generated mutation or idempotency ID. Arbord durably retains that semantic intent across retry and restart. The Swift authority client prepares one exact JSON body and currently makes at most three transport attempts; the TypeScript wire client performs one HTTP submission while arbord owns scheduling and retry. In both cases, changing the object-envelope order or omitting an already-held object does not change the authority-derived request identity.

Exact attempt counts, backoff timing, actor/class names, and editor session coordinators are replaceable. Both clients must preserve exact accepted source, explicit tree scope, opaque PageIDs, one-pass URL decoding, unknown errors, provider-owned directory completeness, and resync-first behavior.

## Verification machinery

The repository uses Bun tests, TypeScript checking, shared JSON/SSE protocol fixtures, and Swift Package Manager tests. The usual focused gates are:

```sh
bun run typecheck
bun run test
bun run test:sync-merge
bun run test:protocol
bun run test:e2e
bun run build
git diff --check
```

These commands and current test counts are implementation evidence, not requirements imposed on independent Arbor implementations. Language-neutral vectors under [`spec/fixtures`](../spec/fixtures) are the portable part.
