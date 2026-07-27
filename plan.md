# Build plan
*Forward roadmap for Arbor and the arbord reference implementation. Completed milestones and their verification evidence live in [plan-history.md](plan-history.md). [plan-native.md](plan-native.md) owns TreeHopper native, Hunch migration, Clamshell, iCloud-native integration, and native UI.*

## How to use this plan

This file contains current and future work only. It is not a feature inventory.

- **Next** is the immediate architectural milestone.
- **Planned** means the design exists but the end-to-end behavior does not.
- **Polish** is useful follow-up that does not block later architectural milestones.
- Completed milestones move to [plan-history.md](plan-history.md), with source pointers and verification evidence.

Future agents should inspect the current source and tests before relying on a status label. When a milestone lands, move its delivered contract, deviations, and completion evidence to the history file rather than leaving completed work phrased as future work.

## Reference-implementation discipline

Arbor is a reference implementation of the architecture, not a production platform by default.

For every milestone:

- implement the smallest end-to-end system that proves the visible product feature and preserves user data correctly;
- require durability, conflict safety, deterministic protocol behavior, and interoperability where the feature depends on them;
- prefer readable specifications, fixtures, and direct implementations over generators, plugin frameworks, compatibility matrices, and administrative subsystems;
- introduce an abstraction only when a planned feature supplies its second concrete implementation;
- treat explicitly deferred facilities as out of scope, not as automatic technical debt.

The governing vocabulary remains:

- **workspace** — the tree a person or process sees and works in;
- **`PageID`** — the durable identity of a materialized Markdown document;
- **shared tree** — a folder with independent synchronization, history, and permissions;
- **`TreeID`** — the stable identity of a shared tree;
- **`Mount`** — a local placement of a folder or shared tree in a workspace;
- **collection** — one user-facing concept across file, SQLite, and Postgres backings;
- **script** — a `.tsx` file that may colocate components, queries, and mutations;
- **arbord** — the desktop workspace/runtime authority;
- **wire** — the shared-tree synchronization protocol.

Do not reintroduce the superseded `SpaceID`, binding, `.view.json`, or authored “module” vocabulary.

## Current state

The local daily driver is implemented:

- filesystem-wide browsing with tracked roots and readable `system:roots`;
- source-preserving Markdown and complete projected directory documents;
- durable idempotent REST v1 mutations, replay/resync, and TypeScript/Swift clients;
- logical ordinary-file byte routes;
- per-root search, backlinks, recursive recovery/Trash, collections, and live observation;
- safe iCloud placeholder classification that never reads marker bytes as content.

See [plan-history.md](plan-history.md) for exact source ownership, completion gates, and verification evidence.

## Status at a glance

| Status | Milestone | Outcome |
|---|---|---|
| **Next** | 1. Self-sync and local shared trees | Give a folder durable shared-tree identity and synchronize it safely between one person’s machines. |
| **Planned** | 2. Canonical names and URLs | Resolve stable tree identities and public names before introducing invitations or multi-user authority. |
| **Planned** | 3. Sharing and workspace composition | Add grants, invitations, multiple placements, overlays, and the complete readable workspace namespace. |
| **Planned** | 4. Scripts | Run colocated components, queries, and mutations with explicit execution boundaries and scoped authority. |
| **Planned** | 5. Agents | Run file-defined agents through the same query/mutation handles and restricted namespaces. |
| **Planned** | 6. Data and SQLite | Add a transaction-safe SQLite collection/database driver and backing-independent mutation behavior. |
| **Planned** | 7. Deploy and publication | Publish static trees and live handlers while retaining Arbor crosslinks and declared authority. |
| **Polish** | 8. Daily-driver polish and hardening | Improve ordinary-file UX, provider controls, and measured large-tree behavior without blocking the architecture. |

Dependency order:

```text
implemented local daily driver
              │
              ▼
1. self-sync + local shared trees
              │
              ▼
2. canonical names + URLs
              │
              ▼
3. sharing + workspace composition
       │                    │
       ▼                    ▼
4. scripts             6. data + SQLite
       │
       ▼
5. agents
       │
       ▼
7. deploy + publication

8. polish and hardening is non-blocking and may be taken in focused slices.
```

---

## Milestone 1 — self-sync and local shared trees

**Status: Next. No `packages/wire` implementation exists yet.**

### Product contract

A person can give an ordinary folder a stable `TreeID`, keep it at its current visible path through a minimal `Mount`, and synchronize it between their own machines. This milestone proves identity, history, materialization, conflict handling, and one-replicator safety before invitations or public naming.

The local arbord is a wire client. The serving wire-host role is a separate process sharing `@arbor/core` wire code; a later relay may embed that role without changing the protocol.

### Shared-tree and namespace foundation

- Define the minimal human-readable `system:trees` and `system:mounts` records needed to identify and place a local shared tree.
- Promote a tracked root into a shared tree without changing its visible path or discarding its existing journal/state.
- Support one local placement per shared tree in this milestone; multiple placements and overlays belong to sharing/workspace composition.
- Keep control records canonical and readable. Invalid direct edits produce diagnostics while the last valid configuration remains active.
- Surface source identity and revision provenance (`tree@revision`, locally dirty, syncing, conflict) through node snapshots/events.
- Record declared or safely detected foreign replication and enforce one replicator per subtree.

### Reference wire host

- Implement deterministic DAG-CBOR, SHA-256 objects, and Merkle walk/diff.
- Cross-check canonical encoding with a second implementation before persisting interoperable hashes.
- Implement:

```text
GET  /tree/{treeID}/ref/{path}
GET  /obj/{hash}
POST /tree/{treeID}/push
GET  /tree/{treeID}/watch/{path}
```

- Store immutable objects separately from refs and grants.
- Use a local owner credential fixture scoped to one tree; invitations and recipient grants wait for Milestone 3.
- Provide `arbor serve` and `arbor pull` as conformance/debugging clients.
- Allow two trees to share immutable objects without blurring ref authority.

### Arbord sync engine

- Watch refs, fetch verified Merkle differences, and materialize through the tree’s minimal mount.
- Push writable local changes with CAS.
- On conflict, perform block-level Markdown three-way merge informed by journal intent; preserve unresolved versions as files plus diagnostics.
- Journal sync-applied revisions so local reconciliation cannot resurrect peer deletions. Attribution remains authored here / synced in / externally observed.
- Reuse existing event and query invalidation machinery; pins never consult refs.
- Refuse symmetric overlap when another transport already replicates the same subtree between the same replicas.

Completion gate:

- a laptop and a second machine synchronize one promoted folder through a reference wire host;
- edits made on either machine appear at the unchanged visible workspace path;
- concurrent Markdown edits merge or surface explicit preserved conflicts;
- restart and offline use retain the last verified materialization;
- foreign-replication overlap produces a clear warning/refusal;
- two independent trees on one endpoint retain distinct ref authority.

First spikes:

- canonical DAG-CBOR cross-implementation fixtures;
- promotion of a tracked root without changing state identity;
- conflict materialization while a document is open;
- foreign-sync detection that never mistakes placeholder markers for content.

---

## Milestone 2 — canonical names and URLs

**Status: Planned.**

### Product contract

Every self-synced tree has a stable global identity and canonical URL forms before Arbor adds invitations or multi-user authority. A tree may have a friendly DNS name, but routing remains grounded in `TreeID` plus endpoint hints rather than path position or credentials.

This milestone proves public/read-only discovery and link behavior. It does not introduce recipient-specific grants, invitations, revocation, or writable collaboration.

### Required work

- Resolve `arbor://tree/<TreeID>/…` through endpoint hints learned from the tree’s self-sync descriptor.
- Resolve `arbor://<dns-name>/…` through DNS `_arbor` records that identify a tree and endpoint.
- Keep the tree identity stable while human-readable paths change; document `PageID` fragments remain authoritative over stale paths.
- Record canonical positions as descriptive citation/discovery metadata, never routing or authority.
- Resolve a global link through an already local self-synced tree first, independent of its visible placement.
- Implement a minimal public/read-only visited-tree path so an unmounted public name can be opened without inventing multi-user credentials.
- Record transient visits in the minimal readable system state, with TTL/garbage collection and explicit promotion deferred to workspace composition.
- Keep credentials and invitation tokens out of Markdown URLs by construction.
- Surface name resolution, stale path healing, public/read-only state, and unavailable endpoints in TreeHopper.

Completion gate:

- a self-synced tree opens through `arbor://tree/<TreeID>/…` on either machine;
- changing its visible local path does not change its global URL;
- a DNS name resolves to the same tree and path;
- an identity-bearing document URL follows a rename and heals its readable path;
- an unmounted public tree opens read-only as a transient visit;
- no URL contains a credential, invitation token, or reader-specific mount path.

First spikes:

- DNS `_arbor` record shape and caching behavior;
- tree-ID URL resolution with several endpoint hints;
- public visited-tree object streaming through arbord;
- canonical-position metadata that cannot become accidental routing authority.

---

## Milestone 3 — sharing and workspace composition

**Status: Planned.**

### Product contract

Named self-synced trees grow into collaboration: a tree can be invited, accepted, mounted at reader-chosen paths, attenuated locally, overlaid, and revoked. This milestone completes the workspace-composition work required before scripts, agents, or data execute against composed multi-user authority.

### Sharing and grants

- `arbor share <path>` issues a scoped invitation for an existing shared tree.
- `arbor accept` stores an opaque credential reference and lets the recipient choose a visible path and stricter local mode.
- Enforce remote grant ∩ local mount mode ∩ execution grant.
- Keep v1 rights to read/append/update and subtree scopes; do not add a general account/group service.
- Preserve recipient cached/overlaid work after revocation while removing further authority.
- Store secrets in Keychain/platform credentials; readable records contain only opaque references and safe fields.

### Workspace composition

- Complete the readable, unshadowable `system:` tree for mounts, trees, roots, credentials, connections, visited entries, history, trust, preferences, and diagnostics.
- Mount local folders and shared trees, including multiple placements of one source.
- Implement read-only modes, overlays, shadowing, rename/delete routing, and accurate provenance.
- Extend indexing, search, events, resolution, and home/default preferences across the composed workspace.
- Merge per-root recovery/Trash inventories in the browser without inventing a privileged aggregate API.
- Assemble restricted namespaces containing only granted mounted paths; scripts and agents consume this substrate.
- Promote a transient visit from Milestone 2 into a durable reader-chosen mount.
- Resolve global links through the reader’s mount/overlay before falling back to a transient visit.
- Surface shared, pinned, overlay, conflict, and revocation state in TreeHopper.

Completion gate:

- one person shares a folder and another mounts it at a different path;
- the same source can appear at two local workspace paths with correct identity and provenance;
- read-only edits use an explicit overlay;
- direct control-record edits update behavior or yield a diagnostic without destroying the last valid state;
- effective rights and revocation behave correctly without deleting cached work;
- a previously visited public tree can be promoted into the durable workspace;
- search, events, and global Recover use visible workspace positions while preserving source identity;
- a restricted test namespace contains only its granted mounts.

First spikes:

- overlay materialization across rename/delete on APFS;
- two mounts of one source at different paths;
- open-editor writes while a mount route changes;
- revocation with locally dirty overlay content.

---

## Milestone 4 — scripts

**Status: Planned. No `packages/compiler` or `packages/runtime` implementation exists yet.**

### Product contract

A script is an ordinary `.tsx` file that may colocate React components, queries, and mutations. Explicit constructors mark execution boundaries; Arbor does not infer server/client realms from the general export graph.

### Required work

- Recognize explicit query/mutation constructors while preserving ordinary TypeScript inference.
- Generate runtime validators from handler input types, reusing Zod schemas where appropriate.
- Infer read/write prefixes from literal `tree(...)` paths and require explicit declarations for computed paths.
- Compile supported collection predicates into driver-executable IR; reject unanalyzable forms rather than accepting backing-dependent scans.
- Emit stable typed handles, arbord handler entries, manifests, validators, and declarations while retaining `.tsx` colocation.
- Run deterministic handlers in an isolated worker with a scoped tree client as their only data capability.
- Remove clock, randomness, general network, filesystem, and process access from deterministic realms.
- Track read sets and rerun only affected subscriptions, emitting structural/JSON-patch updates.
- Support `arbor run script.tsx#export` through the same handle manifest used by components.
- Render components as sandboxed islands in TreeHopper. Consent derives from the resolved handle graph and composed namespace.

Completion gate:

- one `.tsx` file colocates a component, query, and mutation over file and Postgres collections;
- the client bundle contains handles but no handler implementation;
- `arbor run` and the rendered component execute the same handler identity;
- watcher changes rerun only affected queries;
- invalid inputs fail generated validation before reaching data;
- consent accurately describes the resolved read/write scope.

First spikes:

- stable transform IDs across irrelevant source edits;
- worker-global stripping, with QuickJS/Wasm as the fallback;
- a 1,000-row live table through the sandbox bridge;
- cost preservation when a collection changes backing.

---

## Milestone 5 — agents

**Status: Planned.**

### Product contract

An agent is a Markdown file: prompt in the body, model/runtime settings in frontmatter, context as query references, and tools as mutation references. Agent effects use the same workspace operations and validation as human/script mutations.

### Required work

- Finalize the agent file schema with a checked-in example.
- Add `arbor agent run <path>` and the corresponding arbord runtime.
- Resolve context/tools through the script handle manifest.
- Assemble the agent’s restricted namespace from Milestone 3 mounts and grants.
- Enforce effective access as remote grant ∩ local mount policy ∩ agent/process grant.
- Render the same agent as editable prompt plus browser chat.
- Show tool calls with the same generated consent language as components.
- Choose and document an ordinary-tree transcript representation.
- Classify direct agent file writes as external observations unless they use a declared mutation.

Completion gate:

- a file-defined agent runs from CLI and browser against the same prompt/tools;
- undeclared paths and malformed tool arguments are rejected;
- a tool mutation visibly changes the tree and invalidates dependent views;
- transcripts are inspectable ordinary content;
- two mounts of one source remain distinct in the agent’s namespace and consent text.

---

## Milestone 6 — data and SQLite

**Status: Planned. Arbor currently uses SQLite only for private indexes.**

### Required work

- Recognize `_store.sqlite3` as collection-folder backing and bare `.sqlite3` files as browsable database nodes.
- Introspect tables and expose the same collection surface as file/Postgres backings.
- Offer an explicit relational escape hatch for joins, transactions, and database-coupled operations.
- Observe committed changes and run row mutations inside SQLite transaction boundaries.
- Snapshot through SQLite backup/checkpoint APIs; never copy a live main-file/WAL pair naïvely.
- Extend type generation and built-in collection views.
- Re-back the file-collection conformance corpus onto SQLite; backing-independent queries must pass unchanged.
- Preserve concurrent database revisions as whole-database CAS conflicts; do not byte-merge SQLite pages.

Completion gate:

- dropping `_store.sqlite3` into a collection changes no backing-independent query call sites;
- a bare database browses as typed tables;
- Arbor and an external SQLite client can transact without corrupting observation or snapshots;
- snapshot hashes remain consistent during WAL activity;
- concurrent sync revisions preserve both databases and surface a database-level conflict.

---

## Milestone 7 — deploy and publication

**Status: Planned. No `packages/deploy` implementation exists yet.**

### Required work

- Define a portable build manifest for pages, assets, static query results, and live handlers.
- Implement one deterministic compiler pipeline shared by local preview and deployment.
- `arbor bake` emits a static ref/object directory usable from a dumb HTTP host.
- Add one static adapter and two live handler adapters, such as Vercel and Cloudflare Workers.
- Make unsupported runtime requirements explicit build errors.
- Protect deployed handlers with the same declared grants and validators as local execution.
- Record deployment metadata in readable local system state without storing provider secrets there.
- Mint or retain the subtree `TreeID`; emit `<link rel="arbor">` and `Arbor-Tree` crosslinks.

Completion gate:

- one tree publishes statically with functional links/assets;
- one live script deploys to both reference targets with equivalent validation;
- secret-requiring handlers fail rather than leaking into static output;
- an Arbor-aware reader can discover the corresponding shared tree;
- local preview and deployed output derive from the same manifest.

---

## Milestone 8 — daily-driver polish and hardening

**Status: Polish. Non-blocking.**

Take these as focused product slices when they answer an observed need; they do not block self-sync, sharing, scripts, or data.

- Enrich ordinary-file pages with bounded metadata, type/icon treatment, safe browser previews, explicit raw/source viewing, and appropriate host-app open actions.
- Add provider-specific download/retry controls only where the platform exposes a reliable contract.
- Extend placeholder classification beyond the current iCloud filename marker when representative provider fixtures are available.
- Measure cold/warm navigation and search on a representative real personal tree when investigating an actual performance question; retain the synthetic 50,000-file regression gate.
- Keep indexing intentionally extension-aware and lazy; never parse binary/placeholder bytes as Markdown.
- Address accessibility, responsive layout, and visual consistency through focused audits tied to concrete surfaces.

---

## Deliberate absences

Unless a later accepted milestone demonstrates a concrete need, the reference implementation does not add:

- local multi-tenant administration or a general account/group service;
- SDK generation or universal capability negotiation;
- persisted event replay across daemon restarts;
- high availability, horizontal scaling, or configurable retention services;
- durable universal identity for every ordinary local file or directory;
- generic store, transport, or deployment adapter frameworks.
