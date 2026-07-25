# Build plan
*Arbor and arbord reference-implementation roadmap. This file owns the platform-neutral workspace behavior, the arbord REST contract, and both reference protocol clients—including Swift. [plan-native.md](plan-native.md) owns how the Swift client is used by TreeHopper native, plus Hunch migration, Clamshell, iCloud, and native UI.*

## How to use this plan

This is a living implementation plan, not a greenfield feature list.

- **Implemented** means the capability exists in the current checkout and is backed by the source/tests named below.
- **Next** is the immediate architectural milestone. Do not begin a later milestone merely because part of it looks easier.
- **Partial** means useful behavior exists, but the remaining work and completion gate are listed explicitly.
- **Planned** means design exists in the spec, but the implementation package or end-to-end behavior does not yet exist.

Future agents should start with **Current implementation**, inspect the linked source, and run the relevant checks before assuming this status is still current. When a milestone lands, update both its status and its “Last verified” evidence; do not leave completed tasks written as future imperatives.

## Reference-implementation discipline

Arbor is intended to remain a reference implementation of the architecture, not grow into a production platform merely because production systems commonly have more machinery.

For every milestone:

- implement the smallest end-to-end system that proves the stated product feature and preserves user data correctly;
- require durability, conflict safety, deterministic protocol behavior, and interoperability wherever the feature depends on them;
- prefer readable specifications, fixtures, and direct implementations over generators, plugin frameworks, compatibility matrices, and administrative subsystems;
- do not generalize an interface for a future backing, authority, or transport until a planned feature actually introduces that second concrete case;
- treat an explicitly deferred facility as out of scope, possibly forever—not as technical debt—unless a later milestone names a feature that requires it.

Examples that may remain absent indefinitely include local multi-tenant administration, SDK generation, general capability negotiation, persisted event replay across daemon restarts, high availability, horizontal scale, configurable retention services, universal identity for ordinary files, and generic adapter frameworks. Security is still required when a planned feature changes the trust boundary: script isolation is part of scripts, grant enforcement is part of sharing, and deployed handlers must protect their declared authority. The initial loopback REST reference does not need a general local authentication system.

The governing vocabulary is:

- **workspace** — the tree a person or process sees and works in;
- **`PageID`** — an opaque durable identity carried by a Markdown page; ordinary files may remain path-only;
- **shared tree** — a folder that has gained independent synchronization, history, and permissions;
- **`TreeID`** — the stable identity of a shared tree, not of every ordinary local folder;
- **`Mount`** — a local placement of a folder or shared tree in a workspace;
- **collection** — one user-facing concept across file, SQLite, and Postgres backings;
- **script** — a `.tsx` file that may colocate components, queries, and mutations;
- **arbord** — the one desktop workspace/runtime authority;
- **wire** — the shared-tree synchronization protocol.

Do not reintroduce the superseded `SpaceID`, binding, `.view.json`, or authored “module” vocabulary.

## Status at a glance

| Status | Milestone | Outcome |
|---|---|---|
| **Implemented** | Local Arbor browser/editor baseline | One chosen filesystem subtree can be indexed, browsed, searched, edited, recovered, and structurally mutated through arbord and TreeHopper web. |
| **Next** | 1. Specify arbord REST v1 and build both clients | A normative reference contract with page-aware references, explicit revisions, durable idempotent mutations, lossless observation, and matching TypeScript and Swift clients. |
| **Partial** | 2. Finish the whole-workspace daily driver | Validate large-tree behavior and make ordinary non-Markdown files as useful as Markdown and collections. |
| **Planned** | 3. Namespace and local mounts | Compose a workspace from roots, mounts, overlays, and readable `system:` state. |
| **Planned** | 4. Scripts | Colocated components, queries, and mutations with explicit execution boundaries. |
| **Planned** | 5. Agents | Agent files, restricted namespaces/tools, CLI execution, and browser chat. |
| **Planned** | 6. SQLite | A transaction-safe SQLite collection/database driver with consistent snapshots. |
| **Planned** | 7. The wire and self-sync | Reference server plus one-person/multi-machine synchronization. |
| **Planned** | 8. Sharing and names | Invitations, grants, public names, visited trees, and sharing UI. |
| **Planned** | 9. Deploy and publication | Static publication plus two live deployment targets proving the handler boundary. |

Dependency order:

```text
implemented local browser/editor
              │
              ▼
1. REST v1 + TS/Swift clients ──────────▶ native integration (plan-native.md)
              │
              ▼
2. whole-workspace daily driver
              │
              ▼
3. namespace + local mounts
       │             │
       ▼             ▼
4. scripts       6. SQLite
       │             │
       ▼             │
5. agents            │
       └──────┬──────┘
              ▼
7. wire + self-sync
              ▼
8. sharing + names
              ▼
9. deploy + publication
```

---

## Current implementation — local browser/editor baseline

**Status: Implemented.**

This section records what exists now so later agents do not re-plan or re-port it.

### Logical filesystem and workspace service

Implemented in:

- [`packages/core/src/logical-path.ts`](packages/core/src/logical-path.ts)
- [`packages/fs/src/workspace-fs.ts`](packages/fs/src/workspace-fs.ts)
- [`packages/fs/src/discovery.ts`](packages/fs/src/discovery.ts)
- [`packages/arbord/src/workspace.ts`](packages/arbord/src/workspace.ts)

Current behavior:

- `arbor dev <path>` opens one user-selected filesystem subtree. The path may be absolute, relative, or omitted for the current directory.
- Workspace paths are normalized, traversal and external-directory symlink escapes are rejected, and Markdown storage aliases canonicalize to one extensionless logical address.
- `x.md` supplies `/x`'s body while sibling `x/` supplies its children. If `x.md` is absent, `x/_index.md` is the fallback body. `x.md` plus `x/_index.md` is a blocking duplicate-body diagnostic.
- Adding the first child creates the directory without moving the sibling Markdown body.
- Markdown pages receive durable six-character IDs. Filesystem rename observation correlates moved pages by that ID.
- The workspace service reads nodes and collections, writes Markdown with CAS, creates assets, searches, soft-deletes, restores, and exposes recovery.
- Workspace startup uses one discovery snapshot to seed visible paths and page IDs rather than repeatedly walking the tree.

Do not redesign the logical `x.md` + `x/` representation in milestone 1. The next work exposes its page-reference and revision semantics through the reference REST contract without inventing durable identity for every filesystem node.

### Durable Markdown writes, recovery, and structural mutations

Implemented in:

- [`packages/fs/src/journal.ts`](packages/fs/src/journal.ts)
- [`packages/fs/src/file-ops.ts`](packages/fs/src/file-ops.ts)
- [`packages/fs/src/workspace-fs.ts`](packages/fs/src/workspace-fs.ts)
- [`packages/core/src/structural-rows.ts`](packages/core/src/structural-rows.ts)
- [`packages/editor/src/merge.ts`](packages/editor/src/merge.ts)

Current behavior:

- Markdown writes use `baseRevision` CAS and return the current node on a stale write.
- Authored writes append journal intent before atomically replacing the materialized file.
- The journal distinguishes authored add/purge intent from externally observed content; lost and intentionally purged blocks remain recoverable.
- Per-node coordinators serialize writes, track generations, classify watcher echoes/stomps/external changes, and avoid treating settled external rewrites as authored stomps.
- Multi-path structural operations are preflighted, staged, and recovered after injected crashes at each transaction boundary.
- Move/trash operations keep sibling body and directory representations together.
- Directory-row moves share one pure transform across optimistic UI planning and committed filesystem mutation. Stale or vanished anchors reject instead of silently appending.
- Finder/browser imports submit a manifest and bytes as one preflighted mutation.

The journal and mutation engine are existing foundations. Milestone 1 strengthens their externally visible acknowledgement and retry contract; it does not replace them.

### Current HTTP surface

Implemented in [`packages/arbord/src/server.ts`](packages/arbord/src/server.ts):

```text
GET    /v/tree/{path}
GET    /v/collection/{path}
GET    /v/search?q=…
GET    /v/events
PUT    /v/node/{path}
DELETE /v/node/{path}
POST   /v/restore
POST   /v/assets
GET    /v/recovery
POST   /v/recovery/restore
POST   /v/fs/mutate
POST   /v/fs/import
GET    /render/{path}
```

Important limitations, which define milestone 1:

- references are still path-only even when a Markdown page has a durable ID;
- write requests have `baseRevision` but no idempotency key or durable mutation receipt;
- `/v/events` assigns an in-memory sequence but has no lossless snapshot-to-stream handoff, replay window, or reconnect/resync contract;
- structural endpoints expose filesystem-shaped request types;
- the browser client in [`packages/render/src/api.ts`](packages/render/src/api.ts) is an ad hoc wrapper rather than a specified reference client;
- no Swift arbord protocol client exists yet.

### TreeHopper web and ArborNote

Implemented in:

- [`packages/render/src/App.tsx`](packages/render/src/App.tsx)
- [`packages/render/src/PageEditor.tsx`](packages/render/src/PageEditor.tsx)
- [`packages/render/src/editor-coordinator.ts`](packages/render/src/editor-coordinator.ts)
- [`packages/render/src/blocks.tsx`](packages/render/src/blocks.tsx)
- [`packages/editor/src/markdown.ts`](packages/editor/src/markdown.ts)

Current behavior:

- TreeHopper web browses the chosen tree with contextual directory navigation, search, canonical routes, and internal links.
- Markdown editing uses BlockNote as the interaction layer, not storage. Arbor owns parsing, source spans, raw-Markdown fallback, serialization, and canonical files.
- No-op saves are byte-identical. Frontmatter comments/order and untouched block source are preserved; editing one supported block normalizes only that region.
- Inline Markdown, links, hard breaks, nested `▸` toggles, footnotes, inline/display LaTeX, and raw HTML fallback are implemented.
- Authored and auto-generated child-page rows use a custom block type and navigate rather than editing their displayed title.
- One editor coordinator owns authored generations, save state, merge/retry behavior, undo grouping, and clean external snapshot application without remounting the editor or manufacturing undo history.
- Selection survives background save/reconciliation.
- The current presentation includes bundled Inter, the 708px reading column, responsive navigation, adaptive colors, properties, page actions, Recover, and filesystem operations.

Do not replace BlockNote with a new canonical document format. The source-preserving adapter and its acceptance corpus are existing product constraints.

### Collections, schema validation, credentials, indexing, and type generation

Implemented in:

- [`packages/stores/src/collections.ts`](packages/stores/src/collections.ts)
- [`packages/stores/src/schema.ts`](packages/stores/src/schema.ts)
- [`packages/stores/src/connections.ts`](packages/stores/src/connections.ts)
- [`packages/stores/src/indexer.ts`](packages/stores/src/indexer.ts)
- [`packages/arbord/src/workspace.ts`](packages/arbord/src/workspace.ts)

Current behavior:

- A schema folder has exactly one backing: `_store.csv`, `_store.jsonl`, `_store.postgres`, or multiple Markdown record files. Mixed backings are diagnosed instead of assigned precedence.
- `schema.ts` is evaluated in a bounded QuickJS/Wasm sandbox with allowlisted schema imports.
- CSV, JSONL, Markdown, and Postgres collections render through one collection surface.
- Markdown records open as editable pages; CSV, JSONL, and Postgres rows remain read-only at this stage.
- Postgres DSNs live in the operating-system credential store through `Bun.secrets`; safe connection records live in Arbor's private system state. Credentials do not enter tree content, generated declarations, or browser payloads.
- The FTS/index database and other rebuildable state live outside the visible tree in a per-workspace private directory.
- `.arbor/tree.gen.d.ts` is generated for the TypeScript language service; it is the intentional in-tree generated exception.

SQLite collection/database support is not implemented. SQLite used internally for indexes does not count as the milestone-6 store driver.

### Last verified

Verified in the current checkout on **2026-07-23**:

```text
bun run typecheck       passed
bun test                56 passed, 0 failed
bun run build           passed
bun run test:e2e        7 passed
bun run test:performance passed: 50,000 files; 1,065 ms startup; 1.49 ms incremental update; 31.12 ms search
```

The general Postgres test is skipped unless `ARBOR_TEST_POSTGRES_DSN` is supplied; do not describe live Postgres integration as re-verified unless that environment-specific test actually ran against a server.

Primary coverage:

- logical path, discovery, and symlink containment tests;
- journal crash recovery and authored/observed/purged semantics;
- structural mutation crash recovery, anchoring, and rename correlation;
- source-preserving Markdown, toggle, footnote, and LaTeX tests;
- editor generation/history/external-update tests;
- workspace/API/collection integration tests;
- browser navigation, editing, clipboard, selection, and collection tests.

---

## Milestone 1 — specify arbord REST v1 and build both clients

**Status: Next.**

### Outcome and ownership

The current HTTP API is sufficient for the colocated web browser, but its behavior is partly implicit in the TypeScript implementation. This milestone turns the behavior needed by real clients into a small, normative reference protocol and proves it with two independent clients.

This file owns all four deliverables:

1. the written REST v1 contract and sequencing invariants;
2. the arbord reference implementation of that contract;
3. the TypeScript reference client used by TreeHopper web;
4. a UI-independent Swift reference client, expected to live as a small package such as `~/src/hunch/Packages/ArborClient`.

[plan-native.md](plan-native.md) begins where the fourth deliverable ends: it adapts the Swift client to `WorkspaceProvider` and `WorkspacePageSession`, native editor documents, window behavior, migration, and iCloud. It must not redefine REST values or retry/event semantics.

REST v1 is scoped to one arbord process serving one explicitly chosen filesystem workspace. Loopback authentication, general capability negotiation, mounts, overlays, `TreeID`, invitations, public names, and remote grants are not part of this milestone.

### 1.1 Finalize and fixture the normative contract before expanding the server

[`spec/arbord-rest.md`](spec/arbord-rest.md) now defines the reference surface and invariants. Before expanding the server, complete its exact per-route examples and turn those examples into language-neutral fixtures covering:

- exact routes, methods, request/response JSON, status codes, SSE framing, and multipart transfer where needed;
- which fields are normative and which are merely descriptive;
- the sequencing rules for reads, mutations, receipts, events, retries, conflicts, and resync;
- a stable error envelope and the finite set of error codes exercised by current features;
- language-neutral JSON examples and fixtures consumed by both clients.

The v1 surface should cover the behavior already present in the reference product:

- resolve and read a node;
- list children, search, read collections, and inspect recovery;
- write Markdown and perform current create/move/copy/reorder/trash/restore operations;
- import files, attach assets, and restore recovery content;
- observe workspace changes.

Keep editor lifecycle out of REST. `/open`, `/flush`, and `/close` would turn local UI coordination into daemon state. Both clients build those higher-level behaviors from snapshots, mutations, receipts, and events.

The prose specification and fixtures are authoritative. OpenAPI generation, generated SDKs, a compatibility matrix, and runtime capability negotiation are deliberately deferred and may never be needed for the reference implementation.

### 1.2 Use page-aware references and explicit revision domains

Do not introduce a universal `NodeID`. A Markdown page has durable identity; many ordinary files and directories do not.

The transport reference is conceptually:

```ts
type NodeRef =
  | { path: LogicalPath }
  | { pageID: PageID; pathHint?: LogicalPath };
```

Required behavior:

- `PageID` is an opaque, variable-length string. Existing six-character Clamshell/Arbor IDs remain valid, but the protocol does not make that length permanent.
- A successful resolution always returns the canonical current logical path and the page ID when one exists.
- A stale path hint plus a valid page ID follows a renamed page.
- Ordinary files remain path-addressed.
- Duplicate page IDs produce a stable diagnostic/error rather than nondeterministic ownership.
- Node snapshots distinguish `contentRevision` from `directoryRevision` where structural ordering needs a separate precondition. Do not overload one `revision` with several meanings.
- Preserve the currently useful materialization value (`available` or `placeholder`) without designing the later mount/overlay/provenance state model.

`TreeID`, invitations, public names, and identities for arbitrary filesystem objects are added only when their corresponding planned features exist.

### 1.3 Make authored mutations durable and idempotent

Every authored v1 mutation carries a client-generated `mutationID`, operation-specific preconditions, and a request body whose stable hash can be recorded.

The reference implementation must:

- append the mutation ID and request hash with durable authored intent before materializing its effects;
- record a completed `MutationReceipt` before reporting success;
- include every logical effect in the receipt, with before/after paths and applicable content/directory revisions;
- include the event cursor at which the effects became observable;
- return the same receipt when the same mutation ID and request are retried;
- reject reuse of a mutation ID with a different request;
- reconstruct or finish the receipt during recovery if arbord crashes after file materialization but before completion was recorded;
- retain ordinary CAS behavior: resolving a real stale-content conflict and submitting merged content uses a new mutation ID.

Use the existing journal rather than adding an unrelated receipt database. The reference implementation may retain completed mutation records indefinitely so it can always answer a retry correctly. Receipt expiry, compaction, administrative inspection, and configurable retention are deliberately deferred. If a later feature makes bounded retention necessary, add an explicit protocol rule then; do not introduce ambiguous “maybe this mutation ran” behavior now.

The first vertical slice is Markdown write. Once its failure cases pass, apply the same logical request/receipt semantics to the current structural, trash/restore, asset/import, and recovery mutations. Multipart bytes may keep a specialized transfer route; the authored operation that attaches them still has mutation identity and a receipt.

### 1.4 Make snapshot-to-event handoff lossless

SSE remains the reference observation transport. The contract must make this sequence safe:

```text
read ─────────────▶ snapshot observed through cursor C
events(after C) ──▶ C+1, C+2, …

mutation M ───────▶ receipt { mutationID: M, eventCursor: D, effects: … }
retry M ──────────▶ the same receipt
```

Required behavior:

- cursors identify an arbord process epoch plus a monotonically increasing sequence;
- a read/list result and its cursor form a defined observation barrier, so a client cannot miss a change between fetching state and following events;
- a bounded in-memory replay window supports ordinary disconnect/reconnect;
- an unknown epoch or expired cursor returns `resync-required`; the client refetches its open node and visible listing;
- events carry canonical path, previous path for moves, applicable revisions, minimal origin, and originating mutation ID;
- events remain invalidations/observations; current state is always fetched authoritatively.

Do not persist replay across daemon restarts: a new epoch plus deterministic resync is sufficient. Do not implement sophisticated event compaction or a broad provenance taxonomy. Avoid public `echo` semantics because “my echo” depends on the observing client; correlation comes from `mutationID`.

### 1.5 Define only the errors current features need

Use one serialized error envelope with a stable machine code, human message, retryability, and relevant current snapshot/conflict details.

The initial codes should cover actual v1 behavior:

- invalid or missing reference;
- duplicate page ID or competing page bodies;
- stale content revision;
- stale directory revision or missing insertion anchor;
- occupied destination or unsafe path;
- mutation-ID/request mismatch;
- unsupported operation;
- resync required.

Do not predefine offline mount, overlay, revoked-grant, remote-store, deployment, or other future errors. Add those codes with the feature that can produce them, while requiring both clients to preserve unknown codes safely.

### 1.6 Build matching TypeScript and Swift reference clients

#### TypeScript

Create `packages/client` as the browser/CLI-facing implementation of REST v1. It owns:

- request and response decoding;
- mutation-ID creation and safe retry;
- SSE cursor tracking, buffering, reconnect, and resync notification;
- the stable error representation;
- multipart helpers for current asset/import operations.

TreeHopper web must stop importing public request types from `@arbor/fs` and use this client for the current REST surface.

#### Swift

Create a separate UI-independent Swift package, expected at `~/src/hunch/Packages/ArborClient`. It owns the same transport concerns using Foundation:

- Codable REST values corresponding to the normative fixtures;
- async request methods for the v1 surface;
- mutation-ID creation and idempotent retry;
- SSE parsing, cursor tracking, reconnect, and resync notification;
- stable error decoding including unknown future codes.

The package must not import SwiftUI, the Hunch app target, `Editor`, or Clamshell. It does not define `WorkspaceProvider`, own an `Editor.Document`, or decide when a page session is flushed. Those are native integration responsibilities in [plan-native.md](plan-native.md).

Hand-maintain these two small clients against the written contract and shared fixtures. Code generation is not a completion requirement.

### Likely implementation locations

- [`spec/arbord-rest.md`](spec/arbord-rest.md) — normative routes, values, invariants, and examples;
- `packages/core/src/types.ts` or a new pure protocol module — serialized references, snapshots, errors, events, mutations, and receipts without filesystem-driver imports;
- `packages/arbord/src/server.ts` and `packages/arbord/src/workspace.ts` — REST adapter and authoritative workspace ordering;
- `packages/arbord/src/events.ts` — epoch/cursor replay and observation barriers;
- `packages/fs/src/journal.ts` and `packages/fs/src/workspace-fs.ts` — durable mutation identity, receipts, and crash recovery;
- `packages/client` — TypeScript reference client;
- `~/src/hunch/Packages/ArborClient` — Swift reference client and its Foundation-only tests;
- `tests/fixtures/protocol` and black-box integration tests — shared JSON/SSE examples plus lost-response, crash, rename, conflict, replay, and resync scenarios.

Keep serialized protocol values in a browser-safe pure module. Do not make the TypeScript client—or generated fixtures—import server-only `@arbor/fs`.

### Delivery slices

#### A. Editing kernel

1. Write the reference, revision, error, receipt, and event invariants.
2. Implement resolve/read and Markdown write through REST v1.
3. Add durable mutation retry and crash-recovery cases.
4. Add the lossless read/event handoff and epoch-based resync.
5. Make both clients pass the same fixture and live-server scenarios.
6. Move TreeHopper web's open/edit/reconcile path onto the TypeScript client.

This slice is complete when TypeScript and Swift can independently resolve, open, edit, retry after a lost response or arbord restart, and reconnect without losing the final state.

#### B. Navigation kernel

Add list, search, create, move/reorder, trash, and restore to the contract and both clients. Verify path/page-ID resolution through rename and distinguish content from directory preconditions.

This slice is complete when both clients can drive the ordinary page tree without importing filesystem-driver concepts.

#### C. Current feature parity

Add copy, assets, import, recovery, and collection reads. Move the remaining TreeHopper web calls onto `packages/client`.

This slice is complete when the reference clients cover the existing arbord workspace API surface; serving the TreeHopper application itself is not a client operation. Later mount/store/wire operations extend the same contract only when those features arrive.

### Milestone completion gate

- the normative REST document and language-neutral fixtures are checked in;
- arbord passes black-box HTTP/SSE tests for every specified v1 operation;
- both reference clients pass fixture decoding and live-server scenarios;
- a renamed Markdown page resolves by `PageID` and returns its canonical path;
- tests prove separate content/directory conflicts, lost-response retry, restart recovery, mutation mismatch, replay, and deterministic resync;
- TreeHopper web uses the TypeScript client for the full current workspace API surface;
- the Swift package is usable without any Hunch, Editor, or Clamshell dependency;
- no REST endpoint models editor `open`, `flush`, or `close`;
- no milestone work is spent on auth, SDK generation, persistent replay, future resolver kinds, rich provenance, or generic driver routing.

Do not bundle mounts, `system:`, scripts, stores, or the wire into REST v1. The goal is a small, trustworthy reference boundary over behavior that already exists, proven by two clients.

---

## Milestone 2 — finish the whole-workspace daily driver

**Status: Partial.**

### Already implemented

The entire **Current implementation** section is the foundation: one chosen subtree, fast startup discovery, watcher/index/search, source-preserving Markdown editing, directories as pages, imports/assets/trash/recovery, file/Postgres collections, and browser navigation.

Do not rewrite those features under this milestone. Extend and measure them.

### Remaining work

#### Large-tree performance and materialization states

- Keep the existing synthetic 50,000-file gate in [`tests/performance/indexer.bench.ts`](tests/performance/indexer.bench.ts) passing. It currently budgets 5 seconds for startup, 200 ms for an incremental update, and 100 ms for search.
- Supplement that synthetic gate with measurements from a representative real user tree. Record the machine, tree shape, materialized-versus-placeholder mix, and cold/warm state so future results are comparable.
- Keep indexing lazy where possible; opening a large home directory must not parse every unsupported/binary file as Markdown.
- Treat iCloud/Dropbox/cloud-provider placeholders as not-materialized state, never file content.
- Surface unavailable, downloading, failed, and retryable materialization clearly.

#### Ordinary files

- Give non-Markdown files a useful node surface: metadata, type/icon, download/open action, and safe preview where the browser supports it.
- Keep raw/source viewing explicit. Do not coerce binary or unknown files into Markdown blocks.
- Preserve containment, read-only, and placeholder diagnostics.
- Ensure search/index code ignores or extracts text from ordinary files intentionally rather than by extension accident.

#### Daily-driver polish and acceptance

- Preserve one logical path across routes, links, events, search, breadcrumbs, and directory rows.
- Keep external edits safe under an open page; conflict or merge visibly without remounting the editor.
- Continue source-preservation coverage as Markdown features are added.
- Keep CSV/JSONL/Postgres editing out of the Markdown editor. Row mutation belongs to the collection/driver surface.

Completion gate:

- `arbor dev` over a real multi-thousand-file personal tree is fast enough for daily navigation and search;
- Markdown and directory editing retain the current no-churn/crash-recovery guarantees;
- ordinary files are recognizably useful rather than blank/unsupported dead ends;
- cloud placeholders never index placeholder bytes as content;
- the full typecheck/unit/integration/build/browser/performance suite passes.

---

## Milestone 3 — namespace and local mounts

**Status: Planned.**

### Why it follows the daily driver

The workspace currently equals one selected physical root. This milestone separates the visible workspace from any one directory and introduces composition without changing the logical node/editor contract.

### Required work

- Define `Mount` records for local folders and future shared-tree roots, including multiple placements of one source.
- Implement an unshadowable `system:` tree for mounts, trees, connections, credential references, visited entries, history, trust, and diagnostics.
- Store canonical human-readable control records under Arbor's private local system directory. Rebuildable/versioned SQLite may index them but is not canonical.
- Validate direct control-record edits atomically. Invalid edits produce diagnostics while the last valid configuration remains active.
- Store secrets in Keychain/platform credential storage; system records contain only opaque references and safe connection fields.
- Record declared or safely detected foreign replication so later sharing can enforce one replicator per subtree.
- Implement overlays, shadowing, rename/delete routing, and provenance such as `tree@revision`, overlay, and locally dirty.
- Extend indexing, search, events, and resolution across the composed workspace.
- Provide restricted namespace assembly as the substrate for scripts and agents.

Human-facing mount records should lead with friendly source, visible path, access mode, revision/pin, and overlay state. Technical IDs, endpoints, and credential status are progressively disclosed.

Completion gate:

- a user can mount two local roots and place the same source at two workspace paths;
- direct edits to readable mount records update behavior or produce a diagnostic without destroying the last valid state;
- editing a read-only mount creates or uses an explicit overlay;
- node provenance remains accurate through move, delete, and overlay materialization;
- search and events use visible workspace paths while preserving source identity;
- a restricted test namespace contains only the granted mounted paths.

First spikes:

- overlay materialization across rename/delete on APFS;
- two mounts of one source at different paths;
- open-editor writes while a mount route changes;
- foreign-sync detection that never mistakes placeholder files for content.

---

## Milestone 4 — scripts

**Status: Planned. No `packages/compiler` or `packages/runtime` implementation exists yet.**

### Product contract

A script is an ordinary `.tsx` file that may colocate React components, queries, and mutations. Explicit constructors mark execution boundaries; Arbor does not infer server/client realms from the general export graph.

### Required work

- Recognize the spec's explicit query/mutation constructors and preserve ordinary TypeScript inference.
- Generate runtime validators from handler input types, reusing Zod schemas where appropriate.
- Infer read/write prefixes from literal `tree(...)` paths and require explicit declarations for computed paths.
- Compile supported collection predicates into driver-executable IR; reject unanalyzable forms rather than silently accepting backing-dependent full scans.
- Emit stable typed handles, arbord handler entries, manifests, validators, and declarations while retaining `.tsx` colocation.
- Run deterministic handlers in an isolated worker with a scoped tree client as their only data capability. Pool workers only if the reference UI cannot remain responsive without it.
- Remove clock, randomness, general network, filesystem, and process access from deterministic realms.
- Track read sets and rerun only affected subscriptions, emitting structural/JSON-patch updates.
- Support `arbor run script.tsx#export` through the same handle manifest used by components.
- Render components as sandboxed islands in TreeHopper web. Consent is computed from the resolved handle graph and mounts, not source-string heuristics.

Completion gate:

- one `.tsx` file colocates a component, query, and mutation over file and Postgres collections;
- the client bundle contains handles but no handler implementation;
- `arbor run` and the rendered component execute the same handler identity;
- watcher changes rerun only affected queries;
- invalid handler inputs fail generated validation before reaching data;
- consent accurately describes the resolved read/write scope.

First spikes:

- stable transform IDs across irrelevant source edits;
- prove worker globals can be stripped adequately, with QuickJS/Wasm as the explicit fallback;
- a 1,000-row live table through the sandbox bridge;
- cost preservation when a collection changes backing.

---

## Milestone 5 — agents

**Status: Planned.**

### Product contract

An agent is a Markdown file: prompt in the body, model/runtime settings in frontmatter, context as query references, and tools as mutation references. Agent effects use the same workspace operations and validation as human/script mutations.

### Required work

- Finalize the agent file schema with a concrete checked-in example.
- Add `arbor agent run <path>` and the corresponding arbord runtime.
- Resolve context/tools through the script handle manifest.
- Assemble a restricted per-agent namespace from milestone-3 mounts and grants.
- Enforce effective access as remote grant ∩ local mount policy ∩ agent/process grant.
- Render the same agent as editable prompt plus browser chat.
- Show tool calls with the same generated consent language as components.
- Choose and document an ordinary-tree transcript representation.
- Classify direct agent file writes as external observations unless they go through a declared mutation.

Completion gate:

- a file-defined agent runs from CLI and browser against the same prompt/tools;
- undeclared paths and malformed tool arguments are rejected;
- a tool mutation visibly changes the tree and invalidates dependent views;
- transcripts are inspectable ordinary content;
- two mounts of the same source remain distinct in the agent's visible namespace and consent text.

---

## Milestone 6 — SQLite

**Status: Planned. Arbor currently uses SQLite only for private indexes; there is no user-facing SQLite store driver.**

### Required work

- Recognize `_store.sqlite3` as collection-folder backing and bare `.sqlite3` files as browsable database nodes.
- Introspect tables and expose the same collection surface as file/Postgres backings.
- Offer an explicit relational escape hatch for joins, transactions, and database-coupled operations.
- Observe committed changes and run row mutations inside SQLite transaction boundaries.
- Snapshot through SQLite backup/checkpoint APIs; never copy a live main-file/WAL pair naïvely.
- Extend type generation and built-in collection views.
- Re-back the file-collection conformance corpus onto SQLite; backing-independent queries must pass unchanged.
- Preserve concurrent database revisions as whole-database CAS conflicts in v1. Do not byte-merge SQLite pages.

Completion gate:

- dropping `_store.sqlite3` into a collection changes no backing-independent query call sites;
- a bare database browses as typed tables;
- Arbor and an external SQLite client can transact without corrupting observation or snapshots;
- snapshot hashes are consistent during WAL activity;
- concurrent sync revisions preserve both databases and surface a database-level conflict.

---

## Milestone 7 — the wire and self-sync

**Status: Planned. No `packages/wire` implementation exists yet.**

### Reference server

- Implement deterministic DAG-CBOR, SHA-256 objects, and Merkle walk/diff.
- Cross-check canonical encoding with a second implementation before persisting interoperable hashes.
- Implement:

```text
GET  /tree/{treeID}/ref/{path}
GET  /obj/{hash}
POST /tree/{treeID}/push
GET  /tree/{treeID}/watch/{path}
```

- Store immutable content-addressed objects separately from refs and grants.
- Use revocable bearer fixtures scoped by shared tree/path/right; no account system yet.
- Provide `arbor serve` and `arbor pull` as conformance/debugging clients.
- Test two trees sharing immutable objects without blurring ref authority or permissions.

### Arbord sync engine

- Accept direct descriptors containing `(TreeID, endpoint hints, grant)`.
- Watch refs, fetch verified Merkle differences, and materialize through milestone-3 mounts/provenance.
- Push writable changes with CAS.
- On conflict, perform block-level Markdown three-way merge informed by journal intent; expose unresolved conflicts as files plus diagnostics.
- Journal sync-applied revisions so local reconciliation cannot resurrect peer deletions. Attribution remains authored here / synced in / externally observed.
- Sync SQLite as consistent whole-database snapshots and Postgres references without credentials.
- Reuse event/query invalidation machinery; pins never consult refs.
- Enforce one replicator per subtree. A foreign transport may sit beneath one arbord relay, but symmetric replication of the same subtree between the same replicas is refused.

Completion gate:

- a laptop and cloud box synchronize a tree via direct descriptors;
- edits appear in each materialized workspace;
- a cloud agent observes laptop changes;
- concurrent Markdown edits merge or surface explicit conflicts;
- pinned trees remain fully usable offline;
- two independent shared trees on one endpoint retain distinct ref authority.

---

## Milestone 8 — sharing and names

**Status: Planned.**

### Capability flow

- `arbor share <path>` gives the selected folder independent identity/history, leaves a `Mount` at the same workspace path, and issues a scoped invitation.
- `arbor accept` stores an opaque credential reference and lets the recipient choose a visible mount path and stricter local mode.
- Enforce remote grant ∩ local mount mode ∩ execution grant.
- Keep v1 rights to read/append/update and subtree scopes; no general account/group service.
- Preserve recipient cached/overlaid work after revocation while removing further authority.

### Names and visited trees

- Resolve whole-tree public aliases through DNS `_arbor` records.
- Implement visited trees as transient lazy mounts with TTL/garbage collection and promotion into the durable workspace.
- Record canonical positions as descriptive citation/discovery metadata, never routing or authority.
- Surface shared, stale, pinned, overlay, conflict, and revocation state through existing arbord events.
- Add TreeHopper web sharing and invitation flows without presenting namespace administration as the primary product metaphor.

Completion gate:

- one person shares a folder and another mounts it at a different workspace path;
- both edit according to effective rights and see provenance/conflict state;
- revocation stops new authority without deleting cached or overlaid work;
- a public name opens as a visited tree and can be promoted;
- sharing a foreign-replicated subtree warns or refuses according to the one-replicator rule.

---

## Milestone 9 — deploy and publication

**Status: Planned. No `packages/deploy` implementation exists yet.**

### Required work

- Static-render Markdown, directories, and collection views; hydrate only islands.
- Compile query/mutation handlers with generated validation and stable code identities.
- Content-hash immutable assets and outputs while revalidating only entry HTML.
- Support Vercel first and Cloudflare second to prove the target boundary.
- Include a plain static-only profile and `arbor deploy --watch`.
- Keep file-backed deployed trees read-only until backed by a live authority; Postgres mutations use host secret stores.
- Mint or retain the subtree `TreeID`; emit `<link rel="arbor">` and `Arbor-Tree` crosslinks.
- Host upstream queries at the tree authority with versioned code identity and the same validation/placement semantics as local handlers.
- Implement `arbor bake` as a static ref/object origin with explicit staleness.

Completion gate:

- a site with Markdown, one island, and a Postgres-backed handler deploys to two hosts;
- an Arbor-aware visitor can upgrade from the website to the same live tree identity;
- `bake → static host → pull` round-trips byte-identically;
- static origins do not pretend to support live push/watch;
- handler placement and permission statements remain consistent across local, serverless, and authority-hosted execution.

Git bridges, atproto projections, Postgres publication, mirrors/LAN discovery, and FUSE/userfs are possible experiments, not completion work for this plan. Any of them may remain unimplemented forever unless promoted into a concrete feature with its own end-to-end acceptance case.

---

## Deliberate absences

These are not backlog items for the reference implementation. Do not add them merely because a production implementation might normally have them:

- a general authentication or multi-user administration layer around the initial single-user loopback arbord API;
- generated REST SDKs, OpenAPI-driven code generation, or a multi-version client compatibility matrix;
- high availability, horizontal scaling, fleet management, quotas, billing, or production observability infrastructure;
- persistent event replay across arbord process epochs when deterministic resync is sufficient;
- configurable mutation-receipt retention services or administrative receipt browsers;
- durable universal identity for every ordinary local file or directory;
- a generic storage-driver, transport-adapter, or plugin framework ahead of a second concrete required implementation;
- general account or group service;
- public-name registry beyond DNS aliases;
- `_delegate` workspace nodes;
- secret connection strings in publishable trees, generated manifests, logs, or browser payloads;
- a general-purpose web SPA browser;
- a CRDT promise;
- automatic multi-writer SQLite page merging;
- a second bespoke file-tree write API for deployments;
- adapters before the live wire protocol they must preserve.

This list does not excuse missing machinery required by a planned feature. Script execution must enforce its declared isolation, the wire must authenticate its scoped reference grants, sharing must enforce grant intersection and revocation, and deployed mutations must protect their authority. Implement those narrow requirements with their milestones rather than growing a general platform in advance.

The founding system remains one arbord plus one small reference server. Every additional authority, adapter, or replication path must earn a concrete planned feature and a clear ownership boundary.
