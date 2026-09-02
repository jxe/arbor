# Arbor reference implementation

This document records replaceable architecture and operating choices in the current reference implementation. It is informative. The normative contracts live in [spec.md](../spec.md).

## Reference documentation

- [Local system](local-system.md) — data home, private state, watchers, visits, recovery, credentials, and migration.
- [Arbor Sync API](arborsync-api.md) — the reference loopback REST v1 client/daemon boundary.
- [CLI](cli.md) — the current `arbor` command surface.
- [Client](client.md) — Arbor web and native interaction, navigation, and editing behavior.
- [Executable runtime](executable-runtime.md) — compiler, generated types, store observation, workers, and hosting mechanics.

## Repository and runtimes

The reference implementation is a Bun/TypeScript workspace. Major packages separate core logical/protocol types, provider-owned filesystem documents and mutation, local arborsync HTTP service, stores and private state, shared wire objects/protocol/client code, Canopy server behavior, CLI, server rendering, and the Arbor web React application. `@arbor/wire` has no server or database dependency; the single-process `@arbor/canopy` package depends on it and owns hosting, accepted-update storage, access, claims, and merging. Inside the arborsync daemon, the read-only `system:` tree projection (`system-tree.ts`), account claim and pairing bootstrap (`account-bootstrap.ts`), and generated tree type declarations (`generated-types.ts`) are separate modules behind the daemon's public methods.

The Apple reference client is a Foundation-only Swift 6 package under `native/Packages/ArborClient`. Native Arbor and Hunch integrate that package without making SwiftUI, Clamshell, actor structure, `URLSession`, or package paths part of REST v1.

Arbor web uses React and BlockNote. Markdown remains canonical: arborsync returns complete operational directory source, BlockNote edits a server-derived block view, and the browser serializes exact/block-granular source for every content write. Child-link reorder is a source write; physical moves remain structural.

The shared public data boundary is capability-based `NodeSnapshot`,
`NodeSummary`, and `ChildrenPage`. Managed and untracked filesystem adapters
delegate expanded directories, Markdown records, CSV/JSON/JSONL rollups, and
SQLite table/row subtrees through one `NodeProviderRouter`; there is no collection
page or private parallel node ontology. Representation loaders remain private
store records.

Compiler isolation, generated declarations, store observation, and hosting mechanics are documented in [the executable runtime](executable-runtime.md).

## Durability and observation

The local implementation uses a private intent journal, recovery bookkeeping, filesystem observation, and a 1,024-event in-memory SSE replay buffer. Completed mutation identities currently remain available indefinitely through the existing journal. A daemon restart changes the event epoch and clients resynchronize.

Current private paths include `workspaces.json`, per-workspace directories under `workspaces/<stateID>/`, `journal/` and `journal/mutations/`, `index.sqlite`, `types/tree.gen.d.ts`, safe system records under `system/`, and platform credential-store references. These names are documented for maintainers and migration tooling only. Other implementations may choose a different layout, and ordinary clients must not depend on it.

The exact journal records, replay-window size, retry count, temporary filenames, watcher classifications, recovery database schema, and credential reference layout are tuning/implementation choices. They must still satisfy durable acknowledgement, idempotent retry, lossless resync, secrecy, and last-valid control-file behavior.

The synchronized [`trees.yaml`](../spec/05-accounts-and-devices.md#3-configuration-yaml) contract is normative. `${ARBOR_DATA_HOME:-~/.arbor}`, private paths, and platform credential storage are reference choices documented in [the local system](local-system.md).

## Wire encoding, reconciliation, and hosting

The canonical CBOR codec and `canonicalCBORHash` live in `@arbor/core`; the TypeScript wire package implements the object model, SHA-256 addressing, strict update JSON/base64, canonical semantic request identity, shared result types, and the Wire client, while filesystem snapshots and materialization live in `@arbor/fs`. Any use of JavaScript `localeCompare`, platform enumeration order, or noncanonical CBOR would be a conformance bug; the wire requires lexicographic UTF-8 entry ordering.

The server-only Canopy package implements access and claims, public HTTP projection, graph validation, accepted-update reconciliation, the sole three-way merge engine, and private storage. Update handling is separated into small decision, reconciliation, merge, and transactional store modules even though they run in one process. Table definitions, the schema version stamp, and the startup schema assertion live in a separate `schema.ts` module that opens the database. Canopy's validation profile bounds one exact file rollup to 16 MiB, `schema.ts` to 1 MiB, and the normalized row set to 100,000 rows. Canopy retains every accepted root and its reachable objects indefinitely. Accepted history is internal: the HTTP surface exposes neither an accepted-history collection nor non-current objects, including to writers.

Wire directory objects can reference exact CSV/JSON/JSONL rollup and schema
objects. Canopy validates those graphs, merges disjoint rows by stable identity,
and projects logical rows at ordinary public HTML/Markdown locators while
keeping `_store.*` and `schema.ts` out of child navigation. The Swift replica
currently preserves these objects losslessly but does not project their rows
while fully offline.

For a state-changing update, Canopy canonicalizes the semantic value `{ version: "updates-v1", tree, base, candidate, ifMatch, onConflict }`, with `onConflict` at its effective value ([synchronization §3](../spec/02-synchronization.md#3-updating-a-tree)), and hashes its canonical CBOR encoding with SHA-256, the same encoding and hash rule that addresses wire objects. The successful accepted row stores that digest for replay. Supplied object envelopes are transport aids and do not change identity; `current` and conflict outcomes remain stateless. Rejected candidates and complete conflict drafts are returned to and retained by the client, not stored as Canopy history.

The reference `canopyd` can run locally or behind a deployment provider. Provider environment detection, volume paths, Railway/Hetzner recipes, bootstrap migration variables, credential rotation, backup/restore commands, and operator reset procedures belong in deployment documentation, not the CLI or wire spec.

## Client mechanics

The TypeScript and Swift clients are hand-maintained against common fixtures. Their local arborsync REST clients currently allow three total attempts for an ambiguous mutation outcome, prepare a mutation once, and reuse its exact bytes and mutation ID. They also expose observation helpers that buffer from a snapshot cursor before draining child pages. The Swift client uses actors and `AsyncThrowingStream`; the TypeScript client supplies the browser-facing wrapper.

Server updates are a separate retry domain. They carry an accepted base, candidate root, and immutable-object envelope, with no caller-generated mutation or idempotency ID. Arbor Sync durably retains that semantic intent across retry and restart. The Swift Wire client prepares one exact JSON body and currently makes at most three transport attempts; the TypeScript wire client performs one HTTP submission while arborsync owns scheduling and retry. Arbor Sync keeps one Wire watch open per shared placement: a `tree.ref` batch that chains from the local accepted base is applied from its object deltas without contacting the server, anything else falls through to the ordinary reconciliation pass, and a periodic fallback pass covers only a disconnected watch. In both cases, changing the object-envelope order or omitting an already-held object does not change the server-derived request identity.

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

These commands and current test counts are implementation evidence, not requirements imposed on independent Arbor implementations. Language-neutral vectors under [`conformance`](../conformance) are the portable part; reference API and algorithm fixtures live under [`tests/fixtures`](../tests/fixtures).
