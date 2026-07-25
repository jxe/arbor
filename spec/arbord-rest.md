# Arbord REST and reference clients
*Part of the [Arbor spec](../spec.md): the local boundary shared by TreeHopper web, TreeHopper native, the CLI, and other trusted single-user clients.*

## 1. Role and scope

Arbord is the sole first-party authority for a desktop workspace. It resolves logical paths, reads and writes nodes and stores, observes external filesystem changes, maintains recovery state, and later composes mounts, scripts, agents, and shared trees.

REST v1 is the concrete reference transport for that local authority. TreeHopper web uses the TypeScript reference client; TreeHopper native uses a Foundation-only Swift reference client beneath its native `WorkspaceProvider`. The CLI uses the same contract. The clients may add ergonomic methods and local page-session coordination, but none may invent a second persistence path.

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
- `pageID` is an opaque, durable identity carried by a Markdown page. Existing six-character IDs remain valid, but length and alphabet are not protocol semantics.
- `pathHint` makes logs and failures understandable and speeds ordinary resolution. When it disagrees with a valid page ID, the ID owner wins and arbord returns its current canonical path.
- Ordinary files and bodyless directories remain path-only. REST does not synthesize a durable universal `NodeID`.
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

## 3. Authored mutations and receipts

### Request envelope

JSON-authored changes use one logical mutation route:

```text
POST /v1/mutations
```

```ts
type MutationRequest = {
  mutationID: string;
  operation: WorkspaceOperation;
};
```

`WorkspaceOperation` is a closed discriminated union for operations Arbor currently supports:

- write Markdown/frontmatter;
- create a page or directory;
- move or copy logical nodes;
- reorder/place children with a directory revision and explicit anchor;
- move to Trash or restore;
- restore selected recovery content.

Each operation carries the relevant `NodeRef` and explicit preconditions such as `baseContentRevision` or `baseDirectoryRevision`. Physical filenames, transaction-temporary paths, watcher classifications, and filesystem-driver request types are never public fields.

Asset and import bytes retain concrete transfer routes:

```text
POST /v1/assets
POST /v1/imports
```

Their multipart metadata contains the same mutation ID and logical destination/preconditions. Successful transfers return the same receipt shape as JSON mutations. Arbor does not require a generic blob-staging service merely to make unlike byte transfers look uniform.

### Durability and idempotency

For every authored mutation:

1. arbord records the mutation ID, stable request hash, and authored intent durably before materializing its effects;
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
- `unsupported-operation`;
- `resync-required`.

Fields not relevant to a code are omitted: `owners` belongs to duplicate identity/body errors, `anchor` to placement conflicts, `current` to stale revisions, and `mutationID` to idempotency failures. Physical paths and filesystem transaction details are never returned. Clients preserve and present unknown future codes without crashing, but REST v1 does not predeclare errors for unimplemented mounts, remote stores, grants, or deployment targets.

HTTP status use is deliberately small:

| Status | Meaning |
|---|---|
| `200` | Read succeeded, mutation committed, or an idempotent retry returned its original receipt |
| `400` | Malformed request, invalid reference, or unsafe path |
| `404` | Referenced node or recovery entry does not exist |
| `409` | Revision, destination, identity, anchor, mutation-ID, or event-cursor conflict |
| `422` | Well-formed operation is not supported by this specified surface |
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

Replay is not persisted across arbord restarts. Event batching, compaction, and client-relative `echo` classification are absent. A client recognizes its own authored effect by `mutationID`; origin describes the authority path, not which subscriber is looking.

## 6. Reference-client behavior

The TypeScript and Swift clients are deliberately small, hand-maintained implementations of this document.

Both clients:

- encode the same `NodeRef`, mutation, receipt, event, and error values;
- decode the shared language-neutral JSON/SSE fixtures;
- generate unique mutation IDs;
- retry an ambiguous transport failure only with the exact same mutation ID and request;
- never automatically retry a conflict as a new mutation;
- buffer or follow events from a response's `observedThrough` cursor;
- surface `resync-required` to the higher-level owner, which refetches its visible state and resumes from the returned cursor;
- preserve unknown error codes and ignore unknown descriptive response fields.

The TypeScript package is the only browser-facing API wrapper. The Swift package imports Foundation but not SwiftUI, TreeHopper, Hunch, Editor, or Clamshell.

Editor page sessions remain client-side:

- TreeHopper web's editor coordinator and native `WorkspacePageSession` admit local generations synchronously;
- they serialize writes through the protocol client;
- `flush` waits for every admitted generation and its durable receipt;
- clean external snapshots update the existing editor document without creating authored undo history.

These behaviors do not create server `/open`, `/flush`, or `/close` endpoints.

## 7. Feature-required extensions

The complete Arbor system adds concrete local operations when their owning feature is implemented:

- the `system:` tree and mounted workspace paths become readable/mutable through the same node and mutation surface;
- scripts add explicit run/subscribe operations for compiled query and mutation handles;
- agents add run and transcript operations over agent files;
- sharing adds local create-share and accept-invitation operations, while remote object/ref/grant traffic remains the separate wire protocol;
- SQLite and Postgres row mutation use their store transaction boundaries and return ordinary mutation receipts/events.

These are required by their corresponding topic specs, but they do not justify a generic provider-operation registry in advance. Their exact routes and values are added to this document with the feature. Auth or authorization is added where the feature's trust boundary requires it, not as an abstract platform layer.
