# Arbor reference implementation

This document records replaceable architecture and operating choices in the current reference implementation. It is informative. The normative contracts live in [spec.md](../spec.md).

## Repository and runtimes

The reference implementation is a Bun/TypeScript workspace. Major packages separate core logical/protocol types, filesystem projection and mutation, local arbord HTTP service, stores and private state, wire authority/object handling, TypeScript client, CLI, server rendering, and the TreeHopper React application.

The Apple reference client is a Foundation-only Swift 6 package under `native/Packages/ArborClient`. Native TreeHopper and Hunch integrate that package without making SwiftUI, Clamshell, actor structure, `URLSession`, or package paths part of REST v1.

TreeHopper web uses React and BlockNote. Markdown remains canonical; BlockNote blocks and `managed:` projection rows are interactive/session values.

## Sandboxes and generated files

The current schema/script direction uses isolated JavaScript workers, with QuickJS/Wasm available for deterministic evaluation. Only declared libraries such as `zod` are bundled into a schema realm. Time, stack, and memory limits and the absence of filesystem/network/process authority enforce the public store/script contracts.

Generated TypeScript declarations may live under `.arbor`, including a tree registry such as `.arbor/tree.gen.d.ts`. Bundles, code hashes, validators, manifests, caches, and generated database declarations are reproducible output. Their names and locations may change without changing authored formats.

## Durability and observation

The local implementation uses a private intent journal, recovery bookkeeping, filesystem observation, and a 1,024-event in-memory SSE replay buffer. Completed mutation identities currently remain available indefinitely through the existing journal. A daemon restart changes the event epoch and clients resynchronize.

Current private paths include `workspaces.json`, per-workspace directories under `workspaces/<stateID>/`, `journal/` and `journal/mutations/`, `index.sqlite`, safe system records under `system/`, and platform credential-store references. These names are documented for maintainers and migration tooling only. Other implementations may choose a different layout, and ordinary clients must not depend on it.

The exact journal records, replay-window size, retry count, temporary filenames, watcher classifications, recovery database schema, and credential reference layout are tuning/implementation choices. They must still satisfy durable acknowledgement, idempotent retry, lossless resync, secrecy, and last-valid control-file behavior.

[`trees.yaml`](../spec/system.md#placement-registry-treesyaml) and `${ARBOR_DATA_HOME:-~/.arbor}` are exceptions: their public placement/data-home contract is normative. Other files in the data home are private. Credentials use the platform credential store where available and must never be copied into `trees.yaml`.

## Wire encoding and hosting

The TypeScript wire package implements deterministic CBOR objects, SHA-256 addressing, filesystem snapshots, compare-and-swap refs, access, claims, and public HTTP projection. Any use of JavaScript `localeCompare`, platform enumeration order, or noncanonical CBOR would be a conformance bug; the wire requires lexicographic UTF-8 entry ordering.

The reference `arbor serve` can run locally or behind a deployment provider. Provider environment detection, volume paths, Railway/Hetzner recipes, bootstrap migration variables, credential rotation, backup/restore commands, and operator reset procedures belong in deployment documentation, not the CLI or wire spec.

## Client mechanics

The TypeScript and Swift clients are hand-maintained against common fixtures. They currently allow three total attempts for an ambiguous transport outcome, prepare mutations once, reuse their bytes and mutation ID, and expose observation helpers that buffer from a snapshot cursor before draining child pages. The Swift client uses actors and `AsyncThrowingStream`; the TypeScript client supplies the browser-facing wrapper.

Exact attempt counts, backoff timing, actor/class names, hydration wrappers, and editor session coordinators are replaceable. Both clients must preserve explicit tree scope, opaque PageIDs, one-pass URL decoding, unknown errors, projection provenance, and resync-first behavior.

## Verification machinery

The repository uses Bun tests, TypeScript checking, shared JSON/SSE protocol fixtures, and Swift Package Manager tests. The usual focused gates are:

```sh
bun run typecheck
bun test
bun run test:protocol
git diff --check
```

These commands and current test counts are implementation evidence, not requirements imposed on independent Arbor implementations. Language-neutral vectors under [`spec/fixtures`](../spec/fixtures) are the portable part.
