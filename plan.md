# Build plan
*Forward roadmap for Arbor and the reference implementation. Completed earlier milestones and their evidence live in [plan-history.md](plan-history.md). [plan-native.md](plan-native.md) owns native TreeHopper, Hunch migration, Clamshell, and iCloud-native integration.*

## How to use this plan

The topic specs describe the complete intended product. This file alone records implementation order, temporary cuts, placeholders, and current status.

- **Implemented** means the focused behavior and listed acceptance checks pass in the current source.
- **Partial** means an end-to-end slice exists but a listed gate or external prerequisite remains.
- **Next** is the immediate architectural milestone.
- **Planned** has an accepted product contract but no complete reference slice.
- Completed older work moves to [plan-history.md](plan-history.md) with source pointers and evidence.

Future agents must inspect source, tests, and `git status` before trusting a status label. Do not rewrite a partial implementation as future work, and do not weaken a future-product topic spec to match a staged UI.

## Reference-implementation discipline

Implement the smallest end-to-end system that proves a visible product feature while preserving data, durable acknowledgement, conflict safety, deterministic protocol behavior, and cross-language agreement. Prefer direct readable code and fixtures to version adapters, generic provider actions, plugin frameworks, or production administration. Introduce an abstraction only when a second concrete implementation needs it.

Vocabulary:

- **workspace** — the tree a person/process sees;
- **shared tree / `TreeID`** — an independently identified sync/history/permission boundary;
- **tree placement** — a reader-local canonical path for a shared tree;
- **`PageID`** — durable identity of a materialized Markdown document;
- **arbord** — local workspace/runtime authority;
- **wire authority** — always-on owner of tree tips, aliases, grants, and immutable objects;
- **TreeHopper** — browser/editor;
- **script** — a `.tsx` component/query/mutation file.

There is no new durable local-only tree concept. Legacy `source: local` records are migration material, not the product model.

## Current state

The local daily driver is implemented: filesystem-wide browsing/editing, source-preserving Markdown, projected directories, collections, ordinary-file byte routes, durable REST mutations and event handoff, TypeScript/Swift clients, search/backlinks/recovery within durable trees, and safe cloud-placeholder handling.

The current worktree additionally implements the local reference slice of canonical tree hosting:

- `packages/wire`: deterministic CBOR objects, one root tip per `TreeID`, CAS push/watch/ref/object endpoints, graph/hash/quota validation, nested-tree boundaries, alias resolution, and publication;
- `arbor serve`: the standalone authority/publication process, launched from the main CLI with persistent-volume and health/restart configuration;
- arbord: `TreeID`/`system:` REST model, secret-aware system mutations, legacy promotion, placement, immediate pushes, polling pulls, and preserved conflict state;
- TreeHopper web: **Give this subtree a URL**, canonical URL/sync/publication controls, remote placement, and the reserved Sharing layout;
- CLI: the primary `browse` command and both idempotent `sync` forms for owner promotion/publication and remote read-only placement;
- TypeScript and Swift fixtures/types updated together with the public root surface removed.

Local conformance and end-to-end verification are recorded under the immediate milestone. The newly specified shared locator parser and pinned historical views remain local work. A permanent custom hostname and real Railway volume also remain prerequisites before promoting the first non-fixture tree.

## Intentional divergence from the previous roadmap

The prior roadmap separated self-sync, canonical names, and publication into successive milestones and used sharing as the action that created tree identity. That ordering created needless temporary models: a self-synced tree without its user-facing name, path-level mutable refs, durable local tracking, and a later identity-changing share operation.

The new order combines **private self-sync + canonical URL + minimal live HTTP publication**. **Give this subtree a URL** is the one transition from ordinary files to a shared tree. Recipient sharing operates on that identity next. The wire has one mutable root hash per `TreeID`, not a ref per path. Local REST control uses `system:` records and singleton durable mutations, not public root/tree CRUD.

## Status at a glance

| Status | Milestone | Outcome |
|---|---|---|
| **Partial** | 1. Canonical tree hosting | Local reference host, promotion, self-sync, canonical names, and private/public modes; pinned locators and the permanent deployed hostname remain. |
| **Next** | 2. Recipient sharing and workspace composition | Invitations, scoped grants, revocation, attenuation, overlays, visits, and multiple placements. |
| **Planned** | 3. Scripts and agents | Colocated components/queries/mutations, isolation, then file-defined agents. |
| **Planned** | 4. Data and SQLite | Transaction-safe SQLite backing and backing-independent collection mutations. |
| **Planned** | 5. Fuller publication profiles | Static baking, custom deployed applications, and provider adapters beyond canonical live publication. |
| **Polish** | 6. Daily-driver hardening | Focused ordinary-file, provider, accessibility, and scale work. |

```text
canonical identity + self-sync + live publication
                         │
                         ▼
recipient sharing + workspace composition
            │                         │
            ▼                         ▼
     scripts + agents          data + SQLite
            │                         │
            └──────────┬──────────────┘
                       ▼
          fuller publication profiles
```

---

## Milestone 1 — canonical tree hosting

**Status: Partial. The live local/URL slice and tests exist; revision-pinned locators plus a permanent custom hostname and real hosted-volume restart check remain.**

### Product slice

Any directory can choose **Give this subtree a URL**. Promotion reserves one immutable slug and `TreeID`, uploads a verified initial Merkle root, reuses existing private journal/index/recovery state, replaces the placement, and begins private self-sync. The UI shows matching HTTP/Arbor names, raw identity fallback, sync state, and private/public-read/public-write modes.

The implemented ordinary CLI surface is:

```text
arbor browse <path>
arbor sync <local-path> <my-canonical-url> -<mode>
arbor sync <anyones-canonical-url> <local-path>
```

Both `sync` forms are idempotent. Lower-level tree/publication operations remain available for explicit administration and recipient commands follow in Milestone 2.

The product spec now generalizes these operands as **Arbor locators**: local paths, named HTTP/Arbor locations, raw TreeID locations, and optional immutable revision suffixes. The current CLI implements the live local-path/named-URL subset. A shared locator parser plus historical browse and pinned placement are not yet implemented.

### Intentional first-slice cuts

These are implementation cuts, not changes to the topic specs:

- one Railway-hosted server, one owner bearer token, and one active authority process;
- private, public-read, and anonymous public-write before recipient grants;
- the Sharing section occupies its final visual position but is disabled with “Sharing with people is not available yet”;
- one immutable slug segment per tree;
- live local paths and named URLs only in the CLI; revision-pinned locators are specified but not yet parsed;
- current tips may be materialized/proxied to reuse TreeHopper, but compliant authorities need not store materialized files;
- owner credentials are device-global rather than paired/per-device;
- no static bake, custom deployed app, multi-user administration, or production HA/observability.

### REST/control work

- Public `RootID`, `RootDescriptor`, `RootsPage`, and `/v1/roots` are removed.
- `TreeRef` is `"local" | "system" | TreeID`; unpromoted paths are OS-absolute local refs.
- Safe records are read under `system:device`, `system:server`, `system:trees`, `system:credentials`, `system:visited`, and `system:diagnostics`.
- Singleton operations are `configureServer`, `promoteTree`, `placeTree`, and `setTreePublication`.
- Raw owner tokens go directly to the OS credential store; journals/records/events/errors contain only safe status and digest.
- System mutations share durable IDs, receipts, retries, conflicts, and events with content mutations but cannot be mixed with them.

### Wire/host work

```text
GET  /.arbor/trees/{TreeID}/ref
POST /.arbor/trees/{TreeID}/push
GET  /.arbor/trees/{TreeID}/watch
GET  /.arbor/objects/{hash}
```

- one CAS tip per tree; immutable deterministic objects below it;
- partial Merkle fetch, complete graph validation, corruption rejection, quotas, and private-object reachability checks;
- nested independent trees are boundary entries and never inherit parent publication;
- `/.well-known/arbor/<slug>` resolves the reference alias;
- persistent [Railway volume](https://docs.railway.com/volumes), health route, graceful shutdown, and [automatic restart configuration](https://docs.railway.com/deployments/restart-policy);
- live HTTP projection returns 404 for private, read-only surfaces for public-read, and anonymous CAS for public-write with warning/rate/storage limits.

### Sync behavior

- Promotion is transactional from the local user's point of view: failure leaves original files and legacy state usable.
- Authored shared-tree mutations snapshot and CAS-push immediately.
- A background loop pulls when only remote advanced and pushes when only local advanced.
- If both differ from the common ref, neither side is discarded; local content remains and sync surfaces an explicit conflict.
- Restart restores ref/object metadata and last verified placements.

### Verification

Implemented automated checks:

- TypeScript typecheck and Swift package fixtures agree on new tree/system shapes;
- no public fixture/client type contains `RootID`, `RootDescriptor`, or `/v1/roots`;
- canonical CBOR determinism, Merkle diff, nested boundaries, graph/hash rejection;
- private/public-read/public-write authority behavior and persistent restart;
- legacy promotion and publication through arbord;
- two isolated Arbor data homes syncing through the authority, including offline divergence preservation;
- both primary CLI sync forms repeated without minting a second tree or placement;
- remote public-read placement rejection and public-write access reconciliation/anonymous push;
- raw configured token absent from durable text records/journals;
- the full browser E2E suite, including canonical control, publication changes, Home records, and the inert Sharing section.

Remaining before status becomes Implemented:

- implement the shared locator parser and revision-pinned `browse`/remote-to-local `sync`;
- supply the permanent custom hostname, deploy the Railway service with a mounted volume, and repeat restart/private/public checks against it.

The last item is deliberately required before promoting a real personal tree. Localhost fixtures remain the only promotion targets until then.

---

## Milestone 2 — recipient sharing and workspace composition

**Status: Next.**

### Product contract

An owner invites a recipient to an existing shared tree or subtree, chooses rights, adjusts/revokes them later, and sees current recipients. The recipient accepts, chooses a local placement and stricter access ceiling, and may use a local overlay for read-only work. Revocation preserves cached and overlay work while removing new remote authority.

### Required work

- authority grant metadata, scoped graph-diff validation, invitation descriptors, expiry, and revocation;
- system mutations `createInvitation`, `acceptInvitation`, `setGrant`, `revokeGrant`, and `setPlacementAccess`;
- complete `system:trees/<TreeID>/shares/<GrantID>` safe records;
- working TreeHopper Sharing controls exactly as specified in [spec/browser.md](spec/browser.md);
- multiple placements of one source, local attenuation, overlays, transient visits, placement promotion, and accurate provenance;
- nested-tree access resolution under each child's own grant/publication mode;
- per-device credentials/pairing and owner-device administration beyond one bearer token;
- merged browser search/recovery views without inventing aggregate REST resources.

Completion gate:

- Joe invites Alice read/write to one subtree; Alice places it at a different path;
- Alice can attenuate to read-only and annotate in an overlay;
- changes outside her grant are rejected even when submitted inside a valid whole-tree CAS;
- adjusting and revoking access updates immediately and preserves cached/overlay work;
- the same `TreeID` may have multiple local placements with correct identity/events;
- private nested children remain unavailable without their own access.

---

## Milestone 3 — scripts and agents

**Status: Planned.**

- Recognize explicit query/mutation constructors while retaining ordinary TypeScript inference.
- Generate validators and stable typed handles; infer literal read/write prefixes and require declarations for computed paths.
- Run deterministic handlers in isolated workers with a scoped tree client as their only authority.
- Track read sets and rerun affected subscriptions; render components as sandboxed TreeHopper islands.
- Add `arbor run` over the same handle identity.
- Define agents as Markdown prompt/config pages whose context and tools are query/mutation references.
- Assemble restricted namespaces from shared-tree placements and grants; render the same agent in CLI/browser with inspectable ordinary-tree transcripts.

Completion gate: one `.tsx` colocates component/query/mutation over two backings; client bundles contain handles but no handler code; invalid input and undeclared paths fail before data access; a file-defined agent uses the same handles and visible consent.

## Milestone 4 — data and SQLite

**Status: Planned.**

- Recognize `_store.sqlite3` collections and bare database nodes.
- Introspect tables and expose the same typed collection surface.
- Observe commits and run row mutations inside SQLite transactions.
- Snapshot through backup/checkpoint APIs; never copy a live main/WAL pair naïvely.
- Re-run the backing-independent collection corpus on SQLite.
- Preserve concurrent revisions as whole-database conflicts until logical changesets exist.

Completion gate: changing a file collection to SQLite changes no backing-independent query call sites; external SQLite writes remain observable and snapshots remain consistent during WAL activity.

## Milestone 5 — fuller publication profiles

**Status: Planned. Canonical live HTTP publication already belongs to Milestone 1.**

- `arbor bake` emits a static ref/object directory for a dumb host.
- Compile one portable application manifest for pages, assets, static query results, and live handlers.
- Add one static and two live adapters only after the common manifest exists.
- Protect deployed handlers with the same grants/validators as local execution.
- Emit `<link rel="arbor">` and `Arbor-Tree` crosslinks.

Completion gate: one tree publishes statically with working links/assets and one custom live script deploys to both chosen targets from the same manifest.

## Milestone 6 — polish and hardening

**Status: Polish; non-blocking.**

- richer bounded ordinary-file metadata and safe previews;
- provider-specific materialization controls where reliable;
- focused accessibility/responsive audits;
- measured cold/warm behavior on representative large trees;
- extension-aware lazy indexing that never parses binary or placeholder bytes.

## Deliberate absences

Unless an accepted milestone supplies a concrete need:

- no local multi-tenant account/group administration;
- no REST v2 or compatibility adapter for this in-place v1 change;
- no SDK generation or universal capability negotiation;
- no persisted event replay across daemon epochs;
- no production HA/horizontal scaling/retention subsystem;
- no universal durable identity for every ordinary local file;
- no generic store, transport, credential, or deployment plugin framework.
