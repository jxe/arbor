# Arbord REST and reference clients
*Part of the [Arbor spec](../spec.md): the local boundary shared by TreeHopper web, TreeHopper native, the CLI, and other trusted single-user clients.*

## 1. Role and scope

Arbord is the sole first-party authority for a desktop workspace. It resolves logical paths, reads and writes nodes and stores, observes external filesystem changes, maintains recovery state, and later composes mounts, scripts, agents, and shared trees.

REST v1 is the concrete reference transport for that local authority. TreeHopper web uses the TypeScript reference client; TreeHopper native uses a Foundation-only Swift reference client beneath its native `WorkspaceProvider`. The CLI uses the same contract. The clients may add ergonomic methods and local document-session coordination, but none may invent a second persistence path.

The initial server binds loopback and assumes a trusted single-user process environment. It has no general login, local account model, or capability-negotiation handshake. That is a deliberate reference boundary, not a claim that an arbord exposed to untrusted local or remote clients would need no authorization. Remote shared-tree grants belong to the [wire](wire.md), and deployed/script authorities enforce the narrower security required by those features.

This contract is not an extension framework. REST v1 specifies the operations Arbor actually uses. When a later specified feature needs another operation or field, the spec is amended concretely; clients are not required to implement hypothetical provider capabilities in advance.

## 2. References and snapshots

### Node references

A local workspace reference has one of two forms:

```ts
type NodeRef =
  | { path: LogicalPath }
  | { pageID: PageID; pathHint?: LogicalPath };
```

- `path` is the canonical extensionless logical path described in [format.md](format.md) and may address any workspace node.
- `pageID` is an opaque, durable document identity carried by materialized Markdown frontmatter. Existing six-character IDs remain valid, but length and alphabet are not protocol semantics.
- `pathHint` makes logs and failures understandable and speeds ordinary resolution. When it disagrees with a valid page ID, the ID owner wins and arbord returns its current canonical path.
- Ordinary files and untouched bodyless directories remain path-only. The planned projected-document layer requires arbord to ensure a `PageID`, by minimally materializing the Markdown body, before an authored identity-bearing link or structural move requires directory-document continuity. REST does not synthesize a durable universal `NodeID`.
- `TreeID`, public names, and invitations are not alternative local `NodeRef` variants. Visiting or mounting them first gives their content workspace paths; the normal local API then uses those paths and any page IDs contained in the tree.

Duplicate page IDs are an error/diagnostic, never a nondeterministic choice. A page ID is rename-resistant identity for Markdown content, not a global name or proof of authority.

### Resolved snapshots

Every successful node read returns a resolved snapshot with:

```ts
type NodeSnapshot = {
  ref: {
    path: LogicalPath;
    pageID?: PageID;
  };
  path: LogicalPath;
  kind: "markdown" | "directory" | "collection" | "database" | "file";
  name: string;
  writable: boolean;
  materialization: "available" | "placeholder";
  contentRevision?: ContentRevision;
  directoryRevision?: DirectoryRevision;
  document?: MarkdownDocument;
  collection?: CollectionSummary;
  diagnostics: Diagnostic[];
  observedThrough: EventCursor;
};
```

`contentRevision` is the compare-and-swap identity of the page/file bytes that an authored content mutation would replace. `directoryRevision` is the precondition for authored directory-body ordering and anchored child placement. They may currently derive from the same physical body bytes, but the protocol keeps their meanings distinct. A changing child listing is additionally ordered by `observedThrough`; clients do not treat a content revision as a complete version of every child.

Later mount and sharing features add their specified materialization/provenance states when implemented. The base v1 snapshot does not predeclare an open-ended provider-state taxonomy.

### Read routes

REST v1 has these read families:

```text
GET /v1/node?path=…
GET /v1/node?pageID=…&pathHint=…
GET /v1/children?path=…&cursor=…
GET /v1/children?pageID=…&pathHint=…&cursor=…
GET /v1/search?q=…&cursor=…
GET /v1/collection?path=…&table=…&cursor=…
GET /v1/recovery?path=…
```

`/v1/node` resolves and reads in one operation. Routes that address a Markdown page accept the same path or page-ID-plus-hint query forms; path-only nodes use `path`. Separate `/open` resources are absent. Child, search, collection, and recovery cursors are opaque continuation values; callers do not construct offsets or infer storage layout from them.

Every state-bearing response includes `observedThrough`, establishing the event boundary described in §5. Collection rows and search results carry canonical paths and page IDs when those rows identify Markdown pages.

Page sizes are fixed in v1: 100 children, 30 search results, and 100 collection rows. A continuation cursor is bound to the route's complete query, including reference, search text, and collection table. Supplying it with another query is `invalid-reference`. `nextCursor` is either the next opaque cursor or `null`; the server does not accept a caller-selected limit.

The wire examples for these responses are the checked-in fixtures:

| Route | Normative response fixture |
|---|---|
| `/v1/node` | [`tests/fixtures/protocol/node.json`](../tests/fixtures/protocol/node.json) |
| `/v1/children` | [`tests/fixtures/protocol/children.json`](../tests/fixtures/protocol/children.json) |
| `/v1/search` | [`tests/fixtures/protocol/search.json`](../tests/fixtures/protocol/search.json) |
| `/v1/collection` | [`tests/fixtures/protocol/collection.json`](../tests/fixtures/protocol/collection.json) |
| `/v1/recovery` | [`tests/fixtures/protocol/recovery.json`](../tests/fixtures/protocol/recovery.json) |

Unknown descriptive fields are ignored by clients. The reference, revision, cursor, pagination, document/row data, diagnostics, and materialization fields shown in these fixtures are normative when applicable.

### Raw snapshots and projected documents

REST v1 deliberately returns storage-shaped facts: `/v1/node` supplies the stored or implicit body and `/v1/children` supplies the authoritative paginated child listing. It does **not** return a second Markdown document with child rows spliced into it.

The reference clients' observed-node layer adds a shared ergonomic projection after it has drained the child listing while buffering events from the initial `observedThrough` cursor. For a directory it exposes the stored blocks plus every immediate child exactly once. The first eligible authored standalone child link anchors that managed row at its existing block; additional links remain ordinary authored links, and an unmentioned child receives a synthetic row in stable listing order. Alongside the editor document the client retains a managed-row manifest containing block ID, target `NodeRef`, authored/synthetic origin, node kind, and materialization state.

That projection is not a new REST representation. Both reference clients implement it (`openProjectedNodeView`) over the same language-neutral algorithm and shared fixtures, so the TypeScript and Swift observed views produce the same document and managed-row manifest from the same node/children inputs. Supporting fields on the raw payloads: `NodeSnapshot.bodyState` says whether the returned body is `stored` or `implicit` (with `bodyOrigin` naming the physical representation), and each `TreeChild` carries its `pageID` when unambiguous, so clients build identity-bearing managed rows without N+1 reads. Synthetic rows receive identity-derived editor-only block IDs with the `managed:` prefix; those IDs never appear on the wire.

### Planned browser/native parity reads

Core Milestone 2 adds three concrete reads before native TreeHopper depends on them:

```text
GET /v1/backlinks?path=…&cursor=…
GET /v1/backlinks?pageID=…&pathHint=…&cursor=…
GET /v1/recovery?path=…&recursive=true&cursor=…
GET /v1/file?path=…
```

Backlinks resolve the usual `NodeRef`, return referring document refs plus link context, paginate like search, and carry `observedThrough`; they never define physical parentage or deletion policy.

**Recovery scales by subtree, not by a privileged workspace scope.** The existing node-scoped route gains `recursive` and a cursor: "what is recoverable under this directory" unifies Trash inventory with lost/purged Markdown entries for any subtree, and recovery for a whole tree is simply the root-directory call. There is no separate `scope=workspace` mode — *workspace* is not a stable boundary once arbord serves arbitrary roots and mounts. Recovery state is physically per-tree (the `/Trash` convention and `.history/` sidecars travel with the region that syncs) and per-device (the journal); the inventory is the device-merged fold over a subtree. A browser's global Recover/Trash surface merges per-tree queries client-side, the way the Finder merges per-volume Trashes; the API never pretends one aggregate exists.

**File reads return uninterpreted bytes** for an ordinary file/asset, honor HTTP range requests, and use the content revision as `ETag`; containment, writability, and placeholder checks remain arbord responsibilities. `/v1/file` replaces the `GET /Assets/…` static route outright — assets are ordinary files at ordinary logical paths, so authored `../Assets/…` Markdown references resolve through the same read, and the bespoke route is removed when `/v1/file` lands.

**Reads become tree-qualified when visiting lands.** Every read route in this section implicitly means "the tree arbord serves." Visiting an unmounted tree ([browser.md](browser.md) §3) requires naming nodes in a foreign tree — an inline image in a visited document references an asset *of that tree*, which no local path can address. The planned generalization is a tree dimension on read refs (`?tree=<TreeID>&path=…`, accepting the `arbor://` forms of [urls.md](urls.md)); `/v1/file` then serves visited bytes by resolving `(TreeID, path)` through the wire's ref plane and streaming the content-addressed blob, with the object hash as `ETag`. Arbord proxies rather than handing the browser a remote URL: grants stay enforced in one place, the web client stays same-origin against loopback, and fetched objects share one cache with any later mount or pin of the same tree. This pulls a read-only slice of the wire's ref/object planes forward of the full sync engine; it does not change the mutation surface, which stays local until sharing lands.

These routes are planned extensions, not part of the currently implemented v1 fixture set above. Both reference clients and browser behavior land with their fixtures. Home/default location remains client-local until readable `system:` preferences exist; it is not smuggled into a content route.

## 3. Authored mutations and receipts

### Request envelope

JSON-authored changes use one logical mutation route:

```text
POST /v1/mutations
```

```ts
type ContentWorkspaceOperation =
  | {
      op: "writeMarkdown";
      ref: NodeRef;
      baseContentRevision: ContentRevision;
      frontmatterPatch?: Record<string, unknown | null>;
      blocks: ArborBlock[];
    }
  | {
      op: "restoreRecovery";
      ref: NodeRef;
      hash: string;
      baseContentRevision?: ContentRevision;
    }
  | {
      op: "ensureDocumentIdentity";
      ref: NodeRef;
      baseContentRevision: ContentRevision;
    };

type StructuralWorkspaceOperation =
  | { op: "createMarkdown"; path: LogicalPath; blocks?: ArborBlock[] }
  | { op: "createDirectory"; path: LogicalPath }
  | { op: "rename"; ref: NodeRef; name: string }
  | {
      op: "move";
      refs: NodeRef[];
      destination: NodeRef;
      placement?: "natural" | "authored";
      beforePath?: LogicalPath;
      beforeBlockID?: string;
      baseDirectoryRevision?: DirectoryRevision;
    }
  | { op: "copy"; refs: NodeRef[]; destination: NodeRef }
  | { op: "trash"; refs: NodeRef[] }
  | { op: "restore"; refs: NodeRef[] };

type MutationRequest =
  | {
      mutationID: string;
      operations: [ContentWorkspaceOperation];
    }
  | {
      mutationID: string;
      operations: [
        StructuralWorkspaceOperation,
        ...StructuralWorkspaceOperation[],
      ];
    };
```

`ensureDocumentIdentity` makes a document's durable `PageID` explicit: when one already exists it writes nothing and its receipt echoes the current `pageID` and revisions; when a Markdown body lacks an `id` it patches the frontmatter under the content-revision precondition; and for an implicit directory it materializes a frontmatter-only `_index.md` with a minted ID. The receipt always carries a single `"updated"` effect with the resulting `pageID` and `contentRevision`. Clients use it before Copy Link or link insertion targeting a bodyless directory. Independently, an authored rename/move/trash of a Markdown-bodied document ensures identity inside the structural transaction, so those mutation effects always carry a `PageID`; bodyless directories gain identity on authored placement, and ordinary path-only files stay path-only.

`mutationID` is a non-empty opaque string. Every mutation belongs to exactly one durability domain. A content mutation contains exactly one Markdown write or recovery restoration. A structural mutation contains a non-empty ordered batch of structural operations. Content operations may not be combined with each other or with structural operations. A rejected mixed-domain request records no mutation intent and returns `unsupported-operation`.

The complete structural batch either commits or has no logical effects. Structural operation order is authored intent and participates in the request hash. This boundary lets Markdown intents and structural transactions each provide crash-safe recovery without a cross-domain transaction coordinator.

`refs` arrays are non-empty and retain their order. `move` is also the placement operation, with two placements. `natural` — the default for an unanchored cross-directory move — moves the node without materializing a stored destination row: the child simply appears in the listing (and as a projected synthetic row), pre-existing destination rows naming the moved node are rewritten, and source-directory rows for the departed child are removed. `authored` places a stored row in the destination directory body; an anchor (`beforePath` or `beforeBlockID`) always implies `authored`, and an unanchored `authored` move appends in authored document order. A same-directory move is a reorder and is inherently authored. Renames update an existing authored row but never materialize one for a previously synthetic child.

Anchors: `beforePath` identifies a child, while `beforeBlockID` identifies an authored block boundary in the destination directory body. `beforeBlockID` must name a stored block — client-side synthetic row IDs (the `managed:` prefix) never cross the wire; a client anchoring on a synthetic row sends that child's `beforePath` instead, and arbord materializes an authored row for the anchor child as well, keeping the placed rows ahead of it. If a `beforeBlockID` anchor no longer exists, arbord returns `missing-insertion-anchor`; it never silently appends. Logical mutations maintain stored structural rows themselves. Filesystem-only controls such as `updateDirectoryRows` are not protocol operations.

The planned projected-document client never sends its complete projected directory document as `writeMarkdown`. It removes synthetic managed rows and routes intentions by durability domain: prose/frontmatter becomes the singleton content operation, while managed-row reorder/move/rename/copy/trash/restore becomes a structural batch with `directoryRevision` and explicit anchors. If the operation requires a bodyless directory to retain document identity across movement, the corresponding arbord extension establishes the ID within the authored mutation before changing its path.

The normative request example is [`tests/fixtures/protocol/mutation.json`](../tests/fixtures/protocol/mutation.json). [`tests/fixtures/protocol/operations.json`](../tests/fixtures/protocol/operations.json) contains separate valid requests covering every content and structural operation. Physical filenames, transaction-temporary paths, watcher classifications, and filesystem-driver request types are never public fields.

Malformed envelopes, empty batches, mixed-domain batches, multiple-content batches, empty reference arrays, ambiguous references, and missing required operation fields are rejected before dispatch. [`tests/fixtures/protocol/mixed-mutation.json`](../tests/fixtures/protocol/mixed-mutation.json) is the normative rejected mixed-domain example.

Asset and import bytes retain concrete transfer routes:

```text
POST /v1/assets
POST /v1/imports
```

Their multipart metadata contains the same mutation ID and logical destination/preconditions. Successful transfers return the same receipt shape as JSON mutations. Arbor does not require a generic blob-staging service merely to make unlike byte transfers look uniform.

`/v1/assets` has two `multipart/form-data` parts:

- `metadata`, a JSON string matching [`asset-metadata.json`](../tests/fixtures/protocol/asset-metadata.json);
- `file`, the uninterpreted asset bytes.

It returns `{ "receipt": MutationReceipt, "path": LogicalPath, "markdownPath": string }`; `path` is the canonical asset path and `markdownPath` is the relative Markdown destination from the addressed directory.

`/v1/imports` has:

- `metadata`, a JSON string matching [`import-metadata.json`](../tests/fixtures/protocol/import-metadata.json);
- one byte part for each file entry, named by that entry's `field`. Directory entries have no byte part.

It returns a `MutationReceipt`. Metadata, entry ordering, filenames, and SHA-256 digests of transferred bytes participate in transfer identity. Retrying uses the same mutation ID, metadata, and bytes.

### Durability and idempotency

For every authored mutation or transfer:

1. arbord recursively sorts object keys, preserves array order, serializes the normalized request without insignificant whitespace, hashes it, and records that request hash plus authored intent durably before materializing effects;
2. arbord performs the logical mutation with its content/directory preconditions;
3. arbord durably records the completed receipt;
4. only then may it report success.

A successful acknowledgement therefore means that the effects and the receipt survive immediate arbord termination. If a crash occurs after materialization but before completion is recorded, startup recovery finishes or reconstructs the same receipt.

Retrying the same mutation ID with the same request returns the original receipt without applying intent twice. Reusing the ID with different bytes, preconditions, or operation fields is `mutation-mismatch`. Resolving a real conflict and submitting a merge is a new authored intent and therefore uses a new mutation ID.

The reference implementation retains completed mutation records in its existing journal indefinitely. It does not implement receipt expiry, compaction policy, or a separate receipt database. A later change to bounded retention would require an explicit unambiguous protocol revision; it may not turn an old retry into “possibly applied.”

### Receipt

```ts
type MutationReceipt = {
  mutationID: string;
  eventCursor: EventCursor;
  effects: Array<{
    kind: "created" | "updated" | "moved" | "deleted";
    path: LogicalPath;
    previousPath?: LogicalPath;
    pageID?: PageID;
    contentRevision?: ContentRevision;
    directoryRevision?: DirectoryRevision;
  }>;
};
```

One receipt covers the complete logical operation, including all sibling body/directory moves and parent directory-body changes. An HTTP success may not describe only the first physical file changed.

[`tests/fixtures/protocol/receipt.json`](../tests/fixtures/protocol/receipt.json) is the normative receipt example. Effects are in logical publication order. `eventCursor` is the cursor of the last event published for the receipt, or the current cursor when the mutation produces no event.

## 4. Conflicts and errors

Every non-success response uses:

```ts
type ArbordError = {
  error: {
    code: ArbordErrorCode;
    message: string;
    retryable: boolean;
    path?: LogicalPath;
    current?: NodeSnapshot;
    owners?: LogicalPath[];
    anchor?: {
      beforePath?: LogicalPath;
      beforeBlockID?: string;
    };
    mutationID?: string;
  };
};
```

REST v1 defines codes for:

- `invalid-reference`;
- `not-found`;
- `duplicate-page-id`;
- `duplicate-body-representation`;
- `stale-content-revision`;
- `stale-directory-revision`;
- `missing-insertion-anchor`;
- `occupied-destination`;
- `unsafe-path`;
- `mutation-mismatch`;
- `read-only`;
- `not-materialized`;
- `unsupported-operation`;
- `resync-required`;
- `internal-error`.

Fields not relevant to a code are omitted: `owners` belongs to duplicate identity/body errors, `anchor` to placement conflicts, `current` to stale revisions, and `mutationID` to idempotency failures. Physical paths and filesystem transaction details are never returned. Clients preserve and present unknown future codes without crashing, but REST v1 does not predeclare errors for unimplemented mounts, remote stores, grants, or deployment targets.

[`tests/fixtures/protocol/error.json`](../tests/fixtures/protocol/error.json) deliberately uses an unknown code to prove forward-compatible decoding.

HTTP status use is deliberately small:

| Status | Meaning |
|---|---|
| `200` | Read succeeded, mutation committed, or an idempotent retry returned its original receipt |
| `400` | Malformed request, invalid reference/query cursor, or unsafe path |
| `404` | Referenced node or recovery entry does not exist |
| `405` | The route exists outside v1 or the requested method is not part of v1 |
| `409` | Revision, destination, identity, anchor, mutation-ID, materialization, or event-cursor conflict |
| `422` | A well-formed operation is unsupported or addresses read-only content |
| `500` | Unexpected arbord failure; never used for a declared conflict |

Stale content and stale directory placement are distinct conflicts. A client may merge/retry content or refresh/replan placement; it must never silently turn a missing anchor into append-at-end.

## 5. Lossless observation

### Cursor model

Arbord orders observations with an opaque cursor containing a process epoch and monotonically increasing sequence. Cursors are comparable only within their epoch.

Every node/list/search/collection response is serialized through the same workspace observation boundary and includes `observedThrough`. Following events after that cursor cannot miss a change that occurred after the returned snapshot:

```text
read ─────────────▶ snapshot observed through cursor C
events(after C) ──▶ C+1, C+2, …

mutation M ───────▶ receipt { mutationID: M, eventCursor: D, effects: … }
retry M ──────────▶ the same receipt
```

### SSE

```text
GET /v1/events?after={cursor}
Last-Event-ID: {cursor}
```

The query and header are equivalent; supplying both with different values is an invalid request. Each workspace event uses its cursor as the SSE `id`.

```text
: connected

id: 11111111-1111-1111-1111-111111111111:5
event: workspace
data: {"cursor":"11111111-1111-1111-1111-111111111111:5","kind":"moved","path":"/archive/today","previousPath":"/notes/today","pageID":"abc123","contentRevision":"sha256:content","origin":"api","mutationID":"22222222-2222-2222-2222-222222222222"}

```

Frames are UTF-8, separated by a blank line, and may contain multiple `data:` lines whose values are joined with newline before JSON decoding. Comment/keepalive frames are ignored. The complete fixture is [`tests/fixtures/protocol/events.sse`](../tests/fixtures/protocol/events.sse).

```ts
type WorkspaceEvent = {
  cursor: EventCursor;
  kind: "created" | "updated" | "moved" | "deleted" | "diagnostic";
  path: LogicalPath;
  previousPath?: LogicalPath;
  pageID?: PageID;
  contentRevision?: ContentRevision;
  directoryRevision?: DirectoryRevision;
  origin: "api" | "external" | "recovery" | "sync";
  mutationID?: string;
};
```

Events are invalidations and observations, not replacement snapshots. A client fetches current state when an event matters to its visible page or listing.

Arbord retains a bounded in-memory replay window for ordinary disconnects. If a cursor's epoch is not current or its sequence is no longer available, the event request returns `resync-required`; the client refetches visible state and follows from the new response cursor.

The replay window contains 1,024 events. A cursor at the current sequence is valid and waits for later events. Events after an older retained cursor are delivered strictly by sequence. A client that needs several state requests begins following from the first snapshot's `observedThrough`; replay buffers changes that occur while subsequent visible listings are loaded.

Replay is not persisted across arbord restarts. Event batching, compaction, and client-relative `echo` classification are absent. A client recognizes its own authored effect by `mutationID`; origin describes the authority path, not which subscriber is looking.

## 6. Reference-client behavior

The TypeScript and Swift clients are deliberately small, hand-maintained implementations of this document.

Both clients:

- encode the same `NodeRef`, mutation, receipt, event, and error values;
- decode the shared language-neutral JSON/SSE fixtures;
- generate unique mutation IDs;
- retry an ambiguous transport failure only with the exact same mutation ID and request;
- never automatically retry a conflict as a new mutation;
- expose separate prepared/convenience APIs for singleton content mutations and non-empty structural batches;
- provide an observed-node view that begins buffering from the initial node snapshot before loading additional child pages;
- turn `resync-required` in that observed view into a refreshed node snapshot and resume from its returned cursor;
- preserve unknown error codes and ignore unknown descriptive response fields.

The next client-layer addition is a projected-directory helper on that observed view. It composes the raw snapshot and complete child listing, returns the managed-row manifest described in §2, and preserves `PageID`-bearing `NodeRef`s so a row remains attached to the same document after a move. The shared projection fixtures are part of its completion gate; until they land, callers must treat `openNodeView` as a hydrated raw view rather than a projected editor document.

The TypeScript client makes at most three total attempts after network termination or HTTP 500. It reuses the exact prepared request and mutation ID, never retries a declared conflict, and throws an ambiguous-transport error retaining the prepared request after the third ambiguous outcome. Its `openNodeView` helper starts observation after the first `/v1/node` response, buffers events while its directory convenience drains `/v1/children`, and emits either an event or a resynchronized snapshot.

The Swift client is an actor with injectable `URLSession`, mutation-ID generator, and retry timing. It applies the same three-attempt rule, encodes multipart bodies once for exact retry, and exposes both raw observation and matching observed-node updates as `AsyncThrowingStream`.

The TypeScript package is the only browser-facing API wrapper. The Swift package imports Foundation but not SwiftUI, TreeHopper, Hunch, Editor, or Clamshell.

Editor document sessions remain client-side:

- TreeHopper web's editor coordinator and native `WorkspaceDocumentSession` admit local generations synchronously;
- they serialize writes through the protocol client;
- `flush` waits for every admitted generation and its durable receipt;
- clean external snapshots update the existing editor document without creating authored undo history.

These behaviors do not create server `/open`, `/flush`, or `/close` endpoints.

## 7. Conformance fixtures and runner

The language-neutral fixtures live in [`tests/fixtures/protocol`](../tests/fixtures/protocol). Together they cover every read family, mutation and receipt values, an unknown error code, cursors, SSE framing, and both multipart manifests. Unknown descriptive fields are permitted; missing required fields and malformed values are tested against the live boundary.

Run the cross-language contract with:

```sh
bun run test:protocol
```

[`tests/protocol/conformance.ts`](../tests/protocol/conformance.ts) runs the TypeScript fixture cases, starts a temporary arbord workspace, passes the fixture directory and live URL to `swift test --package-path native/Packages/ArborClient`, and tears the workspace down.

## 8. Feature-required extensions

The complete Arbor system adds concrete local operations when their owning feature is implemented:

- the `system:` tree and mounted workspace paths become readable/mutable through the same node and mutation surface;
- scripts add explicit run/subscribe operations for compiled query and mutation handles;
- agents add run and transcript operations over agent files;
- sharing adds local create-share and accept-invitation operations, while remote object/ref/grant traffic remains the separate wire protocol;
- SQLite and Postgres row mutation use their store transaction boundaries and return ordinary mutation receipts/events.

These are required by their corresponding topic specs, but they do not justify a generic provider-operation registry in advance. Their exact routes and values are added to this document with the feature. Auth or authorization is added where the feature's trust boundary requires it, not as an abstract platform layer.
