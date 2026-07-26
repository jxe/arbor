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
- **`PageID`** — REST v1's name for the opaque durable identity carried by a materialized Markdown document; a bodyless directory acquires one when authored continuity requires it, while ordinary files remain path-only;
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
| **Implemented** | 1. Specify arbord REST v1 and build both clients | A normative reference contract with document-aware references, explicit revisions, durable idempotent mutations, lossless observation, and matching TypeScript and Swift clients. |
| **Next** | 2. Finish the whole-workspace daily driver | Add shared complete-directory projection and URL resolution, validate large-tree behavior, and make ordinary files useful. |
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
- Markdown documents receive durable six-character IDs. Filesystem rename observation correlates moved documents by that ID.
- The workspace service reads nodes and collections, writes Markdown with CAS, creates assets, searches, soft-deletes, restores, and exposes recovery.
- Workspace startup uses one discovery snapshot to seed visible paths and page IDs rather than repeatedly walking the tree.

REST v1 exposes the representation through document-aware references and separate content/directory revisions without inventing durable identity for every filesystem node.

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

The journal and mutation engine remain the filesystem foundations. REST v1 adds durable mutation identity, complete receipts, and restart-safe retry semantics without replacing them.

### Current HTTP surface

Implemented in [`packages/arbord/src/server.ts`](packages/arbord/src/server.ts):

```text
GET    /v1/node
GET    /v1/children
GET    /v1/search
GET    /v1/collection
GET    /v1/recovery
GET    /v1/events
POST   /v1/mutations
POST   /v1/assets
POST   /v1/imports
GET    /render/{path}
```

The old `/v/*` routes are removed. Each JSON mutation stays within one durability domain: exactly one content operation or a non-empty atomic structural batch. Assets and imports keep isolated multipart transfer routes with the same mutation identity and receipt semantics. State reads carry an observation cursor and `/v1/events` supports epoch/sequence replay or deterministic `resync-required`.

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
- Authored and auto-generated child-page rows use a custom block type (`standaloneLink`) and navigate rather than editing their displayed title. Both reference clients now expose the shared complete-document projection and managed-row manifest (`openProjectedNodeView`), verified against common fixtures, and the web editor consumes it; content saves strip synthetic rows before persistence.
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

Milestone 1 and its durability-domain/observed-view follow-up were verified on **2026-07-25**:

```text
bun run typecheck       passed
bun test                80 passed, 0 failed
bun run test:protocol   passed: TypeScript fixtures plus 8 Swift tests against live arbord
bun run build           passed
bun run test:e2e        8 passed
bun run test:performance passed: 50,000 files; 1,828 ms startup; 0.27 ms incremental update; 37.06 ms search
swift test --package-path native/Packages/ArborClient
                        8 tests, 0 failures; standalone live-server case skipped as designed
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

**Status: Implemented.**

### Outcome and ownership

REST v1 is now Arbor's sole application API and is proved by two independent reference clients. This file owns all four delivered parts:

1. the normative contract and shared fixtures in [`spec/arbord-rest.md`](spec/arbord-rest.md) and [`tests/fixtures/protocol`](tests/fixtures/protocol);
2. the arbord adapter, executor, journal integration, and observation path in [`packages/arbord`](packages/arbord) and [`packages/fs`](packages/fs);
3. the browser-safe protocol values and TypeScript client in [`packages/core/src/protocol.ts`](packages/core/src/protocol.ts) and [`packages/client`](packages/client);
4. the Foundation-only Swift package at [`native/Packages/ArborClient`](native/Packages/ArborClient).

[plan-native.md](plan-native.md) begins where the fourth deliverable ends. Hunch migration, the node-first `WorkspaceProvider`, `WorkspaceDocumentSession`, native editor integration, and an app/project target remain deliberately unimplemented here.

REST v1 is scoped to one arbord process serving one explicitly chosen filesystem workspace. Loopback authentication, general capability negotiation, mounts, overlays, `TreeID`, invitations, public names, and remote grants are not part of this milestone.

### Delivered behavior

- `NodeRef` is either a logical path or an opaque non-empty page ID plus optional hint. Arbor still mints six-character IDs; discovery, duplicate diagnostics, private journal filenames, rename resolution, and link healing accept arbitrary existing IDs.
- Node snapshots return a canonical reference, `contentRevision`, optional `directoryRevision`, and `observedThrough`. Children, search, and collection reads use fixed 100/30/100 page sizes and query-bound opaque cursors.
- `/v1/mutations` accepts either exactly one content operation or a non-empty ordered structural batch. Content operations cannot be combined with each other or with structural operations; structural batches are all-or-nothing and always maintain structural rows. There is no public `updateDirectoryRows` control.
- Mutation records use a canonical recursively key-sorted request hash. Authored intent precedes materialization, completed receipts precede acknowledgement, identical retries return the original receipt, changed ID reuse is `mutation-mismatch`, and prepared/materialized recovery does not repeat effects.
- One epoch/sequence event bus publishes normalized logical effects, retains 1,024 events, suppresses local watcher echoes, and makes every state read an observation barrier. Foreign/expired cursors return `resync-required`.
- Runtime validation and one error envelope cover every v1 route. Physical paths and transaction state do not cross the boundary.
- [`packages/client`](packages/client) provides separate prepared and convenience APIs for singleton content mutations and structural batches, exact-request retry after termination or HTTP 500, multipart helpers, SSE parsing/reconnect, cursor tracking, and an observed-node view that buffers during listing hydration and converts resync into a refreshed snapshot.
- TreeHopper web uses the client for node/edit/reconcile, listings/search, structural actions, assets/import, recovery, collections, and observed views. The editor coordinator uses content revisions; placement uses directory revisions; document-aware references survive rename without replacing BlockNote or normalizing untouched Markdown.
- [`native/Packages/ArborClient`](native/Packages/ArborClient) is a standalone Swift 6 package for macOS and iOS. Its actor is Foundation-only and supports injectable sessions, IDs, and retry timing, Codable values, domain-specific prepared mutations, multipart, exact retries, unknown error codes, and `AsyncThrowingStream` SSE/observed-node updates.

### Delivery slices

- **Editing kernel — Implemented.** Shared reference/revision/error/receipt/event values, durable Markdown mutation recovery, snapshot/event handoff, both clients, and web open/edit/reconcile are complete.
- **Navigation kernel — Implemented.** Children, search, create, rename, move/place, trash, and restore use logical protocol operations with page-ID rename and distinct revision-conflict coverage.
- **Current feature parity — Implemented.** Copy, multipart assets/import, recovery, and collection reads are on the same contract and TypeScript client.

### Completion evidence

[`tests/integration/server.test.ts`](tests/integration/server.test.ts), [`tests/unit/events.test.ts`](tests/unit/events.test.ts), and [`tests/unit/fs.test.ts`](tests/unit/fs.test.ts) cover opaque page IDs, duplicate IDs, atomic structural batches, mixed-domain rejection, content/directory conflicts, anchors, lost responses, mutation mismatch, crash recovery, ordered replay, observed-view buffering, foreign epochs, and resync. [`tests/protocol/conformance.ts`](tests/protocol/conformance.ts) runs shared TypeScript fixtures and starts a temporary live arbord for the Swift suite.

No editor lifecycle endpoint, auth layer, SDK generator, persisted replay service, mount, script, store mutation, wire behavior, sharing, or native application integration was introduced.

Implementation and follow-up verification are recorded in **Current implementation → Last verified** above. All milestone gates passed.

---

## Milestone 2 — finish the whole-workspace daily driver

**Status: Next.**

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

#### Complete directory documents and stable references

*Implementation order and code-level detail for this section live in [arbord-projection-outline.md](arbord-projection-outline.md); the behavior contract lives in [spec/format.md](spec/format.md) §4 and [spec/arbord-rest.md](spec/arbord-rest.md). Status: **Implemented** — shared logical-URL resolver and pure projection in `@arbor/core` with TS/Swift mirrors and cross-language fixtures; `bodyState`/child `pageID` snapshot fields; natural-vs-authored move placement with lazy `_index.md` materialization; `ensureDocumentIdentity`; projected views in both reference clients; ArborNote cut over with the synthetic-row persistence guard.*

- Refactor the TypeScript and Swift `openNodeView` layers to derive one language-neutral projected directory document after the complete paginated child listing has been hydrated under the initial observation cursor.
- Project the stored or implicit body plus every immediate child exactly once. An authored standalone child link anchors its row; otherwise append a synthetic managed row in stable directory order.
- Return a managed-row manifest carrying `BlockID`, target `NodeRef`, authored/synthetic origin, child kind, and materialization state. Keep the REST `/v1/node` and `/v1/children` payloads storage-shaped.
- Keep browsing side-effect free. Materialize `_index.md` only for authored body/properties, stored ordering/grouping, or when a bodyless directory first needs a durable `PageID` for an identity-bearing link or authored move.
- Split projected editor commits before persistence: prose/properties use singleton `writeMarkdown`; managed-row operations use structural mutations with `directoryRevision`, `beforePath`, or `beforeBlockID`. Synthetic rows are never serialized as invented source.
- Replace the separate `new URL` rules in [`packages/core/src/structural-rows.ts`](packages/core/src/structural-rows.ts) and [`packages/render/src/PageEditor.tsx`](packages/render/src/PageEditor.tsx) with one logical URL resolver in `@arbor/core`, then use it in arbord, TreeHopper web, the TypeScript client, and Swift conformance fixtures. From `/projects/atlas`, `notes` resolves to the child and `../roadmap` to the sibling regardless of whether the body is `atlas.md`, `atlas/_index.md`, or implicit.
- Accept relative and tree-rooted destinations locally and canonical `arbor://<name>/…` or `arbor://tree/<TreeID>/…` destinations globally. Preserve `#PageID`; when ID and path disagree, ID wins and the readable path heals.
- Add cross-language fixtures for bodyless and materialized directories, authored and synthetic child rows, paginated hydration with buffered events, relative/rooted/global URLs, first identity materialization, and move/rename healing.

#### Browser/native parity reads

- Add one arbord backlinks read over the existing Markdown index, addressed by `NodeRef`, paginated, and bounded by `observedThrough`. Backlinks are context and search data; they do not define filesystem placement or a home-rooted orphan ontology.
- Extend recovery from one-node lookup to a recursive, paginated subtree read that unifies Trash inventory with lost/purged blocks under any directory, while preserving per-document filtering. No privileged workspace scope: whole-tree recovery is the root-directory call, and a global Recover surface merges per-tree queries client-side (Finder-style per-volume Trash merging).
- Add a safe ordinary-file/asset byte read (`/v1/file`) with revision/ETag and range support so native preview/open never requires a direct filesystem reach-through. It replaces the `GET /Assets/…` static route outright (authored `../Assets/…` references are ordinary logical paths and resolve through the same read; remove the bespoke route when `/v1/file` lands). When visiting lands, read refs gain a tree dimension and `/v1/file` serves a visited tree's bytes by proxying the wire's content-addressed objects — a read-only slice of Milestone 7 pulled forward, per the parity-reads section of [spec/arbord-rest.md](spec/arbord-rest.md).
- Keep home/default location as client-local preference until Milestone 3 gives preferences a readable `system:` home. Do not write it into arbitrary Markdown or make it the workspace boundary.
- Add both reference clients and TreeHopper web to these reads before native depends on them; keep caches derived exclusively from snapshots/events.

#### Daily-driver polish and acceptance

- Preserve one logical path across routes, links, events, search, breadcrumbs, and directory rows.
- Keep external edits safe under an open page; conflict or merge visibly without remounting the editor.
- Continue source-preservation coverage as Markdown features are added.
- Keep CSV/JSONL/Postgres editing out of the Markdown editor. Row mutation belongs to the collection/driver surface.

Completion gate:

- `arbor dev` over a real multi-thousand-file personal tree is fast enough for daily navigation and search;
- Markdown and directory editing retain the current no-churn/crash-recovery guarantees;
- TreeHopper web and the Swift reference client derive structurally equivalent projected blocks and managed-row manifests from shared fixtures;
- a directory with no `_index.md` opens as a complete document without creating a file, while its first authored edit or identity requirement materializes the minimal canonical body;
- child, sibling, rooted, and `arbor://` references resolve consistently, and a valid document ID follows an authored move and heals its stale path;
- backlinks, subtree recovery/Trash, and ordinary-file bytes are available through arbord/reference clients without another filesystem read path;
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

**Open design decision — wire-endpoint ownership.** The spec describes two daemon roles (see the "Daemon roles" section of [spec.md](spec.md)): the on-demand local workspace daemon and the always-on wire host. This milestone must decide which side owns the wire endpoint for a given shared tree. Working recommendation: the local arbord is always a wire *client*; the serving role is a separate process sharing `@arbor/core` wire code; a local arbord may later embed the serving role (the relay pattern) but the one-replicator rule is stated per role, not per binary.

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

- Resolve `arbor://<dns-name>/…` through DNS `_arbor` records and `arbor://tree/<TreeID>/…` through endpoint hints learned from mounts, visits, invitations, or signed descriptors.
- Implement visited trees as transient lazy mounts with TTL/garbage collection and promotion into the durable workspace.
- Record canonical positions as absolute `arbor://` descriptive citation/discovery metadata, never routing or authority.
- Resolve a global link through the reader's existing mount/overlay first; never embed credentials or invitation tokens in Markdown URLs.
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
- durable universal identity for every ordinary local file or directory beyond the `PageID` required by a materialized Markdown/directory document;
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
