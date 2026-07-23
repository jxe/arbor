# Build plan
*Ten phases, ordered so that Arbor is a daily driver over your own tree before it is a framework, an agent host, or a network. TypeScript + Bun except TreeHopper native (Swift). Companion browser detail: [treehopper-integration.md](treehopper-integration.md).*

```text
1.  browse your tree               arbor dev over a whole local subtree; filesystem + Postgres stores
2.  edit in the browser            BlockNote over logical pages; x.md body + x/ children at one address
3.  scripts                        the web-framework core: compiler, queries/mutations, islands
4.  agents                         agents as files, arbor agent run, and a chat interface in the browser
5.  arbord                     system:, mounts, overlays, materialization, agent namespaces
6.  deploy to the web              a subtree becomes a Vercel/Cloudflare site; queries become functions
7.  SQLite                         the SQLite driver: recognition, snapshotting, typegen
8.  the wire + self-sync           reference server; one person, many machines
9.  sharing + names + publication  invitations and grants, then DNS, the upgrade bridge, adapters
10. TreeHopper native                   the Swift browser/editor (parallel track; can start after 5)
```

The ordering choices are deliberate:

- **Daily driver before framework.** Phases 1–2 make Arbor a browser and editor over the tree you already have: point `arbor dev` at a large personal subtree and browse, search, and edit it — no schema, no scripts, no new mental model. The web-framework story (scripts, deploy) comes after the daily-driver story. The namespace shift — mounts, `system:`, shared trees — arrives in phase 5, for people already using the tool.
- **The browser edits from day one.** In-browser block editing is the adoption wedge (it used to be the Vercel deploy). Every page is editable, including directories. TreeHopper web is the first editing surface; TreeHopper native is the offline-polished one later.
- **Clamshell's durability model is ported; its transport is not.** TreeHopper's Clamshell engine (log-before-file journaling, intent-vs-order reconciliation, explicit-delete tombstones, soft-delete trash, rename-proof link IDs) is proven machinery and lands in phase 2 — but the journal stays arbord-private and unsynced. In Clamshell the synced journal is the cross-device intent channel because iCloud destroys causality; in Arbor the wire carries intent natively, so the journal keeps only the local half of the job.
- **Postgres before SQLite.** External Postgres references are the first database story: they exercise the store-driver interface, credential handling, and typegen without inventing a sync story. The SQLite driver is its own phase 7, landing just before the wire needs its snapshot semantics.
- **Agents are deferred a bit — but arrive with a face.** The agent file format needs only the phase-3 handle manifest, so agents land right after scripts, running against the plain subtree; per-agent namespace assembly waits for arbord. From the start, an agent renders in the browser with a chat interface, not just a CLI entry point.
- **The deploy is deferred.** It is no longer the wedge, but it remains the publication on-ramp: it mints `TreeID`s and dormant crosslinks that phase 9 activates, and its serverless functions remain the first implementation of upstream-hosted queries.
- **Self-sync before sharing.** One person across laptop and cloud agents is the everyday case; it exercises the entire wire without any capability UX.
- **The reference server is live first.** The phase-6 web deploy produces a *website*; a static *wire origin* (`arbor bake`) is a phase-9 portability profile, proven after the live protocol exists.
- **Git is not the founding transport.** Arbord implements one sync engine against the wire and gains git as a phase-9 adapter.
- **Query placement follows the data.** Queries over locally materialized trees run in the reader's arbord; queries over unsynced trees run at the host. Phase 6's serverless functions and phase 9's endpoint queries are the same placement rule at two hosts.

Each phase ends with something testable and preserves the same dev-server/arbord/client boundary.

## Repository shape

```text
arbor/                         # Bun monorepo
  packages/
    core/        paths, shared trees, mounts, canonical encoding, hashes, Merkle diff
    fs/          logical filesystem nodes, coordinated writes, mutations, journal, watcher, recovery
    system/      system: schemas and durable local control-store implementation
    arbord/      workspace resolution, materialization, overlays, watcher, index, subscriptions
    stores/      filesystem driver and Postgres connection driver; SQLite driver (phase 7)
    client/      typed workspace client: collection/doc/search plus relational database operations
    compiler/    query/mutation transforms, validators-from-types, handles, manifests, typegen
    runtime/     deterministic query/mutation workers and read-set tracking
    render/      React UI runtime, built-in views, sandbox bridge
    editor/      in-browser block editor: markdown round-trip, _index.md materialization
    deploy/      subtree → web-target compilation; Vercel/Cloudflare adapters; crosslink tags
    wire/        live ref/object/push/watch protocol; bake/adapters added in phase 9
    cli/         arbor dev|run|agent|deploy|status|serve|pull|mount|share|accept …
```

One process matters: **arbord**. The CLI, agents, render routes, and TreeHopper are clients of its localhost API plus the materialized files. Phase 1 runs the browsing subset of this API (`/v/tree`, `/v/collection`, `/v/search`, `/v/events`, `/render`) as a dev server before the full arbord exists; phase 2 adds node, asset, trash, and recovery writes; phase 3 adds `/v/query` and `/v/mutation`.

```text
GET  /v/tree/{path}              node + children + shared-tree/provenance
GET  /v/collection/{path}        cursor-paginated collection rows + diagnostics
GET  /render/{path}              TreeHopper browser route for a workspace node
PUT  /v/node/{path}              {baseRevision, frontmatterPatch, blocks}; 409 returns current node + revision
DELETE /v/node/{path}            soft-delete a writable node to Trash/
POST /v/restore                   conflict-rejecting restore from Trash/
POST /v/assets                    workspace-scoped pasted/uploaded asset in Assets/
GET  /v/recovery                 list recoverable blocks for a page
POST /v/recovery/restore         restore one journaled block
POST /v/fs/mutate               one preflighted atomic logical-filesystem mutation batch
POST /v/fs/import               multipart Finder file/directory manifest and bytes
GET  /v/system/{collection}      system: views (mounts, shares, diagnostics, …)
POST /v/system/mounts            create/update/remove a mount
POST /v/system/connections       create/test/update a safe connection record
POST /v/system/shares            create/accept/revoke a share
GET  /v/resolve?name=…           name/TreeID/path → local, visited, or external
GET  /v/search?q=…&scope=…       FTS over the workspace
POST /v/query/run                {handle, input, workspace} → result/subscription
POST /v/mutation/run             {handle, input, workspace} → result
GET  /v/events                   file, query, mount, sync, and diagnostic events
```

---

## Phase 1 — browse your tree

`arbor dev <path>` over any local subtree — including a large, deep personal tree like `~/workspace`, not just a small project-shaped folder. No `system:`, no mounts, no shared trees: the chosen subtree is the whole world. This phase is read-only in the browser; it must be fast, navigable, and searchable on a tree with tens of thousands of files.

Ends when: pointing `arbor dev` at a real multi-thousand-file personal tree gives fast browsing and full-text search, pages re-render live on file change, a `schema.ts` collection renders as a schema-derived table, and a Postgres-backed collection browses without the DSN ever leaving the credential store.

### 1.1 Watcher, index, and navigation

- Watch the subtree with `@parcel/watcher`.
- Build the rebuildable index: files, hashes, links/backlinks, and FTS5 bodies — lazy and incremental, sized for a big personal tree. Targets: cold start on ~50k files within seconds, incremental updates fast enough that a save feels instant in the browser.
- Keep the index (and all later arbord-private state) in a per-workspace directory under Application Support/XDG, keyed by a workspace ID minted on first open — never inside the tree. The only in-tree generated state is `.arbor/tree.gen.d.ts`, which the TypeScript language service must see.
- Treat cloud-eviction placeholders (`.icloud` stubs, Dropbox online-only files) as a "not materialized" state, never as content — people will point `arbor dev` at folders inside iCloud Drive on day one.
- Path-based routing over the subtree, plus Cmd+P-style jump by path and full-text search in the web view.
- Make Markdown paths logical and extensionless everywhere: sibling `x.md`, child directory `x/`, and fallback `x/_index.md` contribute to `/x`, while `.md`/`_index.md` spellings are accepted only as input aliases. Indexes, APIs, links, type generation, events, routes, breadcrumbs, and visible names all use `/x`.
- Keep the sidebar contextual: list the current directory's children on a directory page and the containing directory's children on a leaf page, with a parent action bounded by the `arbor dev` root. Render inline links, authored child-page rows, and auto-generated directory-child rows as real internal navigation with browser history.

### 1.2 Store drivers, schemas, and type generation

- Define the store-driver interface: schema introspection, typed reads, transactions, change observation, consistent snapshots, and materialization.
- Implement the filesystem driver.
- A `schema.ts` file-backed collection uses exactly one backing shape: one `_store.csv`, one `_store.jsonl`, or multiple Markdown record files. CSV has one header plus many rows; JSONL has one JSON object per line; Markdown records validate user frontmatter while body, path, and Arbor's durable `id` remain reserved metadata. Mixed backings are diagnostics, not guessed precedence.
- Implement Postgres-backed folders via safe `_store.postgres` references; resolve credentials from the platform credential store; introspect child-table schemas and execute queries without copying the database.
- Bundle and evaluate `schema.ts` in an isolated QuickJS/Wasm worker with only the allowlisted `zod` import, no filesystem/network/process globals, and bounded time, stack, and memory; serialize schemas, validate on change, and emit diagnostics.
- Generate `.arbor/tree.gen.d.ts` mappings for file- and Postgres-backed collections (`_store.postgres` folder backing), plus relational database-container types, keyed by canonical tree-rooted paths.
- Wire the generated registry in through the workspace tsconfig so `tree("/essays")` types everywhere with no per-file import; resolve relative `tree("./…")` literals in the compiler.
- Preserve stale generated database types with a diagnostic when an external connection is temporarily unavailable; regenerate without thrashing the editor language service.

### 1.3 Read-only renderer

- Render Markdown as an article, directories as outlines, and collections — CSV, JSONL, Markdown records, and Postgres tables — as cursor-paginated schema-derived tables. CSV, JSONL, and Postgres remain read-only through phase 2; Markdown records gain editing with the rest of Markdown. (`.tsx` islands arrive with the compiler in phase 3.)

**First spikes:** index cold-start and incremental performance on a ~50k-file tree; Postgres credential lookup without leaking the DSN into generated files or manifests.

---

## Phase 2 — edit in the browser

Every page becomes editable in place through the dev server, using a block editor over the canonical files. This is the adoption wedge: the browser is now an editor, and the files remain plain markdown that agents and git read unchanged.

Much of this phase is a port of TreeHopper's Clamshell engine (`~/src/hunch/App/Sources/Clamshell/`, see its README) from Swift to arbord: the durability model, reconciliation contract, and link-identity scheme are proven there and re-specified here — minus Clamshell's iCloud transport role, which the wire replaces in phase 8.

Ends when: editing a markdown page and a directory page in the browser produces clean, minimal diffs in the underlying files; adding the first child to `/x` creates `x/` while leaving sibling body `x.md` in place; Arbor blocks the ambiguous `x.md` plus `x/_index.md` case; an external editor changing the same file surfaces safely in the open editor rather than being clobbered; killing arbord mid-save loses nothing on reopen; a deleted block is recoverable from the Recover surface; and renaming a page breaks no inbound links.

### 2.1 Block editing of markdown

- Edit `.md` files in place: frontmatter as a props panel, body as blocks; **write-back targets the markdown file itself** — the file stays canonical.
- Round-trip discipline: preserve frontmatter byte-for-byte unless edited; minimize diff churn on untouched blocks; no lossy normalization of markdown the user didn't touch.
- Use **BlockNote** for the editing surface, but never its JSON as storage. Arbor's source-span CommonMark/GFM adapter maps supported syntax into BlockNote, splices untouched source slices back byte-for-byte, and exposes unsupported syntax as editable raw-Markdown blocks.
- Give the web surface Hunch-like reading ergonomics without importing Hunch's native editor state model: bundled Inter at 16/24 body metrics, a 708px responsive writing column, 40/30/24/20px heading hierarchy, 24px nesting, sibling-aware block rhythm, adaptive light/dark tokens, collapsible contextual navigation, disclosed properties, and contextual save/recovery chrome.
- Keep one BlockNote instance alive per open page. Reconcile clean saved or externally observed snapshots through a non-history BlockNote transaction; do not reconstruct the editor for every file revision.
- Support the Clamshell toggle extension as a first-class nested BlockNote toggle: `▸ Title` followed by blank lines or lines indented at least two more spaces. The body may contain arbitrary blocks and ends at the first nonblank line at-or-above the toggle indent; fenced code is opaque to boundary detection. Toggle disclosure state is session-local and never written. Implement `▸ ` authoring as a BlockNote input rule so conversion and typing form one native transaction and one Arbor generation.
- Implement the `PUT /v/node/{path}` write route with atomic writes and conflict responses.
- Pasted images land in a visible `Assets/` folder (Notion/Obsidian convention) so pages stay portable to any markdown viewer.

### 2.2 Directories as editable pages

- The directory view is the same editor: children appear as blocks that can be reordered, grouped under inserted headings, and surrounded with prose.
- A structural edit updates sibling `x.md` when it supplies the directory body; otherwise it materializes `x/_index.md`. Children not mentioned in the selected body still render, appended after the authored body (rule specified in [spec/browser.md](spec/browser.md) §2).
- Use one pure structural-row transform for optimistic browser previews and committed filesystem rewrites. An anchored move carries the directory body's full-byte revision; stale revisions and missing block/path anchors reject the entire batch instead of falling back to the end.
- Treat sibling body `x.md` plus child directory `x/` as one `/x` node; use `x/_index.md` only when the sibling body is absent. Trash, restore, move, watch events, conflicts, ID ownership, backlinks, search, and generated declarations retain the logical identity. If an external writer creates both body files, show one blocking diagnostic and require explicit resolution rather than choosing or overwriting a body.

### 2.3 The write journal (Clamshell's durability model)

- Per-workspace, per-device append-only journal in arbord-private store — **never in the tree**, so deleted content can't leak into grep, git, sync, or deploys. Keyed by durable node ID, not path, so renames and (later) mounts don't orphan history.
- Log-before-file: every editor commit appends block-level records (`add`/`purge`, Lamport-countered) before the `.md` write fires. A crash between the two heals on next open.
- Reconcile on open: port `PatchEngine`'s contract — journal is authoritative for intent (what should exist, what was deleted on purpose), the file for order and current text; the mtime gate's asymmetry (restore missing alive blocks freely, suppress removes when the file is newer than the purge) carries over verbatim.
- External writes are absorbed as `observe` records — a snapshot for recoverability without claiming authorship. Deletions Arbor didn't author surface as "lost," never "deleted on purpose": arbord does not infer intent from writes it didn't make. This matters doubly here because agents write files directly.
- Classify watcher events per file against a content-hash ring: **echo** (our write-back returned), **stomp** (something clobbered an in-flight write), **external** (a different writer). Port the watermark fast path (stat-based skip/tail/full journal folds) so reconcile stays off the hot path.
- Recover surface in the browser: lost blocks and intentionally purged blocks (with a time window), restorable per block.
- The journal is local-only by design; cross-device intent is the wire's job (phase 8, where the journal gains an applied-revision record kind).

### 2.4 Durable IDs, trash, and link healing

- Mint a durable short ID into each page's frontmatter at creation (or first save, for existing files). Links carry it as a fragment — `[Title](notes#x7f3q2)` — with the extensionless logical path as the human-readable primary and the ID authoritative when they disagree ([spec/format.md](spec/format.md) §4).
- Lazy link healing: when a page is open and quiet, rewrite stale link destinations to canonical `path#id` form through the normal commit path, so the journal follows the rewrite. Renames are O(1) — move the file, patch the index; inbound links heal on their own schedule.
- Soft delete to an in-tree `Trash/` mirroring the source structure; restore returns a page to its original path. The page's journal stays put in the private store (same ID key), so trash/restore never touches history.

### 2.5 BlockNote adapter and acceptance corpus

BlockNote is the chosen editor. Arbor owns the Markdown parser, source spans, toggle grammar, raw-block fallback, serializer, logical filesystem mutations, and multi-row selection semantics. BlockNote supplies the interactive block tree, custom-block contract, input rules, transactions, change provenance, slash menu, drag handles, nesting, and React UI. Newly authored supported blocks serialize to Arbor's canonical Markdown, while untouched supported and unsupported blocks retain their original bytes.

**Required corpus:** real `.md` files in → no-op save byte-identical; edit one block → only that source region changes; frontmatter comments/order/quoting survive property edits; nested `▸` toggles survive lists, headings, blank lines, and fenced code; inline links plus authored and auto-generated child-page rows are clickable and canonicalize storage aliases; sibling `x.md`, child directory `x/`, and fallback `x/_index.md` share one route/API/search identity; child creation and conflict-rejecting restore never create duplicate bodies; external edits merge or surface explicit conflicts; `kill -9` between journal append and file write repairs on reopen; opening or closing a toggle produces no write, journal record, watcher event, or diff.

---

## Phase 3 — scripts

The web-framework core: colocated components, queries, and mutations over the browsable, editable tree. Queries and mutations run over file-backed and Postgres-backed collections; the SQLite driver is phase 7.

Ends when: a folder containing markdown, a `schema.ts` collection, and a Postgres-backed collection, plus one script with a component, query, and mutation over both stores, renders live in the browser via `arbor dev`, updates on file change, and gives the same result through `arbor run script.tsx#export`.

### 3.1 Colocated query/mutation compiler and runtime

- Recognize explicit `query(fn)` and `mutation(fn)` constructor calls; do not infer realms from the general export graph.
- Generate runtime boundary validators from each handler's TypeScript input type, reusing Zod schemas where the type originates from one.
- Infer read/write prefixes from literal `tree(...)` paths; require an explicit `reads`/`writes` option for computed paths.
- Compile collection predicates (`filter`, `sortBy`, …) to a driver-executable IR; reject constructs outside the analyzable subset so backing migration preserves cost, not just correctness.
- Ship the authoring surface as one `arbor` package with `arbor/runtime` and `arbor/react` subpaths; realm misuse is a compile error regardless of import shape.
- Emit a UI build with stable typed handles, arbord handler entries, a machine-readable manifest, and TypeScript declarations.
- Reject render-state closures, UI-only imports in handlers, dynamic handler construction, computed paths without declarations, and non-deterministic globals.
- Run handlers in pooled isolated workers with the scoped tree client as the only data capability.
- Track read sets; on watcher deltas, debounce affected query re-runs and emit structural/json-patch diffs over SSE.
- Support `arbor run script.tsx#export` against the same handle manifest used by components.

### 3.2 Islands

- Render `.tsx` scripts as compiled custom UI inside the pages built in phases 1–2.
- Bridge `useQuery`/`useMutation` handles to the dev server over MessageChannel in a sandboxed iframe.
- Generate the consent panel from the resolved handle graph, not source heuristics (single-subtree scope in this phase; mounts widen it in phase 5).

**First spikes:** prove stable transform IDs across irrelevant edits; verify client bundles contain no handler implementation; prove worker globals can be stripped adequately (fallback: QuickJS/Wasm rather than weakening the contract); a 1,000-row live table through the sandbox bridge (fallback: same-origin same-realm rendering with strict CSP, chosen explicitly).

---

## Phase 4 — agents

Agents as files, runnable from the CLI and chattable in the browser. The subtree is the agent's whole namespace in this phase; per-agent namespace assembly arrives with arbord in phase 5.

Ends when: an agent defined as a markdown file runs against the folder with its declared tools and context via `arbor agent run`, and the same agent can be chatted with in the browser — a tool call visibly mutates the tree and dependent pages update live.

### 4.1 The agent file format and runner

- Define the agent file format: prompt as markdown body; frontmatter carrying model, `tools:` as references to mutations, and `context:` as references to queries.
- Resolve tool/context references through the same handle manifest as components; an agent's capability statement is the same computed consent sentence.
- `arbor agent run <path>`: run the agent against the subtree with only its declared tools and context; tool calls pass through the generated validators like any mutation.

### 4.2 The chat interface

- Opening an agent's `.md` in the browser shows its prompt and frontmatter (editable, per phase 2) plus a chat pane.
- Conversations run through the dev server; tool calls render inline with their consent sentences and results.
- Decide where transcripts live (e.g., a sibling conversations collection) so chats are themselves ordinary tree content.

**First spike:** an agent loop driving a mutation with hostile tool-call arguments; verify the generated validators and write-prefix enforcement hold without any agent-specific code paths.

---

## Phase 5 — arbord: one workspace, mounts, and `system:`

The namespace arrives. The dev server grows into the durable arbord; the subtree grows into the workspace.

Ends when: a developer edits a friendly `system:mounts` record, mounts local folders (including the same subtree at two paths), annotates a read-only mount through an overlay, and runs a phase-4 agent inside a purpose-built restricted namespace assembled from mounts.

### 5.1 Workspace, shared-tree roots, and `system:`

- Define workspace paths, `TreeID`, object/revision identifiers, `Mount` records, access modes, and provenance.
- Implement the unshadowable `system:` tree with schemas for mounts, shared trees, connections, credential references, visited entries, history, trust, and diagnostics.
- Make human-readable files under the local Arbor system directory canonical. Use a rebuildable/versioned SQLite index only for speed.
- Give mounts friendly source aliases and concise Markdown/frontmatter records; resolve technical `TreeID`s/endpoints/credentials through `system:trees`.
- Validate direct edits atomically: publish diagnostics and keep the last valid configuration active.
- Store DSNs/passwords in Keychain or the platform credential store; expose safe `system:connections` records and opaque credential references.
- Record external replication in `system:trees`: mark subtrees under foreign sync (iCloud/Dropbox — declared, or detected via ubiquity paths and placeholder files) so diagnostics can explain churn and later phases can enforce one-replicator-per-subtree ([spec/wire.md](spec/wire.md) §5).
- Implement mounts whose source is a local folder or shared-tree root, including multiple simultaneous mounts of one tree. Materialize the resulting workspace as real files.
- Implement overlays, shadowing, rename/delete behavior, provenance (`tree@revision | overlay | locally-dirty`), and watcher-routed writes.
- Extend the phase-1 index workspace-wide with provenance.

**First spike:** overlay materialization across rename/delete on APFS, including an open editor writing through the materialized path.

### 5.2 Per-agent namespaces

- Derive a restricted per-agent workspace view from selected paths, mounts, and system grants — Plan 9-style namespace assembly at launch.
- Extend `arbor agent run` to launch a phase-4 agent inside an assembled namespace, enforcing `local mount policy ∩ agent grant`.

**First spike:** an agent whose namespace contains two mounts of the same tree at different paths; verify reads, writes, and consent statements stay coherent.

---

## Phase 6 — deploy a subtree to the web

`arbor deploy` compiles any subtree into an ordinary website on commodity hosting. No longer the adoption wedge, this remains the publication on-ramp: it mints identities and crosslinks phase 9 activates, and it is the first, serverless implementation of upstream-hosted queries.

Ends when: a docs site with markdown pages, one live island component, and one Postgres-backed form runs on Vercel from a single `arbor deploy`, with static pages served as plain HTML, the island hydrating, and the form's mutation executing as a serverless function with generated validation — no framework glue code in the repo.

### 6.1 The web-target compiler

- Static-render markdown, `_index.md` directories, and collection views to HTML at build time; hydrate `.tsx` islands on the client.
- Compile each query/mutation handler into a serverless function with its generated validator; the manifest's function IDs and code hashes become stable, versioned API routes.
- Content-hash all assets and immutable outputs for CDN caching; only HTML entry points are revalidated.
- Support a static-only profile (no handlers) that emits a plain file tree deployable anywhere.
- Postgres-backed collections work in deployed handlers via the host's secret store; the connection reference ships, the DSN never does.
- **Honest scope:** deployed mutations write to Postgres-backed collections only. File-backed collections deploy read-only — writable file trees need an authority endpoint, which is the wire's job (phases 8–9). (SQLite does not exist yet at this point in the sequence.)

### 6.2 Host adapters and crosslinks

- Vercel adapter first; Cloudflare second, to prove the target interface is generic rather than shaped around one host.
- Mint the subtree's `TreeID` at first deploy and record it locally, so later phases attach sync to the same identity.
- Emit `<link rel="arbor" …>` and the `Arbor-Tree:` response header carrying `(endpoint, TreeID)` on every page — dormant crosslinks that phase 9 turns into the live upgrade path.
- `arbor deploy --watch` for redeploy-on-change during development.

**First spikes:** cold-start latency and bundle size of a compiled query function; verify the determinism contract holds in the serverless runtime (no clock/randomness leaks through host globals).

---

## Phase 7 — SQLite

The SQLite driver, completing the store lineup before the wire needs its snapshot semantics.

Ends when: dropping `_store.sqlite3` into a collection folder swaps its backing with no query changes; a bare `.sqlite3` file browses as typed tables; the `.sql` relational escape hatch works; and consistent snapshot hashes hold while an external SQLite tool writes concurrently.

- Recognize `_store.sqlite3` folder backing (and bare `.sqlite3` files as browsable database nodes); open databases transactionally, observe committed changes, and serve the same `tree()` collection surface plus the `.sql` Kysely-like escape hatch on database-backed folders.
- Prove migration transparency: the phase-1 file-backed collection corpus re-backed onto `_store.sqlite3` passes its existing query tests unchanged.
- Implement safe SQLite snapshotting through checkpoint/backup APIs; never hash/copy an inconsistent main-file/WAL combination.
- Extend `.arbor/tree.gen.d.ts` typegen to SQLite tables.
- Render SQLite tables through the same built-in collection views; row edits run through the driver's transaction boundary.

**First spike:** open and mutate a SQLite file from Arbor and an external SQLite tool simultaneously; verify watcher/transaction behavior and consistent backup hashes.

---

## Phase 8 — the wire and self-sync

The reference server and the arbord sync engine, proven first on the everyday case: one person, many machines, same workspace.

Ends when: the same workspace is live on a laptop and a cloud box via direct descriptors (no DNS); an edit on either side appears in the other's materialized files; a cloud agent sees the laptop's change; concurrent edits merge or surface as conflict files; pinned mounts work fully offline.

### 8.1 Minimal live reference server

- Implement deterministic DAG-CBOR, SHA-256 object construction/parsing, and Merkle walk/diff over an object-store interface.
- Cross-check canonical encoding with a second implementation before persisting hashes.
- Implement `GET /tree/{treeID}/ref/{path}`, `GET /obj/{hash}`, `POST /tree/{treeID}/push`, `GET /tree/{treeID}/watch/{path}`.
- Store objects in content-addressed files and refs/grants in SQLite.
- Use revocable bearer fixtures scoped by shared tree/path/right; enforce them on ref, watch, and push.
- Build `arbor serve` for a live shared tree and `arbor pull` as the conformance/debugging client.
- Test two distinct shared trees on one endpoint and ensure object deduplication does not blur ref authority or permissions.

### 8.2 Arbord sync engine

- Accept direct private descriptors carrying `(TreeID, endpoint hints, grant)`; no DNS yet.
- Sync remote mounts: watch/poll ref → Merkle diff → verified object fetch → materialize through phase-5 provenance machinery.
- Push rw changes with CAS; on 409, perform three-way merge — block-level for markdown, using the phase-2 journal's intent state (an absent block that is *tombstoned* was deleted; an absent block that is merely unseen gets spliced back, Clamshell's `mergeConflict` rule) — and expose residual conflicts as files plus `system:diagnostics`.
- Extend the phase-2 journal with an applied-revision record kind: arbord journals every sync-applied change with its revision, so local reconcile can't resurrect a peer's deletion and attribution stays three-way (authored here / synced in / external).
- Sync SQLite (phase 7) as consistent whole-database snapshots. On concurrent revisions, preserve both databases and surface a database-level conflict; never byte-merge pages.
- Sync Postgres collection references without credentials; each device maps the reference to its own `system:connections` record.
- Pins never consult refs and work fully offline.
- Ref-watch → Merkle diff → read-set intersection reuses the phase-3 query subscription engine.

---

## Phase 9 — sharing, public names, and publication

Sharing grows outward over the phase-8 machinery: capability flow between people first, then public names and the web upgrade bridge, then the portability proofs — static origins, adapters, and the delegation experiment.

Ends when, on the private half: one person shares a workspace folder, another accepts it at a different workspace path, both edit the resulting shared tree concurrently and see live query updates, either can annotate a separate read-only tree through an overlay, and revocation behaves as specified (grants change; recipients' cached and overlaid work survives). And on the public half: a DNS name resolves to a browsable tree, a phase-6 deployed website upgrades to its live tree through the crosslinks, and `bake → static host → arbor pull` round-trips byte-identically.

### 9.1 Capability flow

- Implement `arbor share <path>`: create a shared tree, move the folder's backing data behind it, leave a mount at the same workspace path, issue a scoped grant, and produce an invitation descriptor. Warn (or refuse) when the subtree is marked as under foreign replication in `system:trees` — one replicator per subtree ([spec/wire.md](spec/wire.md) §5).
- Implement `arbor accept`: validate descriptor, store credential reference, choose a local mount path, and create the `system:mounts` record.
- Enforce effective access as remote grant ∩ local mount mode ∩ execution grant.
- Keep v1 permissions to revocable bearer grants with read/append/update and subtree scopes; no account service or group system yet.
- Surface shared, stale, pinned, overlay, and conflict states through arbord events (TreeHopper consumes them in phase 10).

### 9.2 Public names and the upgrade bridge

- Resolve whole-tree public aliases through DNS `_arbor` records carrying `(endpoint, TreeID)`.
- Implement visited trees: transient mounts in arbord-private storage, lazy Merkle walk, TTL/GC, and promotion to a durable workspace mount.
- Record canonical positions as descriptive tree metadata; render them in provenance, never in routing or access.
- Activate the phase-6 crosslinks: an Arbor-aware client landing on a deployed website reads `Arbor-Tree:` and upgrades to the live tree; `arbor deploy` and `arbor serve` now publish the same identity both ways.
- Host upstream-hosted queries on the reference server (the phase-6 serverless functions' semantics, now at the tree's authority), with per-query version lineage and in-place fixes per the spec.

### 9.3 Static wire origin

- Implement `arbor bake`: shared-tree snapshot → static ref/object directory.
- Round-trip `bake → nginx/S3/GitHub Pages → arbor pull → byte-identical tree`.
- Make staleness and deployment-updated tips explicit; static origins do not pretend to support push/watch.

### 9.4 Storage and transport adapters

- **Git bridge:** expose repository commits/trees as Arbor refs/objects; optionally provide arbord-side git-native mounts when no bridge runs.
- **atproto bridge:** expose a PDS repository as a read-only visited tree (both sides are signed Merkle structures), and optionally publish a public Arbor subtree's changes as atproto records ([social-networking.md](social-networking.md)).
- **Database projections:** optional Postgres table snapshots/offline replicas and finer SQLite logical changesets, layered beneath the existing `tree()`/`.sql` API.
- **Postgres endpoint:** rows remain truth; serializer/hash maintenance plus LISTEN/NOTIFY power refs/watch when a database should publish as a full Arbor shared tree.
- **Cache cascade:** configured mirrors, signed tree descriptor hints, LAN discovery/mDNS, and ordinary HTTP proxy caching for immutable verified objects.
- **iOS relay:** Mac arbord as home relay, existing TreeHopper/iCloud materialization first; Tailscale/local arbord access next; Swift sync-core later.
- Optional userfs/FUSE mode for huge shared trees.

### 9.5 Public subtree delegation experiment

- Reuse the mount target shape in a signed authority-controlled longest-prefix mapping from a public name to `(TreeID, path)`.
- Keep permissions entirely on the target shared tree; delegation grants nothing.
- Specify proof of parent-prefix authority, loop detection, revision behavior, caching, and diagnostics.
- Implement only after whole-tree aliases and capability sharing show a concrete need.

---

## Phase 10 — TreeHopper native

The native browser/editor, as specified in [treehopper-integration.md](treehopper-integration.md). This is a parallel track: it can begin as soon as the phase-5 arbord exists, with the network states landing after phases 8–9. The phase-2 web editor is the first editing surface; TreeHopper remains the native, offline-polished browser/editor with its own durability model.

Ends when: an Arbor workspace opens in TreeHopper; mounts and connections have friendly editors/source views; local folders and mounts resolve correctly; SQLite/Postgres collections have useful built-in browsers; read-only/overlay pages behave correctly; `.tsx` script links render as live islands; and the share-folder and accept-invitation sheets drive the phase-9 flows.

- Add one classifier branch for paths outside the current physical workspace → arbord `/v/resolve`.
- Render mount records from `system:mounts` as readable subpage-like rows and an editable table/form without serializing them into `_index.md`; keep source view equivalent.
- Add `system:connections` UI for pasting/testing a DSN, selecting a credential record, and showing safe connection status.
- Render SQLite- and Postgres-backed collections as database/table browsers through arbord built-ins.
- Add arbord FTS results to Cmd+P; provenance chips; read-only/overlay banners.
- Exercise arbord mutations and overlay routing under open TreeHopper pages before network sync adds another source of writes.
- Add island blocks using locked-down WKWebViews hosting `/render/{path}` with query/mutation message handlers and the consent panel from the compiler manifest.
- Coordinate sidecars: arbord ignores TreeHopper `.history/` and `Trash/`; TreeHopper does not treat arbord-private cache/system backing as content. When an arbord is present, TreeHopper may consume its journal/Recover/trash surfaces instead of running Clamshell's in parallel; Clamshell's in-tree journal remains arbord-less/iOS path.
- Add “Share this folder…”, invitation acceptance, workspace-path choice, permission display, and revocation surfaces.

**First spikes:** `PatchEngine.reconcile`'s mtime gate under arbord writes; a 50-file mutation burst; N WKWebViews in the lazy stack with focus arbitration.

---

## Deliberate absences

No general account/auth service, no public name registry, no `_delegate` nodes, no secret connection strings in published trees or deploy artifacts, no general web SPA browser, and no CRDT promise. V1 SQLite sync does not promise automatic multi-writer row merging. Phase-6 deployed sites do not write to file-backed collections — writable trees wait for the wire rather than getting a bespoke pre-wire write path. The static wire origin waits for the live protocol it must round-trip against. The founding deployment is one arbord plus one small live reference server; everything else must earn its place as an adapter or later capability.
