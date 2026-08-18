# Arbor wire protocol
*Part of the [Arbor spec](../spec.md): an independently implementable community authority, object, synchronization, access, and public-projection protocol.*

An Arbor wire host represents one community. It owns canonical namespace boundaries, profile/account identity, claims, whole-tree access entries, one mutable ref per `TreeID`, immutable objects, and watch streams. It need not implement a local workspace, UI, scripts, or private local-state layout.

All `/.arbor/*` request and response JSON is UTF-8 with `content-type: application/json`. Unless stated otherwise responses use `cache-control: no-store`. Clients ignore unknown descriptive response fields but reject missing required fields and malformed values.

## 1. Values and descriptors

```ts
type TreeID = string;                 // opaque, stable, non-empty
type ProfileID = TreeID;
type Hash = `sha256:${string}`;       // 64 lowercase hexadecimal SHA-256 digits
type AccessLevel = "none" | "read" | "write";

type TreeDescriptor = {
  id: TreeID;
  canonicalPath: string;             // decoded absolute authority path
  parentTree?: TreeID;
  kind: "community-profile" | "person-profile" | "group-profile" | "shared-subtree";
  ref: Hash;
  publicAccess: AccessLevel;
  access: AccessLevel;               // effective access for this response
  httpURL: string;
  arborURL: string;
};

type AccountDescriptor = {
  id: string;
  handle: string;
  profileTree: ProfileID;
  profileURL: string | null;
  community: TreeDescriptor;
  writableProfiles: TreeDescriptor[];
};

type AccessEntry = {
  id: string;
  kind: "everyone" | "profile" | "link";
  access: "read" | "write";
  locator?: string;                  // safe profile locator; absent for link
};
```

Public names are replaceable. `TreeID` identifies a shared tree and raw locator `arbor://tree/<TreeID>/`. `ProfileID` is the profile tree's `TreeID`; display names and handles never become authority identities.

## 2. Authentication and access links

Account/device requests use:

```http
Authorization: Bearer <account-device-token>
```

An access-link request uses:

```http
X-Arbor-Access: <raw-link-secret>
```

A request may supply both; the host grants their maximum valid access. Tokens and raw link secrets never appear in URLs, redirects, response bodies, error messages, logs, refs, objects, access listings, or watch events. Only `sha256:<hex>` of the exact UTF-8 link secret is stored as a link subject.

Access is whole-tree and independently evaluated at every nested boundary. Levels are `none`, `read`, and `write`. A profile entry names a stable person/group profile `TreeID`. Group-derived authority evaluates verified current authored membership; membership alone does not grant write to the group tree. Revocation prevents future wire reads/writes but cannot erase bytes already materialized by a reader.

## 3. Errors and statuses

Every non-success JSON response is:

```ts
type WireError = {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    tree?: TreeID;
    path?: string;
    handle?: string;
    current?: Hash;
  };
};
```

Stable codes are `invalid-request`, `unauthenticated`, `permission-denied`, `not-found`, `already-claimed`, `ref-conflict`, `reserved-boundary`, `rate-limited`, `quota-exceeded`, and `internal-error`.

| Status | Codes/meaning |
|---|---|
| `200` | successful read or idempotent operation |
| `201` | tree or claim created |
| `400` | `invalid-request` |
| `401` | `unauthenticated` |
| `403` | `permission-denied` |
| `404` | `not-found` |
| `409` | `already-claimed`, `ref-conflict`, or `reserved-boundary` |
| `413` | `quota-exceeded` for request/object size |
| `429` | `rate-limited` or quota rate |
| `500` | undeclared `internal-error` |

`ref-conflict` includes `current`. Clients preserve unknown future codes and do not treat malformed error bodies as authorization.

## 4. Endpoints

### Account and tree discovery

```text
GET  /.arbor/account
GET  /.arbor/trees
POST /.arbor/trees
```

`GET /.arbor/account` requires Bearer authentication and returns an `AccountDescriptor`. `GET /.arbor/trees` returns a `TreeDescriptor[]`, filtered to trees readable by the supplied authority.

`POST /.arbor/trees` requires an account with write authority over the requested parent boundary:

```ts
type CreateTreeRequest = {
  canonicalPath: string;
  root: Hash;
  objects: Array<{ hash: Hash; bytes: string }>;
  kind?: "group-profile" | "shared-subtree";
  publicAccess?: AccessLevel;
  profileAccess?: Array<{ locator: string; access: "read" | "write" }>;
};
```

The host resolves the parent boundary from `canonicalPath` and the authenticated account, then verifies complete object reachability, path availability, profile schema when applicable, unique subjects, and parent authority. Creation, boundary reservation, administering-profile authority, root ref, and initial access commit atomically. It returns `201 TreeDescriptor`.

### Claims

```text
POST /.arbor/claims/{handle}
```

This route is anonymous only for an unresolved person locator reserved by current community-root content.

```ts
type ClaimRequest = {
  root: Hash;
  objects: Array<{ hash: Hash; bytes: string }>;
};
type ClaimResult = {
  accountToken: string;              // returned once
  account: AccountDescriptor;
  tree: TreeDescriptor;
};
```

The supplied reachable root must be a valid visible person-profile document. The authority atomically verifies the reservation, creates the public-read person profile at `/~<handle>`, creates its account/device credential, and returns `201 ClaimResult`. The first successful claim wins; later or concurrent claims return `already-claimed`. A response and all intermediaries use `cache-control: no-store`.

### Refs, objects, push, and watch

```text
GET  /.arbor/trees/{TreeID}/ref
POST /.arbor/trees/{TreeID}/push
GET  /.arbor/trees/{TreeID}/watch
GET  /.arbor/objects/{sha256}
```

`GET .../ref` returns a `TreeDescriptor`. Read access is required.

`GET .../objects/{sha256}` returns exact canonical CBOR bytes with `content-type: application/vnd.ipld.dag-cbor`, `cache-control: public, immutable`, and an ETag equal to the quoted hash. The host verifies the request hash syntax. Possession of an object hash is not authorization: the host returns it only when it is reachable from at least one tree readable by the supplied Bearer/access-link authority.

`POST .../push` requires write access:

```ts
type PushRequest = {
  expected: Hash;
  root: Hash;
  objects: Array<{ hash: Hash; bytes: string }>; // standard padded base64
};
```

Each base64 string decodes to exact canonical CBOR bytes whose SHA-256 equals `hash`. The host accepts already-known objects, verifies every object reachable from `root`, validates names and registered child boundaries, then compare-and-swaps the tree ref from `expected` to `root`. Success returns a `TreeDescriptor`. A stale `expected` returns `409 ref-conflict` with the current root and advances nothing. Supplying duplicate hashes with differing bytes is invalid.

`GET .../watch` requires read access and returns `text/event-stream; charset=utf-8`. Frames are UTF-8 and blank-line separated:

```text
id: sha256:<new-root>
event: ref
data: {...TreeDescriptor...}

```

Only `event: ref` is normative. `id` is the new root. Multiple `data:` lines join with newline before JSON decoding; comments are keepalives. `Last-Event-ID` may name the last observed root. A host may immediately send the current descriptor when that root is no longer in its replay window. Watch is an invalidation channel: clients always verify the returned descriptor and fetch objects by hash.

### Access

```text
GET  /.arbor/trees/{TreeID}/access
POST /.arbor/trees/{TreeID}/access
```

Administration authority is required. `GET` returns an `AccessEntry[]`; link entries never include a raw secret or digest.

```ts
type SetAccessRequest = {
  subject:
    | { kind: "everyone" }
    | { kind: "profile"; locator: string }
    | { kind: "link"; digest: Hash }
    | { kind: "entry"; id: string }
    | { kind: "all" };
  access: AccessLevel;
};
```

`none` removes the matching entry. `{kind:"entry"}` revokes by stable entry ID. `{kind:"all"}` is valid only with `none` and removes every explicit audience entry. Setting an existing subject replaces its level without changing tree identity. The administering profile's implicit authority cannot be removed through this endpoint.

### Well-known discovery

```text
GET /.well-known/arbor
GET /.well-known/arbor/{canonical-path}
```

The bare route resolves the community root. A longer route percent-decodes the external path exactly once and performs longest canonical-boundary resolution. The response is a `TreeDescriptor` with an additional `path` containing the decoded absolute path inside that tree. Internal paths may contain literal percent characters.

See [fixtures/wire-endpoints.json](fixtures/wire-endpoints.json) for language-neutral request/response vectors.

## 5. Deterministic objects

Objects are deterministic CBOR (RFC 8949 deterministic encoding profile) with no floats, tags, indefinite lengths, duplicate map keys, or non-text map keys.

```ts
type FileObject = {
  type: "file";
  bytes: Uint8Array;
};

type DirectoryObject = {
  type: "directory";
  entries: Array<
    | { name: string; hash: Hash }
    | { name: string; tree: TreeID }
  >;
};
```

Strings are UTF-8 and are not Unicode-normalized by the protocol. A filename is non-empty and is not `.`, `..`, `_index.md` as a projected duplicate, or a string containing `/`, `\`, NUL, or invalid Unicode scalar data. An entry has exactly one of `hash` or `tree`. Duplicate names are invalid.

Directory `entries` are sorted by lexicographic comparison of their UTF-8 byte sequences, not locale, collation, case folding, or platform filesystem order. Map keys use deterministic CBOR key ordering: shorter encoded key first, then lexicographic encoded bytes.

The object hash is `sha256:` followed by lowercase hexadecimal SHA-256 of the exact canonical CBOR byte sequence. JSON transport uses standard padded base64 of those exact bytes. Decoding and re-encoding must reproduce the same bytes; noncanonical encodings are rejected even if their data model is equivalent.

A `tree` entry is a nested shared-tree boundary. Parent reachability stops at that entry; child objects, ref, history, and ACL are independent. A parent push must preserve a registered exact child boundary unless an authorized atomic boundary operation changes it; overwriting it as a file/directory returns `reserved-boundary`.

Canonical byte and hash vectors are in [fixtures/wire-objects.json](fixtures/wire-objects.json).

## 6. Namespace, identity, and convergence

One host serves the public community root at `/`, person/group profile boundaries at `/~<handle>`, and longer exact child boundaries. Longest accessible boundary prefix selects the `TreeID`; the remainder is a path inside it. An inaccessible nested boundary is omitted rather than exposed through parent bytes.

Promotion gives an existing subtree a new `TreeID` without changing stored Markdown `PageID`s. An external local folder may be projected at its canonical parent path without moving or copying its OS bytes. Reader-local nested placements never enter this graph.

Each tree has one mutable ref and immutable reachable objects. Writers push with compare-and-swap. A client records the last common root, fast-forwards when only one side advances, and preserves local content plus a visible conflict when local and remote both diverge. It never overwrites either side merely because one clock is later. Successful convergence yields identical root hashes on all peers.

## 7. Safe public HTTP projection

The canonical HTTP URL projects the current accessible tree/path. Extensionless URLs are canonical for Markdown logical nodes. An `Accept` header including `text/markdown` returns the untouched stored Markdown bytes with an appropriate Markdown content type. Otherwise a host may return safe semantic HTML.

Semantic HTML preserves headings, paragraphs, lists, code, images, toggles, footnotes, authored links, and accessible immediate-child navigation. `_index.md` is the directory body, not a child. Inaccessible nested boundaries and private children are omitted. Raw authored HTML, scripts, event handlers, and unsafe URL schemes are escaped or removed. Private content returns no bytes without valid account/profile/link authority.

When publishing a directory document, the authority applies the same complete operational Markdown rule as arbord: the first eligible standalone link represents each immediate visible physical child, and ordinary links for unmatched visible children are appended in unsigned UTF-8 logical-path order. Markdown, semantic HTML, navigation extraction, and static export must derive from that one provider-owned source, not from a client projection. Collection records, including physical Markdown row files and virtual/query-backed rows, and nested authority boundaries do not become directory-index links. The collection exception is tracked for reconsideration in [`plan/technical-debt.md`](../plan/technical-debt.md).

CSS fidelity, typography, exact layout, editor behavior, client refresh scheduling, polling intervals, and push timing are not wire requirements.
