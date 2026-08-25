# Arbord REST v1
*Part of the [Arbor spec](../spec.md): the language-neutral local client boundary.*

REST v1 is served by the local arbord over loopback. It is the persistence, resolution, mutation, and observation authority for local clients. A client does not need repository source or reference-client code to implement this contract.

All request and response bodies are UTF-8 JSON unless a route explicitly specifies SSE or multipart data. Unknown descriptive response fields are ignored. Missing required fields, unknown request fields, invalid unions, and ambiguous references are rejected.

```text
GET /v1/status
```

```ts
type ArbordStatus = {
  service: "arbord";
  version: string;
  protocolVersion: "v1";
};
```

The status route is the loopback readiness and compatibility probe. It does not open a workspace, mutate state, or expose workspace paths.

## 1. Common values and resolution

```ts
type TreeRef = "local" | "system" | string; // string is an opaque TreeID
type LogicalPath = string;                   // decoded, absolute within tree
type PageID = string;                        // opaque, non-empty
type Hash = `sha256:${string}`;
type EventCursor = string;                   // opaque outside event APIs

type NodeRef =
  | { tree?: TreeRef; path: LogicalPath }
  | { tree?: TreeRef; pageID: PageID; pathHint?: LogicalPath };

type ResolvedNodeRef = {
  tree: TreeRef;
  path: LogicalPath;
  pageID?: PageID;
};
```

Six-character lowercase `PageID`s are legacy values, not validation grammar. A `revision` selects immutable read-only history. An external URL is percent-decoded exactly once by the external parser; `LogicalPath` values in REST are already decoded and may contain literal percent characters.

Every reference leaving arbord retains its resolved `tree`. A mounted or composed child never inherits a parent's scope by omission. If both `path` and `pageID` are supplied, the ID is authoritative within the explicit tree; arbord returns the current readable path. Ambiguous or duplicate identity fails rather than choosing a candidate.

```text
GET /v1/resolve?locator={ArborLocator}
```

```ts
type Resolution = {
  ref: ResolvedNodeRef;
  canonical?: string;
  endpoint?: string;
  writable: boolean;
  historical: boolean;
  observedThrough: EventCursor;
};
```

## 2. Trees and nodes

```text
GET /v1/trees
GET /v1/node?tree={tree}&path={path}[&pageID={id}][&revision={hash}]
GET /v1/file?tree={tree}&path={path}
GET /v1/children?tree={tree}&path={path}[&revision={hash}][&cursor={cursor}]
GET /v1/search?tree={tree}&query={query}[&cursor={cursor}]
GET /v1/backlinks?tree={tree}&path={path}[&pageID={id}][&cursor={cursor}]
GET /v1/collection?tree={tree}&path={path}[&cursor={cursor}]
GET /v1/recovery?tree={tree}[&path={path}][&cursor={cursor}]
```

```ts
type AccessLevel = "none" | "read" | "write";

type AccessEntry = {
  id: string;
  kind: "everyone" | "profile" | "link";
  access: "read" | "write";
  locator?: string;
};

type TreeDescriptor = {
  id: string;
  name: string;
  osPath?: string;
  canonical?: string;
  canonicalPath?: string;
  httpURL?: string;
  endpoint?: string;
  publicAccess?: AccessLevel;
  access?: "read" | "write";
  accessEntries?: AccessEntry[];
  placement: "local" | "shared" | "remote";
  sync?: "idle" | "syncing" | "offline" | "conflict" | "error";
  legacy?: boolean;
  missing?: boolean;
};

type BodyState = "stored" | "implicit";

type MarkdownDocument = {
  source: string; // authoritative complete operational Markdown, including frontmatter
  frontmatter: Record<string, unknown>; // provider-derived read view
  frontmatterSource?: string;
  bodySource: string;
  blocks: ArborBlock[]; // provider-derived read view; never authored mutation input
};

type NodeSnapshot = {
  ref: ResolvedNodeRef;
  tree: TreeRef;
  enclosingTree?: TreeDescriptor;
  path: LogicalPath;
  name: string;
  kind: "markdown" | "directory" | "file" | "collection" | "database";
  writable: boolean;
  materialization: "available" | "placeholder";
  bodyState: BodyState;
  bodyOrigin?: "sibling" | "index";
  contentRevision?: Hash;
  directoryRevision?: Hash;
  document?: MarkdownDocument;
  collection?: CollectionSummary;
  diagnostics: Diagnostic[];
  observedThrough: EventCursor;
};

type TreeChild = {
  ref: ResolvedNodeRef;
  name: string;
  path: LogicalPath;
  kind: "markdown" | "directory" | "collection" | "database" | "file";
  materialization: "available" | "placeholder";
  pageID?: PageID;
};

type Page<T> = {
  items: T[];
  nextCursor?: string;
  observedThrough: EventCursor;
};
```

`canonicalPath` is the tree's current public boundary path, distinct from its full canonical locator. `accessEntries` carries safe entry metadata; link secrets never appear. `bodyOrigin` is optional diagnostic provenance and is meaningful only when a body is stored. `bodyState: "implicit"` means no body bytes exist yet, although `document.source` is still the complete operational directory Markdown. Reading it never materializes a file.

`GET /v1/file` returns the exact current bytes of an ordinary file and is the
provider-neutral byte surface for native clients. Its body is not JSON. The
response uses the file's media type when known, otherwise
`application/octet-stream`, and carries the current object revision as an
`ETag`. A directory, Markdown document, missing file, or historical reference
does not fall through to a rendered representation: it returns the ordinary
REST error for that reference. The route exposes current materialization only;
REST v1 does not provide historical ordinary-file access.

`MarkdownDocument`, `CollectionSummary`, and `Diagnostic` use the corresponding language-neutral shapes in the fixtures. Children, search hits, backlinks, collection rows, and recovery results carry explicit `ResolvedNodeRef` or equivalent explicit `tree` and path fields. Pagination cursors are opaque and scoped to their route and query. A cursor from another query is invalid.

### Local community device management

```text
GET    /v1/community/devices
POST   /v1/community/pairings
DELETE /v1/community/devices/{deviceID}
```

These loopback, same-origin routes proxy the connected authority using arbord's operating-system-held credential. They expose the wire protocol's safe device metadata and one-time pairing offer to the local account UI; they never expose the current device credential. A missing or unavailable credential fails with the ordinary local community error. Claiming a pairing is a direct authority operation performed by the new device, not a local arbord route.

Normative examples:

| Surface | Fixture |
|---|---|
| node | [node.json](fixtures/node.json) |
| local node | [node-untracked.json](fixtures/node-untracked.json) |
| system node | [node-system-tree.json](fixtures/node-system-tree.json) |
| children | [children.json](fixtures/children.json) |
| search | [search.json](fixtures/search.json) |
| backlinks | [backlinks.json](fixtures/backlinks.json) |
| collection | [collection.json](fixtures/collection.json) |
| recovery | [recovery.json](fixtures/recovery.json) |

## 3. Complete directory source

For a physical directory, `document.source` already contains the stored/implicit body plus one ordinary appended link for each immediate child not represented by its first eligible standalone link. The deterministic rules are in [format.md](format.md#complete-directory-documents). Clients do not hydrate or project another document.

For directory-backed nodes, `contentRevision` is an opaque hash over exact stored body bytes and canonical immediate-child descriptors. A successful write returns the exact accepted complete source and a new revision. `directoryRevision` may mirror this value for structural consumers, but it is not a separate index-ordering API.

## 4. Mutations

```text
POST /v1/mutations
POST /v1/assets
POST /v1/imports
```

```ts
type MutationRequest = { mutationID: string; operations: WorkspaceOperation[] };
```

A request is exactly one of:

- one content operation;
- one non-empty structural batch in one resolved tree and durability domain; or
- one singleton system operation.

Content operations are:

```ts
type ContentOperation =
  | {
      op: "writeMarkdown";
      ref: NodeRef;
      baseContentRevision: Hash;
      source: string;
      sourceEdits?: Array<{
        offset: number;
        length: number;
        replacement: string;
        expected?: string;
      }>;
    }
  | { op: "restoreRecovery"; ref: NodeRef; hash: Hash; baseContentRevision?: Hash }
  | { op: "ensureDocumentIdentity"; ref: NodeRef; baseContentRevision: Hash };
```

`sourceEdits`, when present, are optional provenance for a source-preserving editor admission. Offsets and lengths are nonnegative JSON safe integers addressing UTF-8 bytes in the exact source named by `baseContentRevision`. Edits are ordered, non-overlapping, in bounds, and interpreted simultaneously against that source. `expected`, when present, must equal the replaced UTF-8 text. Arbord applies the edits and requires the byte-exact result to equal `source`; otherwise it rejects the request before durable intent. A client may omit `sourceEdits`, and arbord may discard valid provenance when later provider behavior prevents it from proving the corresponding immutable base/result file objects.

Structural operations are:

```ts
type StructuralOperation =
  | { op: "createDirectory"; tree?: TreeRef; path: LogicalPath }
  | { op: "createMarkdown"; tree?: TreeRef; path: LogicalPath; source?: string }
  | { op: "rename"; ref: NodeRef; name: string }
  | { op: "move"; refs: NodeRef[]; destination: NodeRef }
  | { op: "copy"; refs: NodeRef[]; destination: NodeRef }
  | { op: "trash"; refs: NodeRef[] }
  | { op: "restore"; refs: NodeRef[] };
```

Reference arrays are non-empty. Structural operations use explicit scopes. Physical move names sources and a destination container; exact child-link placement is a subsequent `writeMarkdown` source mutation. Cross-tree transfer is explicit and cannot occur by placing two scopes in one batch.

System operations include:

```ts
type SystemOperation =
  | { op: "connectCommunity"; origin: string; accountToken: string }
  | { op: "disconnectCommunity" }
  | { op: "claimProfile"; origin: string; handle: string; path: string; displayName?: string }
  | { op: "createGroupProfile"; handle: string; path: string; displayName?: string }
  | { op: "promoteTree"; path: string; canonicalPath: string; audience: ShareAudience }
  | { op: "placeTree"; tree: string; path: string; endpoint?: string; canonical?: string }
  | { op: "removeTreePlacement"; path: string; endpoint?: string; canonicalPath?: string }
  | { op: "setTreeAccess"; tree: string; subject: AccessSubject; access: AccessLevel };

type ShareAudience =
  | { kind: "private" }
  | { kind: "everyone"; access: "read" | "write" }
  | { kind: "profile"; locator: string; access: "read" | "write" }
  | { kind: "rules"; rules: AccessRule[] };
type AccessRule = {
  subject: { kind: "everyone" } | { kind: "profile"; locator: string };
  access: "read" | "write";
};
type AccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; locator: string }
  | { kind: "link"; secret: string }
  | { kind: "entry"; id: string }
  | { kind: "all" };
```

`{kind:"entry", id}` with `access:"none"` revokes one access entry by stable entry ID. `{kind:"all"}` is valid only with `none` and removes every explicit audience entry. Profile locators resolve to stable profile `TreeID`s. Raw link secrets are generated by the client; only their digest crosses a durable mutation boundary.

`promoteTree` creates the child identity, canonical boundary, administering authority, and complete initial access rules atomically. `placeTree` verifies the canonical name and raw TreeID before materialization. `removeTreePlacement` removes only the local relationship described in [system.md](system.md#placement-registry-treesyaml). Arbord hashes a supplied link `secret` before recording durable intent and excludes it from receipts, events, errors, diagnostics, and logs.

The normative request is [mutation.json](fixtures/mutation.json); [operations.json](fixtures/operations.json) covers operation families. [mixed-mutation.json](fixtures/mixed-mutation.json) is rejected. An implementation validates the complete batch before recording durable intent.

Multipart asset and import metadata use [asset-metadata.json](fixtures/asset-metadata.json) and [import-metadata.json](fixtures/import-metadata.json). Retrying a transfer reuses the same mutation ID, metadata, ordering, bytes, and digests.

## 5. Durability, idempotency, and receipts

A successful authored mutation acknowledgement means both its effects and receipt survive immediate arbord termination. Arbord records an unambiguous normalized request identity before materialization and a completed receipt before returning success.

Retrying the same mutation ID with the same complete request returns the original receipt without applying intent twice. Reusing it with any different operation, precondition, metadata, or bytes returns `mutation-mismatch`. The contract must retain enough completed identity to distinguish a retry from new intent; exact journal layout and retention machinery are not normative.

```ts
type MutationReceipt = {
  mutationID: string;
  eventCursor: EventCursor;
  effects: Array<{
    kind: "created" | "updated" | "moved" | "deleted";
    tree: TreeRef;
    path: LogicalPath;
    previousPath?: LogicalPath;
    pageID?: PageID;
    contentRevision?: Hash;
    directoryRevision?: Hash;
  }>;
};
```

One receipt covers the complete logical operation, including sibling body/directory effects. Effects are in logical publication order. See [receipt.json](fixtures/receipt.json).

## 6. Errors

Every non-success JSON response uses:

```ts
type ArbordError = {
  error: string;
  message: string;
  retryable: boolean;
  path?: LogicalPath;
  tree?: TreeRef;
  current?: NodeSnapshot;
  owners?: LogicalPath[];
  mutationID?: string;
};
```

`error` is the stable application-level discriminator. Clients switch on that string and may ignore additional top-level context fields they do not understand.

Stable v1 codes are:

`invalid-reference`, `not-found`, `credential-unavailable`, `duplicate-page-id`, `duplicate-body-representation`, `stale-content-revision`, `stale-directory-revision`, `occupied-destination`, `reserved-boundary`, `unsafe-path`, `mutation-mismatch`, `read-only`, `permission-denied`, `not-materialized`, `unsupported-operation`, `resync-required`, and `internal-error`.

Clients preserve unknown future codes. Errors and diagnostics never expose raw credentials, access-link secrets, transaction paths, or private-state layout. [error.json](fixtures/error.json) deliberately uses an unknown code.

| Status | Meaning |
|---|---|
| `200` | read or committed/idempotently replayed mutation succeeded |
| `400` | malformed or unsafe request/reference/cursor |
| `403` | permission denied |
| `404` | node or entry absent |
| `405` | route exists but method is not REST v1 |
| `409` | revision, identity, placement, anchor, boundary, or mutation conflict |
| `422` | well-formed but read-only or unsupported operation |
| `500` | undeclared internal failure |

## 7. Lossless observation

Every read response includes `observedThrough`. A client following events strictly after that cursor cannot miss a later visible change.

```text
GET /v1/events?after={cursor}
Last-Event-ID: {cursor}
```

The query and header are equivalent; conflicting values are invalid. SSE frames are UTF-8, separated by a blank line. Multiple `data:` lines join with newline before JSON decoding. Comments and keepalives are ignored.

```ts
type WorkspaceEvent = {
  cursor: EventCursor;
  tree: TreeRef;
  kind: "created" | "updated" | "moved" | "deleted" | "diagnostic";
  path: LogicalPath;
  previousPath?: LogicalPath;
  pageID?: PageID;
  contentRevision?: Hash;
  directoryRevision?: Hash;
  origin: "api" | "external" | "recovery" | "sync";
  mutationID?: string;
};
```

Events are invalidations and observations, not replacement snapshots. An unavailable cursor returns `resync-required`; the client refetches visible state and resumes from the new snapshot cursor. Replay need not survive a daemon epoch, and its exact in-memory size is not normative. The complete framing vector is [events.sse](fixtures/events.sse).

## 8. Conformance

Language-neutral REST, locator, exact-source, and error fixtures live in [spec/fixtures](fixtures). TypeScript and Swift conformance suites consume the same files. Required-field rejection, obsolete block-write rejection, and unknown-field compatibility are tested at the live boundary.

The portable contract is the schemas and behavior in this document, not a reference client's internal structure, retry count, concurrency model, HTTP library, or verification machinery. Generic client invariants are specified separately in [client.md](client.md).
