# Implemented history
*Delivered Arbor and arbord milestones. The forward roadmap lives in [roadmap.md](roadmap.md); native application integration lives in [native.md](native.md).*

This file records implemented outcomes, source ownership, intentional limits, and verification evidence. Completed work belongs here rather than remaining as future imperatives in the active plan.

## Local browser/editor baseline

**Status: Implemented.**

Delivered:

- logical filesystem nodes joining `x.md`, `x/`, and `x/_index.md`;
- symlink-safe discovery, watching, indexing, search, generated collection types, and request-time containment;
- source-preserving Markdown through ArborNote/BlockNote, including raw fallback, toggles, footnotes, and LaTeX;
- journal-before-file Markdown writes, recovery, CAS, crash-safe structural transactions, Trash, restore, imports, and assets;
- file, CSV, JSONL, and Postgres collection reads through one collection surface;
- responsive TreeHopper web navigation, editing, properties, actions, and reconciliation without editor remounts.

Primary ownership:

- [`packages/core`](../packages/core)
- [`packages/fs`](../packages/fs)
- [`packages/editor`](../packages/editor)
- [`packages/stores`](../packages/stores)
- [`packages/render`](../packages/render)
- [`packages/arbord/src/workspace.ts`](../packages/arbord/src/workspace.ts)

Important constraints:

- Markdown files remain canonical; BlockNote is the interaction layer only.
- Untouched Markdown remains byte-identical; only edited regions normalize.
- CSV/JSONL/Postgres rows are not edited through the Markdown editor.
- `.claude` remains workspace content; only known generated/build directories are excluded.

## Exact-source and complete-directory foundation

**Status: Implemented on 2026-08-18.**

Delivered:

- `MarkdownDocument.source` is authoritative on REST, TypeScript, and Swift reads; `writeMarkdown` accepts only exact `source` plus `baseContentRevision`, and `createMarkdown` accepts optional exact source;
- arbord/filesystem providers parse submitted source internally for indexing, backlinks, rendering, recovery, and validation rather than trusting client-authored block arrays;
- every physical directory returns provider-owned complete operational Markdown: the first eligible standalone link represents each immediate child and deterministic ordinary links are appended for unmatched children without read materialization;
- directory content revisions include exact stored bytes plus canonical immediate-child descriptors, so child-set changes conflict while enumeration reorder does not;
- child-link order is a content edit, while physical moves carry only sources and a destination; obsolete placement and Markdown anchor fields are rejected;
- the web editor, TypeScript client, and Foundation-only Swift client consume this contract directly; client projection types, synthetic rows, manifests, and projection fixtures were removed;
- PageID handling now accepts opaque non-empty values in both logical URL implementations.

This supersedes the client-projection architecture recorded in the historical Milestone 2 section below. That section remains as delivery history rather than current guidance.

Primary ownership:

- [`spec/format.md`](../spec/format.md)
- [`spec/arbord-rest.md`](../spec/arbord-rest.md)
- [`packages/editor/src/directory-document.ts`](../packages/editor/src/directory-document.ts)
- [`packages/fs/src/workspace-fs.ts`](../packages/fs/src/workspace-fs.ts)
- [`packages/arbord`](../packages/arbord)
- [`packages/client`](../packages/client)
- [`native/Packages/ArborClient`](../native/Packages/ArborClient)
- [`packages/render`](../packages/render)

Quagmire/Hunch API work remains in `/Users/joe/src/hunch`; it is not part of this Arbor delivery.

Verification recorded with this delivery:

```text
bun run typecheck       passed
bun test                175 passed, 0 failed
bun run test:protocol   8 TypeScript fixtures and 9 live Swift tests passed
bun run build           passed
bun run test:e2e        13 passed
swift test --package-path native/Packages/ArborClient
                        9 passed, 1 live-server test skipped as designed
git diff --check        passed
```

## Canonical and community-hosting foundation

**Status: Implemented as a reference slice on 2026-08-02.**

Delivered:

- deterministic immutable wire objects, mutable CAS tree refs, immediate push/background pull, conflict preservation, and raw `TreeID` fallback;
- one mounted community namespace with complete person/group profile trees and longest-accessible-prefix resolution;
- in-place nested promotion that preserves canonical URLs, Markdown bytes, `PageID`s, and external OS folder locations;
- independently evaluated public, person, group, and link access with revocation and reserved-boundary protection;
- multi-account authority credentials, authored member reservations, atomic first-claim-wins person profiles, and authored group membership;
- browser profile, Claim, and additive Share surfaces plus `browse`, `sync`, `unsync`, `serve`, and credential-recovery CLI plumbing;
- shallow untracked browsing, sessionless remote visits, writable reopening of local placements, read-only BlockNote remote rendering, and server-rendered public Markdown without iframes.

Normative ownership:

- [`spec/wire.md`](../spec/wire.md)
- [`spec/locators.md`](../spec/locators.md)
- [`spec/client.md`](../spec/client.md)
- [`docs/treehopper.md`](../docs/treehopper.md)
- [`spec/cli.md`](../spec/cli.md)
- [`spec/system.md`](../spec/system.md)
- [`spec/arbord-rest.md`](../spec/arbord-rest.md)

The delivered slice intentionally does not claim end-user device pairing, claim recovery/dispute resolution, multiple active local identities, nested or cross-community groups, boundary moves/aliases, or production hosting administration. Those follow-ups have their own position in the forward roadmap rather than keeping the foundation permanently partial.

Verification on 2026-08-02:

```text
bun run typecheck       passed
bun test                167 passed, 0 failed
bun run test:protocol   7 TypeScript fixture tests and 10 Swift live tests passed
bun run build           passed
bun run test:e2e        13 passed
git diff --check        passed
```

Delivered across the community-hosting series ending at `001ea16`.

## Workspace composition (forward Milestone 1)

**Status: Implemented on 2026-08-02.**

Delivered:

- distinct shared trees can be placed at nested, locally meaningful paths and resolve by longest local prefix;
- a reader-local mount is excluded from the parent's discovery, watcher, page-ID map, search index, generated types, wire snapshot, and pull deletion, so it never changes the parent graph/ref, canonical URL, ACL, or another reader's layout;
- canonical nested boundaries remain separately authored graph entries, including virtual external-folder projections;
- mounted roots are protected by structured `reserved-boundary` conflicts, placement requires an absent/empty destination, and unsyncing leaves local files untouched;
- remote visits persist safe `system:visited` records and private credential-free node snapshots, reopen read-only during transport outages, and expose **Add to workspace**;
- Home renders nested placements, recently visited trees, and a provenance-correct merged recovery inventory; existing all-tree search now excludes locally mounted children from their parent index;
- backlinks fan out across visible trees for explicit `arbor://tree/<TreeID>/…` links and retain the referring tree on every result.

Primary ownership:

- [`packages/arbord/src/tree-manager.ts`](../packages/arbord/src/tree-manager.ts)
- [`packages/arbord/src/service.ts`](../packages/arbord/src/service.ts)
- [`packages/fs/src/discovery.ts`](../packages/fs/src/discovery.ts)
- [`packages/fs/src/workspace-fs.ts`](../packages/fs/src/workspace-fs.ts)
- [`packages/wire/src/objects.ts`](../packages/wire/src/objects.ts)
- [`packages/stores/src/visits.ts`](../packages/stores/src/visits.ts)
- [`packages/stores/src/indexer.ts`](../packages/stores/src/indexer.ts)
- [`packages/render/src/App.tsx`](../packages/render/src/App.tsx)

Intentional limits:

- one local placement per `TreeID`; several placements of the same tree remain deferred;
- no reader-local content overlay or shadowing of occupied parent content;
- no pinned historical placements or placement-specific local access ceiling;
- merged recovery remains a client-side set of per-tree operations, not a cross-tree transaction or fabricated aggregate tree;
- cross-tree backlink indexing recognizes stable raw TreeID locators; DNS canonical-link matching can be added when the index has a durable authority mapping.

Verification on 2026-08-02:

```text
bun run typecheck       passed
bun test                171 passed, 0 failed
bun run test:protocol   7 TypeScript fixture tests and 10 Swift tests passed
bun run build           passed
bun run test:e2e        13 passed
git diff --check        passed
```

## Milestone 1 — REST v1 and both reference clients

**Status: Implemented on 2026-07-25.**

Outcome:

- REST v1 is the sole application API.
- `NodeRef` supports logical paths or durable `PageID` references.
- Content and directory revisions remain distinct.
- Mutations are durable, idempotent, restart-safe, and split by durability domain.
- State reads carry observation cursors; SSE replay and deterministic `resync-required` close fetch/subscribe gaps.
- TypeScript and Foundation-only Swift reference clients implement exact retry, multipart transfers, cursor tracking, and observed node views.

Implemented in:

- [`spec/arbord-rest.md`](../spec/arbord-rest.md)
- [`packages/core/src/protocol.ts`](../packages/core/src/protocol.ts)
- [`packages/arbord`](../packages/arbord)
- [`packages/client`](../packages/client)
- [`native/Packages/ArborClient`](../native/Packages/ArborClient)
- [`spec/fixtures`](../spec/fixtures)

Intentional limits:

- no general local authentication layer;
- no editor-session lifecycle API;
- no SDK generator, persisted replay service, mount, wire, sharing, or native app integration.

Completion evidence recorded at delivery:

```text
bun run typecheck       passed
bun test                80 passed
bun run test:protocol   TypeScript fixtures + 8 live Swift tests passed
bun run build           passed
bun run test:e2e        8 passed
bun run test:performance
                        50,000 files; 1,828 ms startup; 0.27 ms incremental; 37.06 ms search
```

Commit: `0cb565c`.

## Milestone 2 — whole-workspace daily driver

**Status: Implemented on 2026-07-27, with explicit polish deferrals.**

Outcome:

- complete directory documents were originally delivered as pure client projections over a storage-shaped node plus the fully paginated child listing (superseded by the provider-owned contract above);
- managed-row manifests preserve child identity/origin/kind/materialization without serializing synthetic rows;
- one logical URL resolver handles child, sibling, rooted, identity-bearing, and global Arbor destinations in TypeScript and Swift;
- bodyless directories remain side-effect free until authored body/order/identity requires materialization;
- logical ordinary-file routes serve bytes with revision `ETag`, HTTP range, and explicit raw document access;
- per-root backlinks return referring document identity and link context;
- per-root recovery supports paginated recursive subtree inventory across lost/purged blocks and Trash;
- TreeHopper web exposes “Linked from,” subtree recovery, minimal ordinary-file actions, and honest unavailable state;
- iCloud `.name.icloud` markers map to the logical unavailable node and are never read or indexed as content.

Implemented in:

- `packages/core/src/projection.ts` (historical; removed by the provider-owned complete-directory foundation)
- [`packages/core/src/logical-url.ts`](../packages/core/src/logical-url.ts)
- [`packages/client/src/index.ts`](../packages/client/src/index.ts)
- [`native/Packages/ArborClient`](../native/Packages/ArborClient)
- [`packages/stores/src/indexer.ts`](../packages/stores/src/indexer.ts)
- [`packages/fs/src/materialization.ts`](../packages/fs/src/materialization.ts)
- [`packages/arbord/src/workspace.ts`](../packages/arbord/src/workspace.ts)
- [`packages/arbord/src/server.ts`](../packages/arbord/src/server.ts)
- [`packages/render/src/PageEditor.tsx`](../packages/render/src/PageEditor.tsx)
- [`packages/render/src/App.tsx`](../packages/render/src/App.tsx)

Explicitly deferred to the non-blocking polish milestone:

- rich ordinary-file metadata, previews, and host-app actions;
- provider-specific download/retry commands and broader provider classification;
- representative personal-tree measurement beyond the retained synthetic regression gate.

Explicitly deferred to sharing/workspace composition:

- aggregation of recovery/Trash inventories across multiple roots or mounts.

Verification on 2026-07-27:

```text
bun run typecheck
                        passed
bun test tests/unit/protocol.test.ts tests/unit/fs.test.ts \
  tests/integration/server.test.ts tests/integration/fs-scope.test.ts
                        55 passed, 0 failed
```

The combined protocol/build verification is recorded below after Milestone 3 because both milestones share one delivery set.

## Milestone 3 — filesystem-wide browsing and tracked roots

**Status: Implemented on 2026-07-26.**

Outcome:

- `arbor dev <path>` treats its argument as a starting location, not a workspace boundary;
- navigation walks to the OS root and into any readable local path;
- Arbor intelligence activates only inside session/tracked roots;
- path-keyed `~/.arbor/trees.yaml` entries persist tracked roots and project through `system:roots`;
- arbord is split into `ArborService`, `RootManager`, per-root `Workspace`s, and a reduced untracked `FilesystemService`;
- protocol refs, snapshots, events, effects, results, and both clients carry the tree dimension;
- local refs canonicalize into their owning root; bare `PageID` references fan out across live roots;
- TreeHopper uses OS-shaped URLs, unclamped breadcrumbs, root provenance, tracking affordances, and focus revalidation in untracked scope.

Implemented in:

- [`packages/arbord/src/service.ts`](../packages/arbord/src/service.ts)
- `packages/arbord/src/roots.ts` (historical; later consolidated into `service.ts`)
- [`packages/arbord/src/fs-service.ts`](../packages/arbord/src/fs-service.ts)
- [`packages/stores/src/trees.ts`](../packages/stores/src/trees.ts)
- [`packages/stores/src/private-state.ts`](../packages/stores/src/private-state.ts)
- [`packages/arbord/src/root-title.ts`](../packages/arbord/src/root-title.ts)
- [`packages/core/src/protocol.ts`](../packages/core/src/protocol.ts)
- [`packages/render/src/App.tsx`](../packages/render/src/App.tsx)

Coverage:

- [`tests/integration/fs-scope.test.ts`](../tests/integration/fs-scope.test.ts)
- `tests/integration/roots.test.ts` (historical; coverage later consolidated into `fs-scope.test.ts`)
- shared tree-qualified protocol fixtures decoded by TypeScript and Swift;
- filesystem-wide browser end-to-end coverage.

Verification recorded on 2026-07-26:

```text
bun run typecheck       passed
bun test                126 passed
bun run test:protocol   TypeScript and Swift conformance passed
bun run build           passed
bun run test:e2e        11 passed
bun run test:performance
                        50,000 files; 1,218 ms startup; 0.28 ms incremental; 33.5 ms search
```

Manual acceptance covered untracked launch, parent navigation to `/`, external CAS reconciliation, Keep tracking, and readable `system:roots`.

### Storage refinement — 2026-07-28

Arbor's default private state home is now `~/.arbor` on every platform. An unoverridden first launch atomically relocates the former platform data directory and leaves a compatibility symlink; explicit `ARBOR_DATA_HOME` runs remain isolated. Colliding real directories are never merged.

Tracked placements now live in the comment- and order-preserving, path-keyed `~/.arbor/trees.yaml`. Only `source: local` is operational; valid shared Arbor sources parse but remain blocked until the wire milestone. RootIDs, state-directory IDs, canonical paths, and device/inode fingerprints remain private in the upgraded `workspaces.json`, allowing unambiguous same-filesystem moves to retain identity. Root names come from the first H1 in `_index.md`, with the directory basename as fallback. Invalid live registry candidates leave the preceding active configuration in place and surface diagnostics.

## Current combined verification

Verified on 2026-07-28 after the `~/.arbor` and `trees.yaml` refinement:

```text
bun run typecheck       passed
bun test                141 passed, 0 failed
bun run test:protocol   7 TypeScript fixture tests and 10 Swift live tests passed
bun run build           passed
bun run test:e2e        11 passed
bun run test:performance
                        50,000 files; 1,302 ms startup; 0.27 ms incremental; 32.24 ms search
swift test --package-path native/Packages/ArborClient
                        9 passed, 1 live-server test skipped as designed
git diff --check        passed
```

Joe's unoverridden local state was migrated after stopping/checking for arbord. The move retained all 108 files and the 56,040 KiB state footprint, preserved the pre-move `workspaces.json` checksum before its shape upgrade, left only the compatibility symlink in Application Support, and passed an SQLite `quick_check` plus a real `/v1/roots` open against the existing Arbor workspace state.
