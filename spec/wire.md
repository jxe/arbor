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

Public names are replaceable. `TreeID` identifies an Arbor tree and raw locator `arbor://tree/<TreeID>/`. `ProfileID` is the profile tree's `TreeID`; display names and handles never become authority identities.

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

### Device pairing

```text
POST   /.arbor/pairings
POST   /.arbor/pairings/{pairingID}/claim
GET    /.arbor/devices
DELETE /.arbor/devices/{deviceID}
```

Creating a pairing requires Bearer authentication and returns `{ id, secret, confirmationCode, expiresAt }` once with `cache-control: no-store`. Its QR/copy payload is versioned structured data `{ version: 1, origin, pairing: { id, secret } }`, not a navigation URL and never the existing device credential. Claim is unauthenticated but rate-limited; it accepts `{ secret, label }`, atomically consumes an unexpired pairing, and returns `{ deviceToken, device }` once. The old and new devices independently display `confirmationCode` before trust is accepted.

Listing and revoking devices require Bearer authentication. Safe device metadata is `{ id, account, label, createdAt, lastUsedAt, revokedAt }`; no list response contains credentials or pairing secrets. Pairing secrets are stored only as digests, compared in constant time, expire within ten minutes, and are single-use under concurrent claim. Revocation immediately denies future authority requests from that device without changing authored trees or already materialized local content.

## 3. Errors and statuses

Every non-success JSON response is:

```ts
type WireError = {
  error: string;
  message: string;
  retryable: boolean;
  tree?: TreeID;
  path?: string;
  handle?: string;
  current?: Hash;
};
```

`error` is the stable application-level discriminator. Clients switch on that string and may ignore additional top-level context fields they do not understand. The HTTP status remains the broad transport-level category.

Stable codes are `invalid-request`, `unauthenticated`, `permission-denied`, `not-found`, `already-claimed`, `conflict`, `mutation-mismatch`, `base-not-retained`, `authority-busy`, `reserved-boundary`, `rate-limited`, `quota-exceeded`, and `internal-error`.

| Status | Codes/meaning |
|---|---|
| `200` | successful read or idempotent operation |
| `201` | tree, claim, pairing, or paired device created |
| `400` | `invalid-request` |
| `401` | `unauthenticated` |
| `403` | `permission-denied` |
| `404` | `not-found` |
| `409` | `already-claimed`, `conflict`, `mutation-mismatch`, or `reserved-boundary` |
| `410` | `base-not-retained` |
| `413` | `quota-exceeded` for request/object size |
| `429` | `rate-limited` or quota rate |
| `500` | undeclared `internal-error` |
| `503` | retryable `authority-busy` or temporary `internal-error` |

`conflict` includes the current accepted update, base/candidate identities, a complete portable draft snapshot, and structured conflict reasons. `mutation-mismatch` means an idempotency key already attached to a successful outcome was reused with a different base or candidate. Clients preserve unknown future codes and do not treat malformed error bodies as authorization.

Stable `conflicts[].reason` values for `updates-v1` are `path-kind-conflict`, `nested-boundary-conflict`, `page-id-move-conflict`, `binary-conflict`, `frontmatter-conflict`, and `invalid-markdown-fence`. Clients preserve unknown future reasons.

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

### Refs, accepted updates, objects, and watch

```text
GET  /.arbor/trees/{TreeID}/ref
GET  /.arbor/trees/{TreeID}/updates?cursor={cursor}
POST /.arbor/trees/{TreeID}/updates
GET  /.arbor/trees/{TreeID}/watch
GET  /.arbor/objects/{sha256}
```

`GET .../ref` returns a `TreeDescriptor`. Read access is required.

`GET .../objects/{sha256}` returns exact canonical CBOR bytes with `content-type: application/vnd.ipld.dag-cbor`, `cache-control: public, immutable`, and an ETag equal to the quoted hash. The host verifies the request hash syntax. Possession of an object hash is not authorization: a reader can retrieve only objects reachable from a currently readable root; a writer can additionally retrieve objects reachable from any retained accepted update of a tree it can still write. Rejected candidates and client-owned conflict drafts never expand object authorization.

`GET .../updates` requires write access and returns the tree's accepted updates in acceptance order with opaque pagination cursors. Each item contains an opaque update ID, previous and accepted root, acceptance time, stable authenticated device subject when available, and `kind: "initial" | "accepted" | "merged" | "restored"`. A merge item additionally contains its base, candidate, previous remote root, and versioned merge summary. Invalid requests, unchanged submissions, and conflicts are not accepted updates and never appear in this collection.

`POST .../updates` requires write access and an `Idempotency-Key` header. It submits one candidate state for reconciliation against an exact accepted base:

```ts
type UpdateRequest = {
  base: { root: Hash; update: string };
  candidate: Hash;
  objects: Array<{ hash: Hash; bytes: string }>; // standard padded base64
};
```

The update named by `base.update` must belong to this tree and have `base.root`; this binds reconciliation to the exact accepted event the client observed even when a root later repeats. Each base64 string decodes to exact canonical CBOR bytes whose SHA-256 equals `hash`. The authority accepts already-known objects, validates the complete candidate graph, and compares it with the current accepted update:

1. Candidate already equals current: return `200 { outcome: "current", current }` and create no update.
2. Candidate equals base: return the current update for the client to apply and create no update.
3. Current equals base: atomically accept the candidate and return `201 { outcome: "accepted", update }`.
4. Both changed safely: merge once on the authority, atomically accept the merged root, and return `201 { outcome: "merged", update, merge }`.
5. Unsafe overlap: return `409 conflict` with current/base/candidate, structured reasons, and a complete draft snapshot consisting of its root plus every reachable object required to persist it. The accepted ref does not advance, no accepted update is created, and the authority retains neither the rejected candidate nor the conflict response/draft.

Idempotency is scoped to `(tree, authenticated credential subject, Idempotency-Key)`. For `current`, `accepted`, and `merged` outcomes, the server durably records the exact response before sending it. Repeating the key with the same base and candidate returns that response without another accepted update; changing either returns `409 mutation-mismatch`. A conflict is stateless on the authority: because it performs no mutation, an ambiguous retry may safely recompute against the then-current accepted update. The client must durably record its exact request before transmission and persist a received conflict response before acknowledging it locally; an explicit resolution uses a new idempotency key.

The authority rechecks the current update in the same transaction that accepts a result. It may recompute a bounded number of times after a concurrent acceptance. Exhaustion returns `503 authority-busy`; retrying the identical idempotency key remains safe. Supplying duplicate hashes with differing bytes is invalid.

`GET .../watch` requires read access and returns `text/event-stream; charset=utf-8`. Frames are UTF-8 and blank-line separated:

```text
id: <accepted-update-id>
event: ref
data: {...TreeDescriptor...}

```

Only `event: ref` is normative. `id` is the opaque accepted-update ID, so restoring a previously used root remains a distinct event. Multiple `data:` lines join with newline before JSON decoding; comments are keepalives. `Last-Event-ID` names the last observed accepted update. A host may immediately send the current descriptor when that update is no longer in its replay window. Watch is an invalidation channel: clients always verify the returned descriptor and fetch objects by hash. Conflicts are client-owned and never appear on this accepted-state channel.

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

A `tree` entry is a nested shared-tree boundary. Parent reachability stops at that entry; child objects, ref, history, and ACL are independent. A parent update must preserve a registered exact child boundary unless an authorized atomic boundary operation changes it; overwriting it as a file/directory returns `reserved-boundary`.

Canonical byte and hash vectors are in [fixtures/wire-objects.json](fixtures/wire-objects.json).

## 6. Namespace, identity, and convergence

One host serves the public community root at `/`, person/group profile boundaries at `/~<handle>`, and longer exact child boundaries. Longest accessible boundary prefix selects the `TreeID`; the remainder is a path inside it. An inaccessible nested boundary is omitted rather than exposed through parent bytes.

Promotion gives an existing subtree a new `TreeID` without changing stored Markdown `PageID`s. An external local folder may be projected at its canonical parent path without moving or copying its OS bytes. Reader-local nested placements never enter this graph.

Each tree has one mutable ref, a linear sequence of accepted updates, and immutable reachable objects. A client durably records its last accepted update plus candidate state and submits updates idempotently. The trusted authority fast-forwards one-sided changes and owns the sole automatic three-way merge implementation. Unsafe overlap returns a client-owned draft and visible structured conflict without advancing accepted history. Neither side is overwritten merely because one clock is later. Successful convergence yields identical root hashes on all peers.

## 7. Safe public HTTP projection

The canonical HTTP URL projects the current accessible tree/path. Extensionless URLs are canonical for Markdown logical nodes. An `Accept` header including `text/markdown` returns the untouched stored Markdown bytes with an appropriate Markdown content type. Otherwise a host may return safe semantic HTML.

Semantic HTML preserves headings, paragraphs, lists, code, images, toggles, footnotes, authored links, and accessible immediate-child navigation. `_index.md` is the directory body, not a child. Inaccessible nested boundaries and private children are omitted. Raw authored HTML, scripts, event handlers, and unsafe URL schemes are escaped or removed. Private content returns no bytes without valid account/profile/link authority.

When publishing a directory document, the authority applies the same complete operational Markdown rule as arbord: the first eligible standalone link represents each immediate visible physical child, and ordinary links for unmatched visible children are appended in unsigned UTF-8 logical-path order. Markdown, semantic HTML, navigation extraction, and static export must derive from that one provider-owned source, not from a client projection. Collection records, including physical Markdown row files and virtual/query-backed rows, and nested authority boundaries do not become directory-index links. The collection exception is tracked for reconsideration in [`plan/hardening/technical-debt.md`](../plan/hardening/technical-debt.md).

CSS fidelity, typography, exact layout, editor behavior, client refresh scheduling, polling intervals, and update scheduling are not wire requirements.
