# Local Arbor REST API
*Reference API for the current local daemon and its TypeScript and Swift clients. It is not part of the portable Arbor specification.*

The current version is Arbor Sync REST v1.

Arbor Sync binds to loopback and rejects cross-origin browser requests. JSON is
UTF-8. It rejects non-loopback `Host` headers so DNS rebinding cannot turn an
attacker-controlled origin into a local file reader. Request URLs never contain
credentials or access-link secrets.

## 1. Shared values

REST v1 reuses the portable model, read, locator, access, update, and
observation values defined across the specification. In particular,
`TreeID`, `LogicalPath`, `JSONValue`, and `NodeRef` come from the
[Arbor data model](../spec/01-tree-operations.md#the-arbor-data-model), while
`EventCursor`, `Hash`, `AccessLevel`, `TreeKind`, `TreeDescriptor`, and
`RemoteTreeDescriptor` come from the
[current-tree read](../spec/01-tree-operations.md#11-reading-the-current-tree).
REST v1 adds the following local values:

```ts
type TreeRef = "local" | "system" | TreeID;

type Diagnostic = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  path?: LogicalPath;
  row?: number;
  field?: string;
};

type LocalTreeDescriptor = TreeDescriptor & {
  name: string;
  placement: "placed" | "replica" | "remote";
  osPath?: string;
  sync?: "idle" | "syncing" | "offline" | "conflict" | "error";
  missing?: boolean;
};

type LocatorResolution = {
  ref: NodeRef;
  enclosingTree?: TreeDescriptor;
  historical: boolean;
  observedThrough: EventCursor;
};
```

- `local` and `system` are explicit local-only scopes, not pretend trees, and
  never cross Arbor Wire. Wherever a wire value says `TreeID`—`NodeRef.tree`,
  `ArborError.tree`, `ObservationEvent.tree`—REST v1 accepts a `TreeRef`.
- Only actual Arbor `TreeID`s receive descriptors; `GET /v1/trees` returns
  `LocalTreeDescriptor`s. Hosted ordinary trees have non-null canonical data and
  the private account-configuration tree has `canonical: null`.
- `LocatorResolution.enclosingTree` is present for Arbor trees and omitted for
  `local` and `system`; on the wire it is always present.

Every `NodeRef`, structural or content operation, result, event, effect, and
relevant error names its tree explicitly. Omitted-tree defaults are invalid.
Clients derive writability from effective access and historical state;
resolution does not duplicate a `writable` flag.

## 2. Access and errors

Access subjects, levels, and the `none` removal rule are defined once in
[configuration](../spec/05-accounts-and-devices.md#3-configuration-yaml). Configuration
and mutation requests use the wire's `AccessRule`; safe administrative
responses use `AccessEntry`, whose link subject exposes neither raw secret nor
digest ([access control §1](../spec/06-access-control.md#1-subjects-and-rules)).

Every non-2xx JSON error uses the wire's `ArborError` envelope with
`tree?: TreeRef`. Shared codes are `invalid-request`, `unauthenticated`,
`permission-denied`, `not-found`, `conflict`, `read-only`,
`unsupported-operation`, `resync-required`, `rate-limited`, `quota-exceeded`,
and `internal-error`. Conflict details are discriminated as `server-update`,
`workspace-revision`, or `account-configuration`; domain-specific fields live
inside `details`, not alongside the envelope. Clients tolerate unknown codes
and fields but never reinterpret malformed required data.

## 3. Status, trees, and resolution

```text
GET  /v1/status
POST /v1/sync
POST /v1/sessions
POST /v1/tree-ids
GET  /v1/trees
GET  /v1/accounts
GET  /v1/resolve?locator={ArborLocator}
```

Status returns the service and protocol versions plus the current `DeviceID`
when connected. `POST /v1/sync` waits for the daemon's current synchronization
pass and lets attached CLI clients use the same process rather than creating a
second writer. `POST /v1/sessions` accepts one absolute local root and activates
the daemon's filesystem watching and durable node identity for that browsing
session; repeated activation of the same root is idempotent.
`POST /v1/tree-ids` returns an unreserved client-generated
`{ id }`; it edits no file and reserves no server state. New IDs are `tr_`
plus 26 lowercase base32 characters encoding 128 random bits.

`GET /v1/trees` returns `{ snapshot: LocalTreeDescriptor[], observedThrough }`.
It includes placed trees, pathless replicas, known remote placements, and the
implicit authenticated account-configuration tree. It never invents a
descriptor for `local` or `system`.

`GET /v1/accounts` returns a safe list keyed by configuration TreeID. Each
entry reports its Canopy origin, profile TreeID, current DeviceID, credential
availability, diagnostics, and an optional Canopy-specific presentation
handle. The handle and origin are never account identity or credential keys.

Fresh v2 account bootstrap and account-qualified pairing use:

```text
POST /v1/bootstrap/accounts
POST /v1/bootstrap/pairings
```

The first accepts `{ account, path, displayName? }`, where `account` is the
complete Canopy-allocated account URL and `path` is an already identified—or
newly identified—local person-profile root. It creates no profile snapshot or
tree placement. The pairing route accepts `{ configurationTree? }`; the field
is mandatory when more than one account exists. The old handle-shaped claim
route is v1 compatibility only.

Resolution returns `LocatorResolution`. A remote unplaced result is read
transiently using its explicit tree and server; it does not create a virtual
tree, placement, or directory.

## 4. Node reads

```text
GET /v1/node?tree={TreeRef}&path={path}[&stableKey={key}][&revision={hash}]
GET /v1/file?tree={TreeRef}&path={path}[&stableKey={key}][&revision={hash}]
GET /v1/children?tree={TreeRef}&path={path}[&stableKey={key}][&revision={hash}][&cursor={cursor}]
GET /v1/search?tree={TreeRef}&q={query}[&cursor={cursor}]
GET /v1/backlinks?tree={TreeRef}&path={path}[&stableKey={key}][&cursor={cursor}]
GET /v1/recovery?tree={TreeRef}&path={path}[&stableKey={key}][&recursive=true][&cursor={cursor}]
```

Every node-addressed route requires `tree` and `path`, even where `tree` is
`local` or `system`. An omitted or empty `stableKey` means JSON `null`; a
non-empty value is canonical identity-key JSON percent-encoded by the client.
The removed PageID/path-hint union is invalid. JSON `NodeRef` values still
require an explicit `stableKey` field, including `null`. Logical paths are
decoded exactly once. Revision reads are immutable and read-only.
Mutable JSON reads include `observedThrough`; lists and bare arrays use explicit
snapshot/page envelopes. `GET /v1/file` returns exact bytes and does not need an
independent cursor because its guarding content revision is obtained from the
node snapshot. A node snapshot contains `ref`, properties, capabilities,
optional exact-source content, materialization, diagnostics, and observation
state. Child pages contain `NodeSummary` values and are fetched explicitly;
`GET /v1/node` never hydrates or drains children.

Logical-node rules come from the [data model](../spec/01-tree-operations.md); exact
directory source, `_index.md`, frontmatter, and child-placement rules come from
the portable [directory projection](../spec/03-directory-format.md).
Children are also the table/row browsing API: child summaries carry projected
row properties and schema capability without a collection-specific endpoint.
Children, search, backlinks, recovery entries, mounted boundaries, events, and
effects all retain explicit tree scope.

For collection-file backings, `_store.csv`, `_store.json`, and `_store.jsonl` rows
receive durable references only when `schema.ts` declares a valid primary key.
Their child pages use a cursor bound to the exact source/schema revision and
advance by stable key. Missing, invalid, or duplicate declared keys leave the
affected rows explicitly identity-less and read-only; the server never
substitutes a row offset as durable identity. Markdown rows may derive the same
identity from a schema-declared `id` property.

## 5. Model-sampling values

Node reads return these provider-neutral sampling values. They build on the
portable `NodeRef`, `Hash`, and `JSONValue` plus the local `Diagnostic`, but are a local API
surface, not another stored graph or a wire operation. The language-neutral
vectors in [`conformance/node-model.json`](../conformance/node-model.json)
freeze their positive and negative cases.

```ts
type IdentityRule = {
  properties: string[];
};

type ChildBackingSummary =
  | { type: "expanded-files" }
  | {
      type: "collection-file";
      format: "csv" | "json" | "jsonl";
      childSetHash: Hash;
    }
  | { type: "database"; driver: "sqlite"; scope: "children" | "subtree" }
  | { type: "external-store"; driver: string };

type NodeCapabilities = {
  properties?: { revision: string; schema?: Hash; writable: boolean };
  content?: {
    revision: string;
    mediaType: string;
    format?: "markdown" | "mdx" | "tsx" | "json";
    writable: boolean;
  };
  children?: {
    revision: string;
    schema?: Hash;
    backing?: ChildBackingSummary;
    total?: number;
    writable: boolean;
  };
  executable?: {
    version: Hash;
    state: "runnable" | "diagnostic" | "inactive";
  };
};

type NodeContent = {
  source: string;
  representation?: {
    state: "stored" | "implicit";
    origin?: "sibling" | "index";
  };
};

type NodeSummary = {
  ref: NodeRef;
  name: string;
  revision: string;
  properties: Record<string, JSONValue>;
  capabilities: NodeCapabilities;
  materialization: "available" | "placeholder";
  diagnostics: Diagnostic[];
};

type NodeSnapshot = NodeSummary & {
  content?: NodeContent;
  observedThrough: EventCursor;
};

type ChildrenPage = {
  parent: NodeRef;
  items: NodeSummary[];
  nextCursor: string | null;
  observedThrough: EventCursor;
};
```

`ref` is the sole tree/path/identity carrier; snapshots and summaries do not
repeat `tree`, `path`, `kind`, `pageID`, or collection-specific fields.
Properties and content remain independent, and an omitted content payload does
not negate a content capability—for example, clients normally fetch large file
bytes separately. Capability names and states are fail-closed: an unknown
capability or format may be retained or ignored for forward compatibility but
never grants editing, execution, traversal, or file access.

Clients may derive a parsed Markdown document from exact `NodeContent.source`;
that derived representation is not a second authored value. Markdown property
and content operations are addressed separately even when their capability
revisions name the same exact source bytes. A `ChildBackingSummary`
describes the observed placement; it does not make backing or projection
topology part of node identity. The exact synchronized collection-file form is
the directory-level `CollectionFileDescriptor` defined by
[tree reads](../spec/01-tree-operations.md#14-interpreting-the-object-graph);
SQLite remains a distinct database backing.

The REST routes carry `NodeRef` without inventing a second locator shape. Node
reads take it as the `tree`, `path`, and `stableKey` query parameters described
in [§4](#4-node-reads); JSON mutation and transfer requests embed the three
fields directly. The removed `pageID | pathHint` request union is invalid on
every route. The local-only `local` and `system` scopes use the same three-field
shape even though those sentinel scopes never cross Arbor Wire.

## 6. Authored mutations

```text
POST /v1/mutations
POST /v1/assets
POST /v1/imports
```

`/v1/mutations` accepts `{ mutationID, operations }`. `mutationID` is a stable
client-generated idempotency identity for one exact serialized intent.
Operations include ordinary property, content, and structural actions:
`writeProperties`, `writeText`, `writeMarkdown`, `create`, `move`, `copy`,
`trash`, and `restore`. Each operation includes explicit tree-scoped references
and the appropriate content or directory base revision.

`writeText` is the exact guarded UTF-8 operation for ordinary files such as the
configuration YAML:

```ts
type WriteText = {
  op: "writeText";
  ref: { tree: TreeRef; path: LogicalPath };
  baseContentRevision: string;
  source: string;
};
```

Arbor Sync rejects `writeText` for non-UTF-8 content, protected private state,
historical reads, and stale revisions. A successful edit of account YAML is an
ordinary file edit locally; configuration governance is applied when the
candidate account-tree update is synchronized.

Markdown writes submit the complete operational source and its exact
`baseContentRevision`. Optional ordered nonoverlapping UTF-8 source edits may
prove editor provenance, but the complete source remains authoritative.
`writeProperties` is the representation-independent direct-edit operation:

```ts
type WriteProperties = {
  op: "writeProperties";
  ref: { tree: TreeRef; path: LogicalPath; stableKey: string | null };
  basePropertiesRevision: string;
  properties: Record<string, JSONValue>;
};
```

Its semantics—complete map, omitted keys as deletions, explicit `null` as a
value, immutable identity properties, and exact Markdown body preservation—are
specified once in the
[directory format](../spec/03-directory-format.md#3-properties-markdown-content-and-identity);
collection-file and database row writes follow [child backings](../spec/07-child-backings.md).
Identity-less rows and collection-file membership remain read-only. Named
executable mutations remain the surface for authorization, multi-row work,
cascades, and business invariants.
Structural operations guard the relevant directory revisions. Multipart assets
and imports contain explicit destination `NodeRef`s and are idempotent under the
same mutation identity rules.

A successful receipt includes the mutation identity, committed tree-scoped
result/effects, and `observedThrough`. A property effect includes the exact
`changedProperties` names when the provider can prove them; omission requires
observers to invalidate conservatively. Acknowledgement means the authored
intent and eventual receipt are crash-recoverable. An exact replay returns the
same receipt. Reusing an ID for different bytes is `conflict`; ambiguous
transport failure permits only exact replay.

Steady-state placement, ACL, canonical-boundary, profile/community,
administrator, and device-revocation changes are not special arborsync mutations.
Human clients and the CLI perform source-preserving transformations of
`account.yaml`, `trees.yaml`, or the authorized device file. REST v1 therefore
has no `connectCommunity`, `disconnectCommunity`, `createGroupProfile`,
`promoteTree`, `placeTree`, `removeTreePlacement`, `setTreeAccess`, local device
list/revoke proxy, or `/v1/remote` route.

## 7. Bootstrap and local recovery

Narrow operations remain for states that cannot yet be represented by editing
an authenticated configuration tree:

```text
POST /v1/bootstrap/claims
POST /v1/bootstrap/pairings
POST /v1/local/forget
POST /v1/conflicts/{TreeID}/resolve
```

Claim bootstrap generates the profile, configuration, and device identities
and device credential locally, stores the raw credential immediately in the OS
credential store, constructs the initial snapshots, and calls Canopy
claim endpoint. It is restart-idempotent and never rewrites user-authored YAML
to insert IDs or normalize it. Pairing creates or claims the server pairing
while similarly keeping the raw new-device credential local. Local forget
disconnects this data home without revoking the server device or deleting
user files. Typed conflict resolution names an exact stored private conflict
identity and never adds a resolution field to YAML.

## 8. Snapshot then observe

All mutable snapshots establish an observation boundary. Clients first read a
snapshot and then observe strictly after its cursor:

```ts
type ObservationEvent<TKind extends string, TChange> = {
  cursor: EventCursor;
  tree: TreeRef;
  kind: TKind;
  change: TChange;
};
```

```text
GET /v1/events?after={cursor}
Last-Event-ID: {cursor}
```

`after` and `Last-Event-ID` are equivalent; supplying both with different
values is `invalid-request`. The stream is UTF-8 SSE. Frames are separated by a
blank line; multiple `data:` lines join with newline; comments and keepalives
are ignored. Every semantic frame satisfies `id === data.cursor` and
`event === data.kind`. Events invalidate or describe domain-specific local
changes but do not replace a confirming snapshot.

If a cursor is no longer replayable, arborsync sends one terminal
`resync-required` event using the same envelope and closes. The client reads a
fresh snapshot and resumes after its cursor. This guarantees no gap between the
snapshot and following stream.

Local workspace events and server accepted-update events deliberately keep
different `kind` and `change` payloads. Sharing the observation framing does
not claim the domain events are identical.

## 9. Reference fixtures

The TypeScript and Swift reference clients consume the REST JSON and SSE
fixtures under [`tests/fixtures/arborsync`](../tests/fixtures/arborsync). Their shared
tests cover explicit tree scope, write guards, exact replay, snapshot/SSE gap
freedom, multiline data, keepalives, conflicting-cursor rejection, and terminal
resynchronization. Another local implementation may expose the same underlying
Arbor behavior through a different client/daemon boundary.
