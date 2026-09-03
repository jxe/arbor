---
id: pj4k7n
---
# Directory projection implementation outline
*Implemented companion to the projected-directory-document model in [spec/02-directory-format.md](../../spec/02-directory-format.md) §4 and the raw-vs-projected boundary in [docs/arborsync-api.md](../../docs/arborsync-api.md). The spec files own the behavior contract; this file records the delivered cutover and code-level details. Completion is recorded in [implemented outcomes](../../plans/_done/outcomes.md).*

The clean boundary is:

> arbord returns the authoritative stored/implicit body plus authoritative children; the TypeScript and Swift clients derive the complete projected document; ArborNote consumes that projection and never sends synthetic rows back as Markdown.

That preserves one persistence authority without making the REST response itself editor-shaped.

## 1. Lock the shared contract first

In [packages/core/src/protocol.ts](/Users/joe/src/arbor/packages/core/src/protocol.ts) and [packages/core/src/types.ts](/Users/joe/src/arbor/packages/core/src/types.ts):

- Add document-body state to `NodeSnapshot`, at minimum:
  - `stored`
  - `implicit`
  
  It may be useful to retain `sibling | index | implicit` for source-view diagnostics.

- Add `pageID?: PageID` to `TreeChild`, allowing clients to construct a durable child `NodeRef` without an N+1 node read.

- Define client-side types such as:

```ts
interface ProjectedDocument {
  source: MarkdownDocument;
  visibleBlocks: ArborBlock[];
  managedChildren: ManagedChildRow[];
  bodyState: "stored" | "implicit";
}

interface ManagedChildRow {
  blockID: string;
  ref: ResolvedNodeRef;
  origin: "authored" | "synthetic";
  kind: NodeKind;
  materialization: Materialization;
}
```

Keep this projection out of the REST `NodeSnapshot.document`.

## 2. Build one pure projection and URL layer

Refactor [packages/core/src/structural-rows.ts](/Users/joe/src/arbor/packages/core/src/structural-rows.ts) into two related pure facilities:

### Logical URL resolution

One resolver should handle:

- `notes` → child
- `../roadmap` → sibling
- `/rooted/path`
- `#PageID`
- `arbor://name/path`
- `arbor://tree/<TreeID>/path`
- compatibility `.md`, `/_index.md`, bare-domain, and `tree:` forms

Every Markdown document gets the same implicit directory-like base, regardless of whether it is currently a leaf, a directory, or backed by `_index.md`.

This replaces both the current `resolveStructuralRowPath()` implementation and the separate directory-versus-leaf link rule in [PageEditor.tsx](/Users/joe/src/arbor/packages/render/src/PageEditor.tsx). Note this is mostly net-new capability, not a refactor: both current code paths reject `#`-prefixed and scheme-bearing hrefs outright, so the `#PageID`, `arbor://`, and compatibility branches have no existing implementation to migrate.

### Directory projection

The pure projection should:

1. Start with the stored blocks.
2. Walk them in document order.
3. Match the first eligible standalone link to each immediate child.
4. Mark that block as an authored managed row.
5. Leave duplicate links to the same child as ordinary links.
6. Append one synthetic row for every unmatched child, preserving server listing order.
7. Give synthetic rows stable editor-only block IDs derived from child identity—not index/name.
8. Return the visible blocks and managed-row manifest separately.

I would also separate syntax from structure internally: the current `childPage` block means both “standalone Markdown link” and “physical child.” Prefer renaming it to something like `standaloneLink`, or at least redefine it explicitly as syntax; the manifest determines whether it is structurally managed.

## 3. Fix arbord and filesystem materialization semantics

Most work will be in:

- [packages/fs/src/workspace-fs.ts](/Users/joe/src/arbor/packages/fs/src/workspace-fs.ts)
- [packages/arbord/src/workspace.ts](/Users/joe/src/arbor/packages/arbord/src/workspace.ts)
- [packages/arbord/src/server.ts](/Users/joe/src/arbor/packages/arbord/src/server.ts)

Required behavior:

- Reading an implicit directory continues returning an empty source document without creating `_index.md`.
- A prose/property write materializes `_index.md`.
- An authored directory ordering/grouping operation materializes `_index.md`.
- A normal physical move into a directory does not automatically insert a stored child link.
- Removing/moving/trashing a child removes an existing authored managed row, if present.
- Rename updates an existing authored row but does not create one for a previously synthetic child.
- Copy continues reminting document IDs.

### Distinguish natural moves from authored placement

The current `move` operation cannot distinguish:

- “move this node into that directory and let it appear naturally”; from
- “place this row at the end of the authored directory document.”

Add something like:

```ts
placement?: "natural" | "authored";
```

Rules:

- `beforePath` or `beforeBlockID` implies `authored`.
- `authored` without an anchor means append in authored document order.
- `natural` creates no stored row.
- Reordering a synthetic row makes it authored.
- Move-picker operations normally use `natural`.

This changes `applyRowPlan()` — which lives in [packages/fs/src/workspace-fs.ts](/Users/joe/src/arbor/packages/fs/src/workspace-fs.ts), wrapping the pure `transformStructuralRows()` from core — and which currently inserts structural rows for moves even when no authored ordering is required.

## 4. Make document identity explicit

Add a singleton content-domain operation such as:

```ts
{
  op: "ensureDocumentIdentity";
  ref: NodeRef;
  baseContentRevision: ContentRevision;
}
```

It should:

- return an existing `PageID` without rewriting when one exists;
- add `id` to an existing Markdown body lacking one;
- create a frontmatter-only `_index.md` for an implicit directory;
- return the resulting `pageID` and revisions in the receipt.

Use it before Copy Link/link insertion for a bodyless directory.

For authored rename/move/trash of a Markdown or directory document, arbord should ensure identity before changing the path—preferably inside the structural transaction. The resulting mutation effect must carry the `PageID`. Path-only ordinary files remain path-only.

## 5. Move projection into both clients

### TypeScript

In [packages/client/src/index.ts](/Users/joe/src/arbor/packages/client/src/index.ts):

- Preserve the existing snapshot/event handoff: it already starts observation before draining child pages.
- Add `openProjectedNodeView()` or evolve `openNodeView()` to return:
  - raw hydrated snapshot;
  - optional `ProjectedDocument`;
  - projected resync updates.
- Re-run projection after every resynchronized snapshot.
- Preserve child `pageID`s and use identity-bearing refs.
- Never mutate `snapshot.document.blocks` to contain synthetic rows.
- Add conveniences for:
  - `ensureDocumentIdentity`
  - authored versus natural placement
  - canonical link construction

### Swift

Mirror this in:

- [Protocol.swift](/Users/joe/src/arbor/native/Packages/ArborClient/Sources/ArborClient/Protocol.swift)
- [ArborClient.swift](/Users/joe/src/arbor/native/Packages/ArborClient/Sources/ArborClient/ArborClient.swift)

Specific cleanup:

- Swift hydration currently fetches children using `.path(snapshot.ref.path)`; retain the resolved `PageID` reference instead.
- Add Swift equivalents of `ProjectedDocument` and `ManagedChildRow`.
- Project resync snapshots before yielding them.
- Keep Foundation-only boundaries intact.

Both clients must produce structurally identical projection results from shared JSON fixtures.

## 6. Simplify ArborNote around the projected view

The main cutover is in [PageEditor.tsx](/Users/joe/src/arbor/packages/render/src/PageEditor.tsx).

Remove its local projection code:

- `implicitChildren`
- index/name-derived implicit IDs
- top-level-only `authored.some(...)` matching
- repeated path-based managed-row resolution

Instead, accept `ProjectedDocument` and index the manifest by block ID and durable child identity.

### Split visible editing from persisted editing

The current coordinator captures all visible blocks and sends them through `writeMarkdown`, which means synthetic rows can be materialized during an unrelated prose edit.

Change it so:

- visible editor state contains the full projection;
- content saves serialize only stored/authored blocks;
- synthetic managed rows are filtered out;
- structural row gestures produce structural mutations directly;
- projection reconciliation is marked non-authored and creates no undo entry;
- deleting a synthetic row cannot hide or delete the child;
- moving a synthetic row converts it into authored placement through a structural operation.

Authored standalone links remain Markdown. Synthetic rows never become Markdown merely because another paragraph changed.

## 7. Fix navigation and source view

In [PageEditor.tsx](/Users/joe/src/arbor/packages/render/src/PageEditor.tsx) and [App.tsx](/Users/joe/src/arbor/packages/render/src/App.tsx):

- Navigate using `NodeRef`/resolved targets rather than discarding IDs into a path string.
- Use the shared logical URL resolver.
- Let a valid document-ID fragment override a stale path.
- Keep global `arbor://` resolution behind the tree/mount resolver.
- Preserve the same link target when a document gains its first child.

Source view should show:

- the actual stored Markdown;
- whether the body is implicit;
- projected children in a separate labelled section, if shown at all.

It must never imply that synthetic rows already exist in `_index.md`.

## 8. Tests and fixtures

Add shared projection fixtures covering:

- implicit directory with no children;
- implicit directory with several children;
- more than 100 children across pagination;
- authored child link in the middle of prose;
- nested authored row beneath a heading;
- duplicate links to one child;
- stale path plus valid `PageID`;
- synthetic rows with stable IDs;
- local, rooted, and `arbor://` links;
- buffered child changes during hydration;
- resync followed by reprojection.

Filesystem/API tests should prove:

- browsing does not create `_index.md`;
- unrelated prose edits do not persist synthetic rows;
- first prose/property edit materializes it;
- natural move does not materialize destination ordering;
- reorder-to-end does materialize ordering;
- identity creation produces frontmatter-only `_index.md`;
- move/rename preserves `PageID`;
- source and destination row transforms remain crash-safe.

Browser E2E should verify the same behavior visibly, including selection preservation and non-authored reconciliation.

## Recommended implementation order

1. Shared URL resolver, projection types, pure projection, and fixtures.
2. Arbord child identity/body-state fields.
3. Natural-versus-authored placement and lazy filesystem materialization.
4. Explicit document-identity operation and move preservation.
5. TypeScript projected view.
6. Swift projected view and shared conformance.
7. ArborNote cutover to manifest-driven rows.
8. Remove the old browser-local projection and split link resolvers.
9. Run protocol, unit, integration, browser, source-preservation, and performance suites.

The two most important safeguards are: never put synthetic blocks into the raw REST document, and never let the editor submit its complete visible projection as `writeMarkdown`.
