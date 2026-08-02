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
- **wire authority** — always-on owner of tree tips, aliases, access entries, claims, and immutable objects;
- **TreeHopper** — browser/editor;
- **script** — a `.tsx` component/query/mutation file.

There is no new durable local-only tree concept. Legacy `source: local` records are migration material, not the product model.

## Current state

The local daily driver is implemented: filesystem-wide browsing/editing, source-preserving Markdown, projected directories, collections, durable REST mutations and event handoff, TypeScript/Swift clients, search/backlinks/recovery, and safe cloud-placeholder handling.

The reference host and local arbord now implement the first community-hosting slice:

- one public-read `type: group` community tree at `/`;
- complete person and group profile trees mounted at `/~<handle>`;
- arbitrary nested shared-tree boundaries resolved by longest accessible prefix;
- in-place promotion that preserves the canonical path while changing the enclosing `TreeID`;
- virtual mounted children for external local folders, without moving or copying filesystem content;
- account/device credentials and one active local community account instead of a process-wide owner token;
- authored community reservations and atomic first-claim-wins person profiles;
- authored group membership, with group writers administering membership and membership alone granting no write;
- `everyone`, person/group profile, and link access with revocation;
- browser Profile and Share surfaces, plus `sync` and `browse` CLI primitives; `connect` remains account-import plumbing.

Revision-pinned locators, production deployment, recovery/reset for disputed claims, multiple active local identities, nested groups, and cross-community membership remain outside this slice.

## Accepted architecture

One host represents one community and exposes one mounted canonical namespace:

```text
/                       community profile tree
/~joe/                  Joe's complete profile tree
/~editors/              Editors' complete group profile
/~editors/handbook/     ordinary content or an independent shared subtree
```

A canonical boundary is a separate record from local placement:

```ts
interface CanonicalBoundary {
  path: string;
  tree: TreeID;
  parentTree: TreeID | null;
  kind: "community-profile" | "person-profile" | "group-profile" | "shared-subtree";
}
```

Resolution chooses the longest accessible boundary and walks the remainder within that tree. A longer boundary is valid only when the parent graph contains that exact nested-tree entry; an unrelated alias cannot shadow content. Promotion replaces or reserves the exact parent entry atomically. Parent pushes that would overwrite a mounted child fail with `reserved-boundary`.

Profiles are whole trees, not distinguished single pages. Their `TreeID` is the stable person/group identity; `_index.md` supplies mutable authored profile content. Community and group membership are ordinary locators in the profile document. Same-community unresolved person locators reserve handles. First claim creates and mounts the person profile and returns a device credential; later attempts return `already-claimed`.

## Status at a glance

| Status | Milestone | Outcome |
|---|---|---|
| **Partial** | 1. Canonical tree hosting | Merkle trees, CAS sync, live HTTP projection, canonical boundaries, and raw TreeID fallback; pinned locators and production deployment remain. |
| **Partial** | 2. Community hosting | Multi-account profiles, claims, groups, Share/access, longest-prefix mounts, and virtual external folders have a reference slice; production pairing/recovery and the complete cross-language/browser gate remain. |
| **Planned** | 3. Workspace composition | Multiple placements, local ceilings, overlays, visits, and merged workspace views. |
| **Planned** | 4. Scripts and agents | Colocated components/queries/mutations, isolation, then file-defined agents. |
| **Planned** | 5. Data and SQLite | Transaction-safe SQLite backing and backing-independent collection mutations. |
| **Planned** | 6. Fuller publication profiles | Static baking, custom deployed applications, and provider adapters beyond canonical live publication. |
| **Polish** | 7. Daily-driver hardening | Focused ordinary-file, provider, accessibility, and scale work. |

```text
canonical identity + self-sync + live publication
                         │
                         ▼
        community profiles + groups + sharing
                         │
                         ▼
               workspace composition
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

**Status: Partial. The live local/URL slice exists; revision-pinned locators plus a permanent hostname and hosted-volume restart check remain.**

One mutable root hash belongs to each `TreeID`, with immutable deterministic objects beneath it. CAS push/watch/ref/object endpoints validate graphs, hashes, reachability, and quotas. HTTP and `arbor://` spellings name the same canonical path; raw `arbor://tree/<TreeID>` remains the durable fallback.

The milestone now uses mounted paths rather than one-segment slugs. Public access is an `everyone` entry (`none`, `read`, or `write`), not a parallel publication column. Nested boundaries never inherit access. Immediate push, background pull, offline divergence preservation, restart recovery, and read-only remote placement remain as implemented.

Remaining work:

- shared parsing for immutable revision suffixes and pinned browse/sync;
- permanent deployed hostname, mounted volume, graceful restart, and private/public verification;
- static bake and custom applications remain in fuller publication profiles.

---

## Milestone 2 — community hosting

**Status: Partial. The reference TypeScript host, arbord, CLI, browser, and focused integration coverage exist.**

### Product contract

The community is the public-read group profile at `/`. Person and group profiles are complete public-read trees at `/~<handle>`. Handles are unique and exclude `~`.

Membership is authored directly:

```yaml
members:
  - arbor://garden.example/~joe
  - arbor://garden.example/~alice
```

An unresolved same-community person locator reserves its handle. Anyone may browse that URL as an empty profile. Its Claim action asks only for a visible local folder, which may be new or use `~`; the browsed location already supplies the community and handle. The first successful submission creates `type: person` profile content, mounts the new `TreeID`, and stores the returned device credential. Removing a pending locator releases the handle. Removing a claimed locator disables future authenticated operations without deleting its tree.

Group profiles list existing person locators as members. Writers of the group tree administer its namespace and membership; membership alone does not grant write. Resource trees may independently grant the group read or write access.
Creating a group uses ordinary content and sync rather than a dedicated account-panel form: author a folder whose root `_index.md` declares `type: group`, then sync it with public-read access to an available `/~<handle>` boundary.

**Share** promotes a visible subtree in place. It is disabled until the current local account is connected, its credential is available, and it has a profile. Missing credentials retain safe identity metadata and point to `arbor connect <origin>` recovery; Share-sheet mutation errors remain visible. Every new share uses an additive access builder with a locked profile-writers row and requires either one or more explicit public/person/group rules or an explicit Private choice. The complete initial rule set is applied atomically with promotion. Existing boundaries reopen the builder for public/person/group/link access and revocation. An external folder chooses an available child path beneath a writable profile and remains at its existing OS path as a virtual mounted child.

The profile control owns public-profile editing, writable profile/group namespaces, group creation, and disconnect. Claiming belongs to the browsed empty profile; credential activation remains CLI recovery plumbing. Credentials never appear in content, journals, receipts, events, errors, diagnostics, or logs.

### Implemented control surface

```text
arbor sync [--clear-access] [--access <subject>=<read|write|none>[,...]] <local-path> <canonical-url>
arbor sync <canonical-url> <local-path>
arbor unsync <local-path> [<canonical-url>]
arbor browse <locator>
arbor serve [data-directory] [--community <handle>] [--first-writer <handle>]
```

The browser claim stores and activates the returned device credential, so `connect` is not a new-member prerequisite. A fresh `serve` reserves the first writer and that claim grants community write; environment-supplied accounts remain available for unattended bootstrap and legacy migration. Singleton arbord operations are `connectCommunity`, `disconnectCommunity`, `claimProfile`, `createGroupProfile`, `promoteTree`, `placeTree`, `removeTreePlacement`, and `setTreeAccess`. `system:community` stores only safe account/community metadata and a credential reference.

Browsing an ordinary untracked directory is shallow and demand-driven. Recursive discovery, indexing, type generation, and filesystem watching begin only when a folder is tracked or synced. Account-only operations such as `connect` and transient remote browser visits open arbord's control authority without attaching a filesystem session or creating a placeholder workspace. Unplaced remote visits proxy raw wire objects into a non-writable node and use TreeHopper's read-only BlockNote presentation without an iframe; ordinary host HTML uses the server-safe Arbor Markdown renderer.

### Reference-slice verification

- promote `/~editors/handbook` and preserve its URL, bytes, and `PageID` while longest-prefix resolution changes its enclosing `TreeID`;
- reject unrelated shadowing and a parent push that overwrites the reserved mount;
- share an external folder as `/~owner/atlas`, preserve its real OS path, project it through TreeHopper APIs, and create no duplicate profile folder;
- win one concurrent `~alice` claim and return `already-claimed` thereafter;
- release a pending member and disable a removed claimed member without deleting the profile boundary;
- isolate accounts and nested access; keep group membership separate from group authorship;
- exercise public, person, group, and link access plus revocation;
- keep raw account/link credentials out of durable text.

### Remaining work

- extend browser E2E coverage from claim/share/disconnect to group creation and access-entry revocation, plus a visual/accessibility pass;
- historical/recovery UI for access changes;
- production device pairing, account switching among stored identities, claim recovery/disputes, and administrator reset;
- confirmed removal UX for claimed members;
- execute the documented Railway/custom-domain deployment and hosted-volume restart check; broaden malformed/partial legacy-state recovery coverage.

Nested groups, cross-community membership, boundary moves/aliases, multiple active local identities, and broader workspace overlays remain deferred.

---

## Milestone 3 — workspace composition

**Status: Planned.**

- Allow one `TreeID` to have multiple local placements with correct identity, events, and provenance.
- Add an optional stricter read-only ceiling per placement; it never creates remote authority.
- Add reader-local overlays for annotations and proposals over read-only or historical content.
- Support transient visits, placement promotion, and pinned historical placements through the common locator resolver.
- Merge browser search and recovery results across visible trees without inventing aggregate REST resources.
- Preserve cached and overlay work across offline periods and access restoration.

Completion gate: Alice places one tree twice, makes one placement locally read-only, annotates it in an overlay, visits an unplaced tree, and sees provenance-correct search/recovery results without changing remote access.

---

## Milestone 4 — scripts and agents

**Status: Planned.**

- Recognize explicit query/mutation constructors while retaining ordinary TypeScript inference.
- Generate validators and stable typed handles; infer literal read/write prefixes and require declarations for computed paths.
- Run deterministic handlers in isolated workers with a scoped tree client as their only authority.
- Track read sets and rerun affected subscriptions; render components as sandboxed TreeHopper islands.
- Add `arbor run` over the same handle identity.
- Define agents as Markdown prompt/config pages whose context and tools are query/mutation references.
- Assemble restricted namespaces from shared-tree placements and process ceilings; render the same agent in CLI/browser with inspectable ordinary-tree transcripts.

Completion gate: one `.tsx` colocates component/query/mutation over two backings; client bundles contain handles but no handler code; invalid input and undeclared paths fail before data access; a file-defined agent uses the same handles and visible consent.

## Milestone 5 — data and SQLite

**Status: Planned.**

- Recognize `_store.sqlite3` collections and bare database nodes.
- Introspect tables and expose the same typed collection surface.
- Observe commits and run row mutations inside SQLite transactions.
- Snapshot through backup/checkpoint APIs; never copy a live main/WAL pair naïvely.
- Re-run the backing-independent collection corpus on SQLite.
- Preserve concurrent revisions as whole-database conflicts until logical changesets exist.

Completion gate: changing a file collection to SQLite changes no backing-independent query call sites; external SQLite writes remain observable and snapshots remain consistent during WAL activity.

## Milestone 6 — fuller publication profiles

**Status: Planned. Canonical live HTTP publication already belongs to Milestone 1.**

- `arbor bake` emits a static ref/object directory for a dumb host.
- Compile one portable application manifest for pages, assets, static query results, and live handlers.
- Add one static and two live adapters only after the common manifest exists.
- Protect deployed handlers with the same tree access and process validators as local execution.
- Emit `<link rel="arbor">` and `Arbor-Tree` crosslinks.

Completion gate: one tree publishes statically with working links/assets and one custom live script deploys to both chosen targets from the same manifest.

## Milestone 7 — polish and hardening

**Status: Polish; non-blocking.**

- richer bounded ordinary-file metadata and safe previews;
- provider-specific materialization controls where reliable;
- focused accessibility/responsive audits;
- measured cold/warm behavior on representative large trees;
- extension-aware lazy indexing that never parses binary or placeholder bytes.

## Deliberate absences

Unless an accepted milestone supplies a concrete need:

- no separate local multi-tenant account or group-administration database; groups are authored Markdown files;
- no REST v2 or compatibility adapter for this in-place v1 change;
- no SDK generation or universal capability negotiation;
- no persisted event replay across daemon epochs;
- no production HA/horizontal scaling/retention subsystem;
- no universal durable identity for every ordinary local file;
- no generic store, transport, credential, or deployment plugin framework.
- no path-scoped remote access: a subtree with different access is a nested shared tree.
