# Build plan
*Forward roadmap for Arbor and the reference implementation. Delivered work and evidence live in [plan-history.md](plan-history.md); [plan-native.md](plan-native.md) owns native TreeHopper, Hunch migration, Clamshell, and iCloud-native integration.*

## Status at a glance

The local daily driver and the reference community-hosting foundation are implemented. Arbor can browse and edit the local filesystem, promote ordinary folders into canonical shared trees, host person and group profiles, claim reserved profiles, synchronize placements, and apply whole-tree access through the browser and CLI.

Workspace composition is now implemented. The roadmap begins with data and SQLite rather than the operational and account-lifecycle follow-ups left by the community-hosting foundation.

| Status | Milestone | Outcome |
|---|---|---|
| **Implemented** | 1. Workspace composition | Distinct trees mount in a reader-local layout; visits and merged surfaces preserve provenance. |
| **Next** | 2. Data and SQLite | Transaction-safe SQLite backing and backing-independent collection mutations. |
| **Planned** | 3. Agents | File-defined agents using built-in Arbor operations over restricted composed namespaces. |
| **Planned** | 4. Scripts runtime | Colocated components, queries, mutations, and custom agent tools with typed handles, isolation, and reactive execution. |
| **Planned** | 5. Deployable applications | Static baking, portable application manifests, live handlers, and deployment adapters. |
| **Later** | 6. Account lifecycle and hosting administration | Pairing, identity switching, recovery, disputes, and production operational tooling. |

Milestone numbers express product priority, not a claim that every implementation task is serial. Data and SQLite come first to establish one backing-independent collection mutation contract. Agents then begin with Arbor's built-in tree operations rather than waiting for the general scripts runtime; that runtime follows the first agent slice and consumes the collection contract established by Milestone 2.

```text
implemented local + community-hosting foundation + workspace composition
   └── data + SQLite ── agents ── scripts runtime ── deployable applications

account lifecycle, hosting administration, and hardening follow
without blocking those forward product capabilities
```

## Implemented foundation

The implemented foundation is summarized here only to establish what later milestones may depend on. Source ownership, intentional limits, and verification evidence belong in [plan-history.md](plan-history.md).

- The local daily driver provides filesystem-wide browsing/editing, source-preserving Markdown, projected directories, collections, durable REST mutations and event handoff, TypeScript/Swift clients, search/backlinks/recovery, and safe cloud-placeholder handling.
- Shared trees have stable `TreeID`s, immutable deterministic objects, CAS synchronization, canonical HTTP/Arbor names, raw TreeID fallback, whole-tree access, and independently accessed nested boundaries.
- One host represents one community with a public root profile, complete person/group profile trees at `/~<handle>`, authored reservations and membership, atomic first-claim-wins profiles, and account/device credentials.
- Share promotes a visible subtree in place without changing its URL or OS location. External folders appear as virtual mounted children, and longer accessible boundaries resolve by longest prefix.
- TreeHopper supplies profile, claim, and Share surfaces; `browse`, `sync`, `unsync`, `serve`, and recovery-oriented `connect` plumbing provide the CLI surface.
- Reader-local nested placements compose distinct trees without entering a parent graph or revision. Home includes durable remote visits, **Add to workspace**, nested placements, and provenance-correct search, backlinks, Trash, and recovery surfaces.

The durable product contracts live in the topic specifications rather than this roadmap:

- [wire and community authority](spec/wire.md) owns canonical boundaries, promotion, profiles, claims, access, objects, refs, and HTTP projection;
- [locators](spec/locators.md) owns canonical names, raw TreeID fallback, revision pins, and resolution;
- [browser](spec/browser.md) owns browsing, profile control, Claim, Share, and access UI;
- [CLI](spec/cli.md) owns command forms and deployment arguments;
- [`system:` and placements](spec/system.md) owns safe account state, credentials, placements, overlays, and local ceilings;
- [arbord REST](spec/arbord-rest.md) owns the local client and mutation boundary.

---

## Milestone 1 — workspace composition

**Status: Implemented on 2026-08-02. See [plan-history.md](plan-history.md#workspace-composition-forward-milestone-1).**

Outcome: a workspace can mount distinct local and shared trees wherever they make sense, while navigation and cross-tree surfaces retain exact provenance and remote authority.

- Distinct shared `TreeID`s can occupy nested local paths; longest-prefix navigation enters the child while parent discovery, watching, indexing, snapshots, pulls, and revisions exclude it.
- Home presents nested placements, account-visible trees, durable remote visits, **Add to workspace**, and merged recovery surfaces without fabricating aggregate content.
- Search, explicit cross-tree backlinks, Trash, and recovery retain the originating `TreeID` and local placement.
- Remote visits persist safe metadata and a credential-free read cache for ordinary offline reopening.

Completion gate: Alice mounts two different shared trees at locally meaningful paths, visits a third unplaced tree, adds it to her workspace, and sees provenance-correct search, backlinks, Trash, and recovery results without changing remote access or duplicating mounted content.

## Milestone 2 — data and SQLite

**Status: Next.**

Outcome: file and SQLite collections use the same typed query/mutation surface while retaining backing-appropriate durability.

- Recognize `_store.sqlite3` collections and bare database nodes.
- Introspect tables and expose the same typed collection surface.
- Observe commits and run row mutations inside SQLite transactions.
- Snapshot through backup/checkpoint APIs; never copy a live main/WAL pair naively.
- Run the backing-independent collection corpus on SQLite.
- Preserve concurrent revisions as whole-database conflicts until logical changesets exist.

Completion gate: changing a file collection to SQLite changes no backing-independent query or mutation call sites; external SQLite writes remain observable and snapshots remain consistent during WAL activity.

## Milestone 3 — agents

**Status: Planned. Depends on the implemented workspace composition and is scheduled after Data and SQLite, but not on the general scripts runtime.**

Outcome: a Markdown-defined agent runs against a legible, permission-bounded view of the same workspace humans browse.

- Define agents as Markdown prompt/config pages whose initial tools are Arbor's built-in read, search, navigation, and mutation operations.
- Assemble restricted namespaces from visible shared-tree placements, remote access, and explicit process ceilings.
- Run agents in an isolated process/runtime that can address only its assembled namespace.
- Render the same agent in CLI and TreeHopper with inspectable ordinary-tree transcripts and effects.
- Present the effective read/write namespace and built-in operations as a concrete consent statement before execution.

Completion gate: a file-defined agent can research and update two mounted trees with explicit consent, cannot address content outside its assembled namespace, and leaves a readable versioned transcript of its actions.

## Milestone 4 — scripts runtime

**Status: Planned. Follows the first built-in-tool agent slice and uses the backing-independent collection contract from Milestone 2.**

Outcome: ordinary `.tsx` files can safely read, render, and mutate workspace content through generated, inspectable boundaries, and their handles can become optional agent tools.

- Recognize explicit query/mutation constructors while retaining ordinary TypeScript inference.
- Generate validators and stable typed handles; infer literal read/write prefixes and require declarations for computed paths.
- Run deterministic handlers in isolated workers with a scoped tree client as their only authority.
- Track read sets and rerun affected subscriptions.
- Render components as sandboxed TreeHopper islands.
- Add `arbor run` over the same handle identity.
- Allow an agent configuration to name typed query/mutation handles as additional tools without widening its namespace.

Completion gate: one `.tsx` file colocates a component, query, and mutation over two existing backings; client bundles contain handles but no handler code; invalid input and undeclared paths fail before data access; one agent safely uses a generated mutation handle.

## Milestone 5 — deployable applications

**Status: Planned. Canonical live HTTP publication is already part of the implemented foundation.**

Outcome: the same tree and script application can be published statically or run on supported live hosts from one portable description.

- `arbor bake` emits a static ref/object directory for a dumb host.
- Compile one portable application manifest for pages, assets, static query results, and live handlers.
- Add one static and two live adapters only after the common manifest exists.
- Protect deployed handlers with the same tree access and process validators as local execution.
- Emit `<link rel="arbor">` and `Arbor-Tree` crosslinks.

Completion gate: one tree publishes statically with working links/assets, and one custom live script deploys to both chosen live targets from the same manifest.

## Milestone 6 — account lifecycle and hosting administration

**Status: Later. These follow-ups do not block the forward workspace, script, data, or application milestones.**

Outcome: communities can recover identities and operate persistent hosts without relying on development escape hatches or manually transferred raw credentials.

- Pair another device through an end-user flow while keeping raw credentials out of content and diagnostics.
- Switch among stored identities while retaining one explicit active identity per Arbor data home.
- Define understandable claim recovery, dispute resolution, and administrator reset without changing profile `TreeID` identity.
- Add confirmed removal and restoration flows for claimed community members.
- Add historical/recovery UI for access changes and revocation.
- Productize permanent-domain, persistent-volume, graceful-restart, backup/restore, and migration diagnostics for community hosts.

Completion gate: an operator restores a persistent community on a replacement host, and a member with a lost device recovers the same profile identity onto a new device through an auditable user-facing flow.

Nested groups, cross-community membership, boundary moves/aliases, simultaneous active local identities, and production HA remain deferred unless this milestone explicitly adopts them.

## Deferred workspace extensions

These are not required for mounting distinct trees together, visits, aggregate workspace surfaces, or the first agent/runtime milestones:

- placing the same `TreeID` at several local OS paths simultaneously;
- placement-specific read-only ceilings, which become meaningful when one tree has several placements;
- durable pinned placements of immutable historical revisions;
- reader-local annotation/proposal overlays that shadow or augment a mounted tree.

Historical revisions may still be browsed transiently when revision locators are implemented. A nested mount is path composition, not a reader-local overlay: longest-prefix resolution enters the mounted child tree instead of merging two versions of the same file.

## Continuous hardening

Hardening is not a numbered product dependency:

- expand browser coverage for group creation, access revocation, disconnect, and restoration flows;
- perform focused accessibility and responsive audits;
- strengthen malformed and partial legacy-state recovery;
- add richer bounded ordinary-file metadata and safe previews;
- add provider-specific materialization controls where reliable;
- measure cold/warm behavior on representative large trees;
- keep lazy indexing extension-aware so it never parses binary or placeholder bytes.

## Deliberate absences

Unless an accepted milestone supplies a concrete need:

- no path-scoped remote access: a subtree with different access is a nested shared tree;
- no separate local multi-tenant account or group-administration database: groups are authored trees;
- no REST v2 or compatibility adapter for in-place REST v1 changes;
- no SDK generation or universal capability negotiation;
- no persisted event replay across daemon epochs;
- no universal durable identity for every ordinary local file;
- no generic store, transport, credential, or deployment plugin framework;
- no production HA, horizontal-scaling, or retention subsystem.

## Planning reference

The topic specs describe the complete intended product. This file records implementation order, temporary cuts, completion gates, and current status. [plan-history.md](plan-history.md) records completed evidence; [plan-native.md](plan-native.md) contains platform-specific native work.

- **Implemented** means the focused behavior and its acceptance checks pass in current source.
- **Next** identifies the immediate substantial product milestone.
- **Planned** has an accepted product contract but no complete reference slice.
- **Later** is accepted follow-up work intentionally placed behind the forward product capabilities.

Implement the smallest end-to-end system that proves a visible product feature while preserving data, durable acknowledgement, conflict safety, deterministic protocol behavior, and cross-language agreement. Prefer direct readable code and fixtures to version adapters, generic provider actions, plugin frameworks, or production administration. Introduce an abstraction only when a second concrete implementation needs it.

Future agents must inspect source, tests, and `git status` before trusting a status label. Do not rewrite a partial implementation as future work, and do not weaken a future-product topic spec to match a staged reference UI.
