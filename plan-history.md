# Implemented history
*Delivered Arbor and arbord milestones. The forward roadmap lives in [plan.md](plan.md); native application integration lives in [plan-native.md](plan-native.md).*

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

- [`packages/core`](packages/core)
- [`packages/fs`](packages/fs)
- [`packages/editor`](packages/editor)
- [`packages/stores`](packages/stores)
- [`packages/render`](packages/render)
- [`packages/arbord/src/workspace.ts`](packages/arbord/src/workspace.ts)

Important constraints:

- Markdown files remain canonical; BlockNote is the interaction layer only.
- Untouched Markdown remains byte-identical; only edited regions normalize.
- CSV/JSONL/Postgres rows are not edited through the Markdown editor.
- `.claude` remains workspace content; only known generated/build directories are excluded.

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

- [`spec/arbord-rest.md`](spec/arbord-rest.md)
- [`packages/core/src/protocol.ts`](packages/core/src/protocol.ts)
- [`packages/arbord`](packages/arbord)
- [`packages/client`](packages/client)
- [`native/Packages/ArborClient`](native/Packages/ArborClient)
- [`tests/fixtures/protocol`](tests/fixtures/protocol)

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

- complete directory documents are pure client projections over a storage-shaped node plus the fully paginated child listing;
- managed-row manifests preserve child identity/origin/kind/materialization without serializing synthetic rows;
- one logical URL resolver handles child, sibling, rooted, identity-bearing, and global Arbor destinations in TypeScript and Swift;
- bodyless directories remain side-effect free until authored body/order/identity requires materialization;
- logical ordinary-file routes serve bytes with revision `ETag`, HTTP range, and explicit raw document access;
- per-root backlinks return referring document identity and link context;
- per-root recovery supports paginated recursive subtree inventory across lost/purged blocks and Trash;
- TreeHopper web exposes “Linked from,” subtree recovery, minimal ordinary-file actions, and honest unavailable state;
- iCloud `.name.icloud` markers map to the logical unavailable node and are never read or indexed as content.

Implemented in:

- [`packages/core/src/projection.ts`](packages/core/src/projection.ts)
- [`packages/core/src/logical-url.ts`](packages/core/src/logical-url.ts)
- [`packages/client/src/index.ts`](packages/client/src/index.ts)
- [`native/Packages/ArborClient`](native/Packages/ArborClient)
- [`packages/stores/src/indexer.ts`](packages/stores/src/indexer.ts)
- [`packages/fs/src/materialization.ts`](packages/fs/src/materialization.ts)
- [`packages/arbord/src/workspace.ts`](packages/arbord/src/workspace.ts)
- [`packages/arbord/src/server.ts`](packages/arbord/src/server.ts)
- [`packages/render/src/PageEditor.tsx`](packages/render/src/PageEditor.tsx)
- [`packages/render/src/App.tsx`](packages/render/src/App.tsx)

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
- minimal human-readable `system:roots` records persist tracked roots;
- arbord is split into `ArborService`, `RootManager`, per-root `Workspace`s, and a reduced untracked `FilesystemService`;
- protocol refs, snapshots, events, effects, results, and both clients carry the tree dimension;
- local refs canonicalize into their owning root; bare `PageID` references fan out across live roots;
- TreeHopper uses OS-shaped URLs, unclamped breadcrumbs, root provenance, tracking affordances, and focus revalidation in untracked scope.

Implemented in:

- [`packages/arbord/src/service.ts`](packages/arbord/src/service.ts)
- [`packages/arbord/src/roots.ts`](packages/arbord/src/roots.ts)
- [`packages/arbord/src/fs-service.ts`](packages/arbord/src/fs-service.ts)
- [`packages/stores/src/system-roots.ts`](packages/stores/src/system-roots.ts)
- [`packages/core/src/protocol.ts`](packages/core/src/protocol.ts)
- [`packages/render/src/App.tsx`](packages/render/src/App.tsx)

Coverage:

- [`tests/integration/fs-scope.test.ts`](tests/integration/fs-scope.test.ts)
- [`tests/integration/roots.test.ts`](tests/integration/roots.test.ts)
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

## Current combined verification

Milestones 2 and 3 share one focused worktree delivery. Verified on 2026-07-27:

```text
bun run typecheck       passed
focused unit/integration suite
                        55 passed, 0 failed
bun run test:protocol   7 TypeScript fixture tests and 10 Swift tests passed
bun run build:web       passed
```

Browser E2E and the performance benchmark were deliberately not rerun for the Milestone 2 follow-up; their most recent evidence remains the Milestone 3 delivery record above.
