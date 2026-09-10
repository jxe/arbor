# Arbor reference implementation

This document records replaceable architecture and operating choices in the current reference implementation. It is informative. The normative contracts live in [spec.md](../spec.md).

## Reference documentation

- [Local system](local-system.md) — data home, private state, watchers, visits, recovery, credentials, and migration.
- [Arbor Sync API](arborsync-api.md) — the reference loopback REST v1 client/daemon boundary.
- [CLI](cli.md) — the current `arbor` command surface.
- [Client](client.md) — Arbor web and native interaction, navigation, and editing behavior.
- [`@arbor/data`](../packages/data/README.md) — the implemented query, observation, and mutation runtime.
- [Product-completion plans](../plans/README.md#product-completion) — compiler, presentation, activation, hosting, and agent work that remains.

## Repository and runtimes

The reference implementation is a Bun/TypeScript workspace. Major packages separate core logical/protocol types, provider-owned filesystem documents and mutation, local arborsync HTTP service, stores and private state, shared wire objects/protocol/client code, Canopy server behavior, CLI, server rendering, and the Arbor web React application. `@arbor/wire` has no server or database dependency; the single-process `@arbor/canopy` package depends on it and owns hosting, accepted-update storage, access, claims, and merging. Inside the arborsync daemon, the read-only `system:` tree projection (`system-tree.ts`), account claim and pairing bootstrap (`account-bootstrap.ts`), and generated tree type declarations (`generated-types.ts`) are separate modules behind the daemon's public methods.

The Apple reference client is a set of Foundation-only Swift 6 packages under `native/Packages` (see [Package boundaries](#package-boundaries)); `ArborSyncClient` is the loopback REST client. Native Arbor and Hunch integrate those packages without making SwiftUI, Clamshell, actor structure, `URLSession`, or package paths part of REST v1.

Arbor web uses React and BlockNote. Markdown remains canonical: arborsync returns complete operational directory source, BlockNote edits a server-derived block view, and the browser serializes exact/block-granular source for every content write. Child-link reorder is a source write; physical moves remain structural.

The shared public data boundary is capability-based `NodeSnapshot`,
`NodeSummary`, and `ChildrenPage`. Managed and untracked filesystem adapters
delegate expanded directories, Markdown records, CSV/JSON/JSONL collection files, and
SQLite table/row subtrees through one `NodeProviderRouter`; there is no collection
page or private parallel node ontology. Representation loaders remain private
store records.

## Package boundaries

The client core is split into three packages that carry the same names in both languages, so a reader can move between the Swift and TypeScript implementations without translating:

- **WorkingTree** (Swift `ArborWorkingTree`; TypeScript `@arbor/working-tree`, arriving in Plan B alongside the daemon's move) — the durable model of one tree: node records whose content is a reference (inline bytes or a hash), the state store seam (disk on iOS, memory on the Mac and in the browser), the snapshot bridge, and the update reducer with its coordinator. It is named after what it produces, updates, and it is the code `conformance/client-state-machines.json` checks.
- **ObjectStore** (Swift `ArborObjectStore`; TypeScript `@arbor/object-store`, also Plan B) — where accepted bytes come from: the `ObjectStore` protocol, an overlay for a working tree's own unaccepted objects, a layered store that consults the overlay first, and platform stores (a directory on iOS, Canopy directly, or the daemon's `/v1/objects` route from `ArborSyncClient`). Every store verifies bytes against their hash before handing them out. It depends only on the wire package.
- **CanopyClient** (Swift `CanopyClient`; TypeScript `@arbor/canopy-client`) — transport and account plumbing: the Wire client, credentials and pairing, the placement service, and the watch runner. It knows nothing about node records.

`ArborSyncClient` sits beside these as the loopback client for the daemon's bootstrap, credential, object, status, conflict, and pairing routes; `ArborWire` holds the wire model both halves share. Markdown source stays inline in a node record because search, page identity, sibling shadowing, and the delta path read it synchronously; every other file is a hash resolved through the object store on demand, so a working tree neither fetches nor retains every object.

The daemon's placed folder is a working tree whose object store is the folder itself: a file's wire object is re-encoded from the file on disk, a directory's from its children, and the folder's index only remembers which hash a path last produced. That is why the daemon can serve `/v1/objects` to every other client on the machine without a second copy of the tree, and why the Mac app's in-memory working tree needs no content store of its own.

## Executable data and documents

`@arbor/data` implements the headless runtime used by the Supplies corpus. It lowers portable child queries over ordinary and SQLite providers, validates mounted source bindings, executes each SQLite query in one read snapshot, tracks relation/field/profile dependencies, and publishes a complete replacement only when a relevant committed change alters the canonical output. Its mutation runner validates input and authorization inside one transaction and commits retry-stable receipts with the data change. The [package README](../packages/data/README.md) owns these implemented mechanics and focused tests.

Document compilation and presentation are deliberately not described as current architecture. The accepted direction uses isolated JavaScript evaluation, reproducible bundles/manifests/generated declarations, last-valid diagnostics, SSR plus hydration, and a constrained native web surface, but these remain work in [Apps 001 and 003](../plans/README.md#product-completion). Portable behavior belongs in [executable documents](../spec/07-executable-documents.md) and [child backings](../spec/06-child-backings.md); concrete compiler packages, worker topology, generated paths, and bundlers remain replaceable.

## Durability and observation

The local implementation uses a private intent journal, recovery bookkeeping, filesystem observation, and a 1,024-event in-memory SSE replay buffer. Completed mutation identities currently remain available indefinitely through the existing journal. A daemon restart changes the event epoch and clients resynchronize.

Current private paths include `workspaces.json`, per-workspace directories under `workspaces/<stateID>/`, `journal/` and `journal/mutations/`, `index.sqlite`, `types/tree.gen.d.ts`, safe system records under `system/`, and platform credential-store references. These names are documented for maintainers and migration tooling only. Other implementations may choose a different layout, and ordinary clients must not depend on it.

The exact journal records, replay-window size, retry count, temporary filenames, watcher classifications, recovery database schema, and credential reference layout are tuning/implementation choices. They must still satisfy durable acknowledgement, idempotent retry, lossless resync, secrecy, and last-valid control-file behavior.

The synchronized [`trees.yaml`](../spec/04-accounts-and-devices.md#3-configuration-yaml) contract is normative. `${ARBOR_DATA_HOME:-~/.arbor}`, private paths, and platform credential storage are reference choices documented in [the local system](local-system.md).

## Wire encoding, reconciliation, and hosting

The canonical CBOR codec and `canonicalCBORHash` live in `@arbor/core`; the TypeScript wire package implements the object model, SHA-256 addressing, canonical immutable snapshot bundles, strict update JSON/base64, canonical semantic request identity, shared result types, and the Wire client, while filesystem snapshots and materialization live in `@arbor/fs`. Snapshot bundles contain only a version and hash-ordered canonical object byte strings; the root remains in the request URL, while update and observation identity remain in the preceding descriptor read. Any use of JavaScript `localeCompare`, platform enumeration order, or noncanonical CBOR would be a conformance bug; the wire requires lexicographic UTF-8 entry ordering.

The server-only Canopy package implements access and claims, public HTTP projection, graph validation, accepted-update reconciliation, the sole three-way merge engine, and private storage. Update handling is separated into small decision, reconciliation, merge, and transactional store modules even though they run in one process. Table definitions, the schema version stamp, and the startup schema assertion live in a separate `schema.ts` module that opens the database. Canopy's validation profile bounds one exact collection file to 16 MiB, `schema.ts` to 1 MiB, and the normalized row set to 100,000 rows. Canopy currently retains every accepted root and its reachable objects indefinitely. A caller who can currently read a tree may fetch a known retained root through the immutable snapshot route; accepted-update metadata and history listing remain internal, and the generic object route remains scoped to the current root.

Wire directory objects carry ordinary CSV/JSON/JSONL source and schema file
entries plus a directory-level `childrenSource` descriptor that interprets
them as one child set. Canopy validates those graphs, merges disjoint rows by stable identity,
and projects logical rows at ordinary public HTML/Markdown locators while
keeping `_store.*` and `schema.ts` out of child navigation. The Swift replica
currently preserves these objects losslessly but does not project their rows
while fully offline.

For an update string, Canopy derives one credential-scoped digest per element. The first canonicalizes `{ version: "updates-v1", tree, base, candidate, ifMatch, onConflict }`; each later element uses `{ requestDigest, candidate }` from its predecessor as the `base` value. `onConflict` is included at its effective value ([updates §2.1](../spec/01-tree-operations.md#21-the-update-request)). Successful accepted rows store their element digest for replay, so a longer request can resume after an already-applied prefix. Supplied object envelopes are transport aids and do not change identity; `current` and conflict outcomes remain stateless. Rejected candidates and complete conflict drafts are returned to and retained by the client, not stored as Canopy history.

During the mixed-version rollout only, the HTTP boundary also accepts the former one-candidate body and returns its former flattened response to that caller. Canopy immediately normalizes it to a one-element update string internally. New code always emits and models the plural form; [Cleanup 003](../plans/cleanups/003-remove-singular-update-compatibility.md) removes this adapter once every supported server and client is proven current.

The reference `canopyd` can run locally or behind a deployment provider. Provider environment detection, volume paths, Railway/Hetzner recipes, bootstrap migration variables, credential rotation, backup/restore commands, and operator reset procedures belong in deployment documentation, not the CLI or wire spec.

## Client mechanics

The TypeScript and Swift clients are hand-maintained against common fixtures. Their local arborsync REST clients speak only the daemon's control surface (status, trees, accounts, bootstrap, credential, objects, conflicts, events); there is no local mutation path and therefore no mutation ID or ambiguous-outcome retry. The Swift client uses actors and `AsyncThrowingStream`; the TypeScript client serves the CLI, and the browser-facing wrapper returns with the Plan B web editor. Every native editor is a direct working-tree client: the Mac app and iOS run `ArborWorkingTree` (`WorkingTree`, `WorkingTreeProvider`, `UpdateMachine`, `UpdateCoordinator`) over `ArborObjectStore`, and differ only in the state store (disk on iOS, memory on the Mac) and the platform object store (the iOS objects directory, the daemon's `/v1/objects` route on the Mac, Canopy for a visit without a daemon). The Mac app opens a placed tree through `/v1/bootstrap` and shares the daemon's device credential over loopback; a visit is the same client, read-only, following the tree's watch without a coordinator.

Server updates are one retry domain. They carry a confirmed accepted base plus an append-only string of candidate roots and immutable-object envelopes, with no caller-generated mutation or idempotency ID. Arbor Sync and the native update coordinator durably retain that semantic prefix across retry and restart, together with the objects each request carries, so resubmission never consults a live object store. A later local head normally remains one replaceable successor; ambiguous reconnection may persist the one permitted longer request that repeats the possibly transmitted prefix exactly and appends the latest head. Candidates are sparse: a request is cut from the tree's own bytes minus what the base already retains, so a platform-served file is never re-uploaded. When the daemon has a pending request for the folder, the Mac app adopts that request verbatim as its first in-flight attempt (`adoptInFlight`): digests exclude object envelopes, so the adopter re-packs objects from the daemon's object route, and Canopy trims the accepted elements of a same-credential chain by request digest, which makes the daemon's later resubmission of a fully trimmed chain a replay rather than a merge. A conflict inside an adopted prefix raises a hold on the app's coordinator rather than a review; the folder's daemon owns that review, and the app reopens writable once it settles. The Swift Wire client retries each exact prepared body at most three times, while the TypeScript wire client performs one HTTP submission and Arbor Sync owns scheduling and retry. Both synchronization implementations read a descriptor and then fetch its root-addressed snapshot, preserving the descriptor's update and cursor when they materialize that graph. Every client keeps one Wire watch open per tree (`CanopyWatchRunner` in Swift): a `tree.update` batch that chains from the local accepted base is applied from its object deltas without contacting the server, anything else falls through to the ordinary reconciliation pass, and a periodic fallback pass covers only a disconnected watch. In both cases, changing the object-envelope order or omitting an already-held object does not change a server-derived element identity.

When Canopy returns a conflict for an update string, the thick direct client
keeps the exact prepared request as part of its durable conflict state. The
returned `completed` prefix is already processed, `failedIndex` identifies the
one element shown for review, and the suffix remains unattempted. Resolution
submits the reviewed element against the verified current descriptor, then the
client guardedly replays the retained suffix changes in order. The app or
daemon embedding the client renders effects and persists requested data; it
does not choose replay order or reinterpret the final local root as the failed
element.

Exact attempt counts, backoff timing, actor/class names, and editor session coordinators are replaceable. Both clients must preserve exact accepted source, explicit tree scope, opaque PageIDs, one-pass URL decoding, unknown errors, provider-owned directory completeness, and resync-first behavior.

## Verification machinery

The repository uses Bun tests, TypeScript checking, shared JSON/SSE protocol fixtures, and Swift Package Manager tests. The usual focused gates are:

```sh
bun run typecheck
bun run test
bun run test:sync-merge
bun run test:protocol
bun run build
git diff --check
```

These commands and current test counts are implementation evidence, not requirements imposed on independent Arbor implementations. Language-neutral vectors under [`conformance`](../conformance) are the portable part; reference API and algorithm fixtures live under [`tests/fixtures`](../tests/fixtures).
