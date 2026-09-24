# Tree reads, writes, watching, and editor round trips
*Part of the [Overstory spec](README.md): the logical tree model and the operations that read, change, observe, and faithfully materialize copies.*

## The Overstory data model

### Trees and identity

Overstory is conceptually a global hash table of trees:

```ts
type TreeID = string;
type Name = string;
type LogicalPath = string;
type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [name: string]: JSONValue };

type Overstory = Map<TreeID, Tree>;
```

The same tree can be placed many times. Copies with the same `TreeID` are
placements or working trees of one tree. The `TreeID` denotes the same logical tree
and history wherever Overstory is implemented. Even local, private, unpublished,
and offline trees have these IDs, although no public service can find them yet.
Each device, community, and application knows only the partial map it can
locate and read.

TreeIDs are generated randomly and locally when people share files or folders.
Person-profile TreeIDs are instead derived from a public identity key, allowing
the person who holds its private key to prove control. See
[accounts §1.1](04-accounts-and-devices.md#11-beginning-a-person-identity).

Trees have one history and one ACL.

### Nodes, children, and readings

A tree is a rooted hierarchy of nodes, where each node has properties, optional content, and children.

```ts
interface Tree {
  root: Node;
}

interface Node {
  properties: Record<string, JSONValue>;
  content?: Content;
  children: ChildSet;
}

interface ChildSet {
  members: Map<Name, Node>;
  schema?: ChildSchema;
}
```

In Overstory, records, tables, files, and documents are all ways to read nodes:

| Reading | Representation |
|---|---|
| Document | content, with properties as its frontmatter |
| File | content bytes |
| Directory | children |
| Record | properties as fields |
| Collection | children that share a schema |
| Row | one child of a collection, keyed by a rule its parent declares |
| Executable document or agent | content that has been granted reviewed execution capabilities |

A Markdown page with frontmatter is therefore both a document and a record. A
folder of such pages can be read as both a directory and a database table.

For representing typed collections, a child set may declare a schema shared by its members. A node whose children share such a schema can be read as a collection. The schema defines member property and content shapes, stable identity, logical naming, relationships, ordering, and constraints.

### Representations

A placement chooses how to materialize a tree. The
[portable directory projection](02-directory-format.md) maps ordinary files
and folders into the model, while [child backings](06-child-backings.md) allow
a child set to be represented by expanded files, a collection file, a database,
or an external store. This representation choice is the child set's *backing*
at that placement.

### Representation and model equality

Exact representation equality and logical model equality answer different
questions. A bytes hash identifies one exact authored byte sequence. The protocol
root is the corresponding exact identifier for a complete accepted snapshot:
as the object hash of the top directory, it transitively commits to the
canonical Overstory encoding of every reachable object. It is not a logical model
hash.

A model hash identifies normalized node state: properties, content, and child
set, including the child schema and the model hashes of its members. Two
representations can therefore have different authored bytes and Overstory roots but
the same model hash. Model hashes prove that decoding different
representations produced equivalent logical state; they do not turn two trees
with different `TreeID`s into the same tree.

A provider computes model hashes only where doing so is bounded and useful. A
database row can cheaply expose one for guarded writes, while a live database
does not maintain a whole-table model hash. Freshness for an unbounded or live
backing is expressed with its committed observation cursor instead.

## 1. Reading trees

### 1.1 Current tree, accepted snapshots, and watch

A working tree bootstraps by reading the current tree descriptor, obtaining
that descriptor's content-addressed accepted snapshot, and then following the
watch endpoint after the descriptor's observation cursor.

A snapshot MAY be installed sparsely: directory objects and Markdown file
objects present, every other file object referenced by hash only. A sparse
install counts as the complete accepted snapshot only when every referenced
hash is resolvable on demand and the client has validated the spine (the root
is a present directory, every present object is reachable, and the graph is
acyclic). A payload-less entry the client cannot classify as a file fails the
install.

```text
GET /.arbor/trees/{TreeID}
GET /.arbor/trees/{TreeID}/snapshots/{root}
GET /.arbor/trees/{TreeID}/watch?after={cursor}
```

### 1.1.1 Reading the current tree

```text
GET /.arbor/trees/{TreeID}
```

The response atomically identifies one current accepted root, the accepted
update that produced that observation, and the cursor after which a client may
watch without a read/watch race:

```ts
type CurrentTree = {
  tree: RemoteTreeDescriptor;
  observedThrough: EventCursor;
};

type RemoteTreeDescriptor = {
  id: TreeID;
  kind: "ordinary" | "account-configuration";
  access: "none" | "read" | "write";
  root: Hash;
  update: string;
  conflicted: boolean;
  canonical: {
    path: LogicalPath;
    endpoint: string;
    parentTree: TreeID | null;
  } | null;
};

type EventCursor = string;
type Hash = `sha256:${string}`;
```

The descriptor's `access` summarizes the caller's effective whole-tree access.
Scoped or executable-constrained authority is evaluated by
[access control](05-access-control.md), not encoded as named mutation permissions.
The descriptor's `root` is the bytes hash of the current accepted tree state
and `update` is the accepted-update id that produced this observation.
The enclosing read's `observedThrough` is the cursor after which watching begins.
It is an observation boundary, not an alias for the accepted `update` identity.
The read binds the descriptor and this boundary atomically.
Hosted trees have, in addition, a canonical path, endpoint, and might be nested
inside a parent tree.

The same root may be accepted again by a later update. Its graph remains the
same content-addressed snapshot, while the later descriptor's `update` identifies
the new accepted state and the enclosing `observedThrough` gives its read/watch boundary.

An execution runtime presenting an [execution token](05-access-control.md#21-execution-tokens)
obtains a host-backed source's authority summary and coherent `(root, update,
observedThrough)` from this same read. There is no separate source-binding route;
provider-backed sources are host configuration, not tree state.

#### 1.1.2 Reading an accepted snapshot

```text
GET /.arbor/trees/{TreeID}/snapshots/{root}
```

An accepted snapshot is the self-contained transition from nothing to one
retained accepted root, so its body carries only a format version and complete
objects:

```ts
type SnapshotBundle = {
  version: 1;
  objects: Uint8Array[];
};
```

The response uses `application/cbor` and is the canonical CBOR encoding of
exactly that map. Each member of `objects` is a CBOR byte string containing the
exact bytes of one object (raw file bytes or a canonical CBOR directory). Members are ordered
lexicographically by the SHA-256 hash derived from those bytes; hashes are not
repeated in the body.

The requested root in the URL identifies the graph and is not repeated in the
body. As the top directory object's hash, it transitively commits to every
reachable object. A client hashes every supplied byte string, rejects duplicate
hashes, requires the requested root to be a present canonical directory,
and walks its graph using the kind on each reference. A referenced directory
must decode canonically; file bytes are never decoded. A hash referenced as
both file and directory in the same graph is invalid. It rejects missing reachable objects and
unreachable extras, stopping at nested-tree boundaries. The definite-length
`objects` array supplies the object count; the snapshot carries no tree,
accepted-update, or observation-cursor metadata.

The quoted `ETag` is the SHA-256 hash of the exact response bytes and is only an
HTTP representation validator; it does not introduce a second snapshot
identity.

The server returns a snapshot only when the caller can currently read the
named tree and the requested root belongs to one of that tree's retained
accepted updates. Possession of a root is not authorization. Unauthorized,
unknown, wrong-tree, and no-longer-retained roots all return the same `404`
response, and no route enumerates historical roots or their accepted-update
metadata.

Snapshot responses carry
`Vary: Authorization, Arbor-Access-Link`. A response to a request carrying
neither header for a tree currently readable by `everyone` uses
`Cache-Control: public, max-age=31536000, immutable`; a response to a request
carrying either header uses
`Cache-Control: private, max-age=31536000, immutable`. A client may retain a
verified response indefinitely. A host need only answer a future origin
fetch while that accepted root remains retained.

Changing the current root or ACL does not change an already returned snapshot.
Revocation prevents a new authorized origin fetch but cannot retract bytes a
client or cache already received. In particular, a publicly cached accepted
root can remain publicly available after the tree ceases to grant public
access. Removing content from the current tree is therefore not erasure from
retained accepted snapshots or caches.

A file object is its exact file bytes, with no CBOR wrapper. Its object hash
is `sha256(fileBytes)`. Only directory objects are encoded as canonical CBOR.
Kind comes from the referencing directory entry; receivers MUST NOT sniff or
decode file bytes to infer kind. A file may contain bytes that are also a
valid directory encoding without being interpreted as a directory.

```ts
type WireDirectoryEntry =
  | { name: Name; file: Hash }
  | { name: Name; directory: Hash }
  | { name: Name; tree: TreeID };

type WireDirectory = {
  type: "directory";
  entries: WireDirectoryEntry[];
  childrenSource?: CollectionFileDescriptor;
};

type CollectionFileDescriptor = {
  version: 1;
  type: "collection-file";
  format: "csv" | "json" | "jsonl";
  source: "_store.csv" | "_store.json" | "_store.jsonl";
  schemaSource: "schema.ts";
  schemaFingerprint: Hash;
  childSetHash: Hash;
};
```

A directory entry either addresses another Overstory object by hash or marks a
nested Overstory tree boundary by TreeID. A snapshot walk stops at such a boundary:
the nested tree has its own roots, history, and access. `childrenSource`, when
present, records how authored collection files supply the directory's logical
children; its projection and validation rules are defined by
[child backings §2.1](06-child-backings.md#21-accepted-overstory-representation).

An `ObjectEnvelope` is JSON transport packaging for the same canonical object
bytes when another operation, such as an update request, carries objects inside
JSON. Its `hash` is the SHA-256 hash derived from its decoded `bytes`:

```ts
type ObjectEnvelope = { hash: Hash; bytes: string };
```

Section 4.1 defines the common encoding and hash rules.

#### 1.1.2a Reading entry metadata

```text
GET /.arbor/trees/{TreeID}/entry-metadata
```

Descriptive metadata about the file entries of the tree's current accepted
root. It is never part of any object or hash: identical content hashes
identically whenever and wherever it was written, and metadata can change
without changing a root.

```ts
type EntryMetadataResponse = {
  update: UpdateId; // the accepted update the entries describe
  entries: Record<EntryPath, { modifiedAt?: number }>; // "/Trips/_index.md" → Unix ms
};
```

Keys are directory-entry paths of files, not logical page paths; a client maps
a page to its body entry. `modifiedAt` is the `acceptedAt` of the accepted
update that last wrote that entry's object at that path, so a move is a change
at its new path. A host MAY omit entries it cannot date. Clients ignore unknown
fields inside an entry; later descriptive fields are added there. Read access is
the same as for the snapshot read. The response is not immutable: it describes
`update`, which a client may compare with the snapshot it installed and let the
watch correct.

#### 1.1.3 Watching

```text
GET /.arbor/trees/{TreeID}/watch?after={cursor}
```

The request carries `Accept: text/event-stream` and may carry
`Last-Event-ID: {cursor}`. `after` and `Last-Event-ID` are equivalent.
Servers may emit an explicit `from` spanning intermediate accepted updates
without client negotiation. Adjacent transitions remain valid.

Successful state-change frames are `tree.update` events. Each represents one
or more accepted updates; derived hosting and device status does not appear on
this portable tree stream. `resync-required` is the terminal control event
described below.

```ts
type TreeUpdateEvent = {
  cursor: EventCursor;
  tree: TreeID;
  kind: "tree.update";
  change: {
    descriptor: RemoteTreeDescriptor;
    transitions: AcceptedTransition[];
  };
};

type AcceptedTransition = TransitionPayload & {
  update: AcceptedUpdate;
  from?: { id: string; root: Hash };
  requestDigest?: Hash;
};

type TransitionPayload = {
  objects: ObjectEnvelope[];
  deltas: ObjectDelta[];
};

type ObjectDelta = {
  base: Hash;
  result: Hash;
  instructions: Array<
    | { copy: { offset: number; length: number } }
    | { insert: string }
  >;
};

type AcceptedUpdate = {
  id: string;
  tree: TreeID;
  root: Hash;
  previous: { id: string; root: Hash } | null;
  acceptedAt: number;
  subject: string | null;
  conflicted: boolean;
};
```

The two arrays are alternative transfer encodings for the result objects
needed to construct the candidate graph:

- `objects` carries a result object's complete canonical bytes.
- `deltas` carries instructions that reconstruct a result object's complete
  canonical bytes from an available base object.

For example, a transition that changes a large file and its parent directory
may carry the file as a compact delta and the smaller directory as a complete
object. After verification, both results are ordinary content-addressed
objects; how they travelled has no effect on the candidate tree.

Both arrays are required and either may be empty. Every supplied result hash
appears exactly once across them. A transition that needs no new objects is
`{ objects: [], deltas: [] }`.

An `ObjectDelta` names an available object as `base` and the object it will
produce as `result`. Its ordered instructions build the result's complete
canonical bytes: `copy` reuses a byte range from the base, while `insert`
supplies new bytes as canonical padded base64. The receiver applies the
instructions and requires the produced bytes to hash to `result`.

Accepted update IDs are opaque identities, not observation cursors. The `previous`
link establishes accepted order within a tree; it is null only for activation.
It names both predecessor identity and projected root. A same-root semantic update
therefore advances the identity chain even when no new object bytes are required.
Rule execution, automatic resolution and restoration are provenance, not mutually
exclusive accepted-update kinds. Rule evidence is retained under the semantic
requirements in [source intent §7](10-source-intent.md#7-format-aware-merge-rules-and-explicit-automatic-resolution).

The transition may carry complete `objects`, [deltas](#25-sparse-transfer-with-object-deltas),
or both. Its transport basis is `from` when present, otherwise `update.previous`.
`from` names a retained accepted identity and root in the same tree, preceding
`update` in accepted order. It permits one net transition across several accepted
updates. `update.previous` always remains the actual historical predecessor;
coalescing delivery does not rewrite accepted history.

`transitions` is nonempty and ordered. The first transport basis must match the
client's confirmed accepted identity and root; each later transport basis must
match the preceding transition's identity and root. Update IDs must be distinct,
all tree IDs must match, and the final pair must match `change.descriptor.update`
and its `root`. A mismatched basis requires resynchronization, not a successful
root-only check. The payload must suffice to reconstruct the destination graph
from its transport basis without fetching or applying intermediate transitions.

On reconnect, authorities should normally coalesce a retained backlog into one
net transition to the captured current accepted state. Intermediate updates,
including same-root updates, need not be delivered individually. The destination
still carries its exact accepted identity and unresolved-state signal, even when
its root equals the starting root. Clients may materialize the final state once
and durably advance accepted metadata and the observation cursor together.

The SSE `cursor` identifies the observation batch. It advances strictly in the
observation domain and is the frame's observation boundary; it need not equal any
accepted ID. The enclosed descriptor identifies the final accepted state. One frame can contain several accepted updates.
Implementations may happen to encode some IDs and cursors identically, but clients
MUST NOT derive one from the other or compare their numeric/string values as accepted
ordering. Replayed frames are deduplicated by observation cursor before applying the
transport chain. An overlapping replay must not apply old transitions to a newer head.

For `tree.update`, a transition's `requestDigest` is present only when the stream is authenticated by the exact bearer credential that submitted that accepted request. This allows watchers to identify the revision that includes an update they sent.
A digest on a net transition identifies the request for its destination accepted
update, not every request accepted within the span. An absent or different digest
therefore does not prove that a pending request was excluded. Clients preserve
unconfirmed requests and use the ordinary exact-retry/receipt procedure to settle
them; advancing a watch cursor alone never acknowledges those requests.

When retained context cannot support either net catch-up or ordinary replay,
for example because the event cursor or its basis graph is no longer retained,
the server produces one terminal
`resync-required` event and closes. The client reads a new current descriptor,
obtains its addressed snapshot, and resumes strictly after the descriptor's
`observedThrough` cursor. This catch-up path does not acknowledge or discard
unconfirmed local edits: clients retain and reconcile them through the ordinary
update/retry path. Retained accepted history need not be deleted merely because
a watch uses snapshot catch-up.

#### Accepted unresolved state

`AcceptedUpdate.conflicted` and `RemoteTreeDescriptor.conflicted` signal that
an accepted state retains unresolved alternatives. The field is required; a descriptor and its accepted update MUST agree. This state is distinct
from a rejected update's structured `409 conflict` response. The selected `root`
remains an ordinary valid directory graph with no conflict markers or special
entries. An accepted change to unresolved state MUST receive a new update id
and cursor even when the predecessor root equals `root`; its transition may be empty.
Clients MUST durably advance accepted metadata in that case.

Ordinary updates are based on the exact accepted update, not only its projected
root. Leaving a conflicted region's projected bytes unchanged MUST NOT resolve
or discard its alternatives. Authorities MUST preserve unresolved state when admitting ordinary changes.
Representable ambiguity is accepted under the reconciliation contract; invalid
claims, failed guards and exceeded limits remain explicit failures. Clients without conflict-review support may
continue ordinary synchronization and MUST indicate unresolved state rather
than reporting the tree as conflict-free.

[Source intent and provenance](10-source-intent.md) defines operation identities,
alternative edits, format-aware explicit automatic resolution, and continued
editing of accepted decisions on the ordinary update route. The
[client synchronization contract](09-client-synchronization.md#5-accepted-conflicts-and-held-local-work)
requires safe independent work to continue around held changes without rewriting
an immutable request or changing sequential prefix semantics.
These semantics require no extension negotiation or parallel API version.
Unknown optional response fields remain ignorable; unknown mutation semantics
must be rejected before accepting any part of their request.

### 1.2 Other ways to read trees

#### 1.2.1 Reading an object at a time

Clients that do not retain a whole tree can use this endpoint to fetch files
and directories on demand.

```text
GET /.arbor/trees/{TreeID}/objects/{hash}
```

This route returns the same object bytes carried in a snapshot bundle
or `ObjectEnvelope`, but directly as the response body. The hash is present in
the URL and repeated as the quoted ETag. The response uses `application/octet-stream`,
must hash to the requested value, and uses the same access-sensitive `Vary` and
`Cache-Control` policy as an accepted snapshot.

A new origin fetch is authorized by read access to the named tree. Objects are
content-addressed and shared across a host, so the route does not prove that
the hash is reachable from that tree: any retained object whose hash the caller
knows is returned, and an unknown hash or an unreadable tree is `404`. Knowing a
hash is therefore treated as knowing its content; this route is a per-host
existence oracle gated by any tree read, and a host that must not confirm
content across trees needs a stricter deployment policy. Root hashes of
unreadable trees are never disclosed by any read, and a tree-boundary entry
carries only the nested TreeID.
A client may use it to refetch one missing or corrupt object of a
retained root instead of downloading a complete snapshot. Because objects are immutable and addressed by their bytes,
successful responses can be cached and reused after verification.

#### 1.2.2 Material references and selectors

```ts
type Material =
  | { kind: "basis"; path: string; object: Hash }
  | { kind: "operation"; change: string; operation: string }
  | { kind: "alternative"; state: string; conflict: string; alternative: string };

type Ref = {
  material: Material;
  within?: string[];
  range?: [number, number];
};
type EntryDestination = { parent: Ref; name: string };
```

Change, operation, conflict and alternative keys are 1–128 ASCII letters, digits,
underscores or hyphens.

All references are scoped to the addressed TreeID and remain subject to current
authorization. On reads, `basis` names the exact object at a logical path in the
requested accepted state. On writes, it names that object in the element's authored
basis. For the first element this is the accepted state at request `base`;
for later elements it is the preceding submitted candidate together with its authored
semantic effects, not merely its root hash. Paths are NFC, absolute and at most
4096 UTF-8 bytes; `/` is permitted to reference the tree root or a destination parent.
Other paths have no trailing slash, empty/dot components, backslashes or NUL.
Root material cannot itself be moved, removed or replaced as an entry.

`operation` names a retained material result. On writes, it may also name the result
of an earlier operation in this change or submitted prefix. Forward references, cycles and references to an
operation with no material result are invalid. An operation result is not a backend
graph ID and does not inherently create a new origin. The host retains its
immutable binding and the provenance needed to transport selections through later
changes. Missing history requires an explicit failure, never fuzzy text matching.

`alternative` names material in an exact retained accepted `state`. State IDs are
opaque, nonempty strings of at most 1024 UTF-8 bytes. Conflict and alternative IDs
come from the host. The state identifies the reviewed alternative revision;
bytes, display order and current paths cannot substitute for identity.

Omitting selectors means the complete material. A nonempty `within` array selects
a descendant of directory material using names at the identified basis/result/state,
not current path lookup. Components obey the path-name rules, have a combined
slash-joined length of at most 4096 UTF-8 bytes, and number at most 256. A `range`
then selects text in that material or descendant: two nonnegative safe integers
(`<= 2^53 - 1`) defining a half-open UTF-8 byte range on scalar boundaries. A
zero-width range is an insertion point. No range means the entire selected text
for source operations and the entire selected entry for entry operations. Applying
text ranges to binary or directory material is invalid. Entry references cannot
have ranges. Logical boundaries never grant access to another TreeID's interior.

The host resolves the identified selection before transporting its identity
through changes; it MUST NOT retarget by matching current names or bytes. For an
entry destination, `parent` identifies a directory and `name` is one NFC component.
The authored destination slot, including its observed occupant or absence, is part
of the basis. Concurrent moves or occupants are reconciled rather than overwritten.
Text insertion uses `at: Ref` and `side: "before" | "after"` at the selected edges.

Editors open ordinary source with its accepted update and file hash. They need no
per-character identity map or provenance graph. Format-aware analysis may map blocks,
keys or symbols to exact source; it does not introduce a separate identity namespace.

#### 1.2.3 Reading conflicts

`GET /.arbor/trees/{tree}/conflicts?state={acceptedUpdate}` lists decisions in an
exact retained accepted state. Optional `after` continues an opaque page token;
optional `conflict` selects one decision. Each query field occurs at most once;
`state` is required, nonempty and exact. `after` and `conflict` are mutually exclusive.
The host authorizes every read, including continuation pages. Unknown or
unauthorized trees, unavailable states and unknown selected decisions return `404`;
malformed or mismatched page tokens return `400`. A page token is bound to tree,
accepted state and traversal position, never an authorization grant.

```ts
type DecisionPage = {
  tree: TreeID; state: string; root: Hash; conflicted: boolean;
  decisions: Decision[];
  next: string | null;
};
type Decision = {
  id: string;
  kind: string;
  affected: Ref[];
  selected: string;
  alternatives: Array<{
    id: string; revision: string;
    value: { text: string } | { file: Hash } | { directory: Hash }
         | { tree: TreeID } | { absent: true };
    placement?: EntryDestination;
    contributions: Array<{ change: string; operation: string | null }>;
  }>;
  dependencies: string[];
  actions: string[];
};
```

There is no fixed protocol cap on decisions, alternatives, dependencies,
contributions or aggregate inspection text. In particular, accepting the 33rd
unresolved decision is not an error. Page size is a transfer choice, never a limit
on accepted conflict state. Documented storage/resource constraints remain honest
implementation failures; a full response or absent automatic merge rule must not
be misreported as a resolved tree or an unsupported decision count.

`tree`, `state` and `root` must match the requested accepted context on every page.
`conflicted` describes the entire state, not just the current page. `next: null`
ends the traversal. A complete traversal yields each decision once in stable order,
with no omission or duplication. Pages remain at their original accepted state even
if current advances. A nonterminal page must make progress and return a different
continuation token; unavailable retained evidence requires explicit failure. A
resolved state has no decisions and no continuation. A filtered read returns the
one requested complete decision, with `next: null`; it does not claim to enumerate
all tree decisions. Clients cannot infer resolution from an empty partial result.

Each decision record contains its complete alternative and dependency sets; it is
not split into partial choices. Dependencies may name decisions on other pages.
The client may fetch those by `conflict` at the same state. Not appearing on this
page does not mean a dependency is missing or resolved. Before preparing a joint
resolution the client obtains the evidence required for the affected dependency
closure. Unrelated sync requires neither a complete traversal nor that closure.
The host still validates all guards and combinations at acceptance.

`affected` uses the same material references as updates. A `basis` reference is
interpreted at the page's `state`. Absence decisions can address a destination parent
or retained material rather than inventing a nonexistent file path. Whole-entry,
placement and text selections therefore share the same identity vocabulary.
An alternative is addressed in a mutation by an `alternative` material reference
using this page's state and its decision/alternative IDs. Its value supplies exact
text or the existing explicitly typed entry representation; `absent` represents
nonexistence. `placement`, when present, identifies the proposed parent and name
for an entry value, not a second independent copy. It is invalid for text or absence.

Decision and alternative IDs are stable across continuation. Revisions change when
value, placement, contributions or other meaningful alternative evidence changes;
earlier revisions remain associated with retained accepted states. Equal bytes do
not collapse alternatives. Contributions identify authored input rather than a full
transitive history download. Null `operation` explicitly denotes a snapshot input.
Selected identity must name an alternative. The host retains and verifies its
correspondence to the ordinary projection; clients validate exact source and placement
before attaching actionable controls. A text value must match the selected projected
UTF-8 range. A directory/file kind is never guessed from bytes. Unknown decision
kinds or actions may be displayed as unavailable, but cannot authorize invented
mutation behavior. Core read fields may be extended without changing their meaning.

Entry-valued alternatives are read through the ordinary
[object route](#121-reading-an-object-at-a-time) by the hashes the decision page
discloses; the host retains them for as long as the state is retained.
Inline text requires no extra read.

Known review actions remain `editAlternative` and `resolveConflict`: capability
labels rather than mutation opcodes. They produce ordinary operations and resolution
declarations. Requests remain subject to current authorization and guarded evidence.
Optional offline inspection caching does not grant current-state authority.

IDs and references use [§1.2.2](#122-material-references-and-selectors) syntax. Decisions, alternatives, dependencies, actions and
contributions must be unique within their stated scopes; dependencies cannot refer to
self but cycles between decisions are permitted. Empty alternative sets, invalid
selected IDs, malformed references and invalid values fail decoding. Open decisions
have at least two alternatives. Responses are private and must not be stored by shared
HTTP caches. The [target read vectors](conformance/protocol-accepted-state.json) bind
paired TypeScript and Swift models; they do not assert server execution.

## 2. Updates and writes

Every update, exact-state guard, retry receipt, object read, and watch is subject
to [current resource authority](05-access-control.md#3-tree-scoped-authorization).
Narrow executable authority must be checked over actual effects; it never implies
whole-tree read or bypasses governed account policy.

### 2.1 The update request

```text
POST /.arbor/trees/{TreeID}/updates
```

The client submits a nonempty, ordered string of candidate updates against the
last accepted watchpoint it has confirmed:

```ts
type UpdateRequest = {
  base: string | null;
  updates: CandidateUpdate[];
};

type CandidateUpdate = TransitionPayload & {
  change: string;
  trace: Frame[] | null;
  candidate: Hash;
  resolves: ResolutionDeclaration[];
  ifCurrent?: string;
};
```

`change` is a durable authored-change identity; `trace: null` explicitly
selects snapshot semantics. A trace is a chain of tree-root to tree-root frames
that fully explains the candidate using [source operations](10-source-intent.md);
every frame must reproduce its own result. An empty trace is valid only for an
explicit resolution with no content edits. A trace carries at most 64 frames
and 1024 operations. A trace is evidence the host checks in full, never a
hint it may skip. There is no capability-discovery endpoint or negotiation
mechanism: a request the host does not support fails closed with no
translation and no alternate route.
`resolves` declares guarded decisions endorsed by this candidate; empty means none.
These fields are required, included
in request identity, and preserved verbatim in an adopted or retried prefix.
There is no residual payload or implicit downgrade to snapshot semantics.

`base` is the id of the accepted update and `tree.update` watchpoint from which
the string begins, or `null` when its first element activates a reserved tree.
Each element proposes one distinct accepted-history boundary. The first is
authored on the root at `base`; every later element is authored on the preceding
element's submitted `candidate` together with its authored semantic effects, whether
or not that candidate has received a host response. Root equality never
collapses the semantic basis of two elements.

Each element is a client-chosen accepted-history boundary. Nothing requires
one element per editor transaction: a client normally coalesces an interaction
burst into one element before preparing its request, and the
[client synchronization](09-client-synchronization.md) machine keeps one
ordinary request in flight. A client may nevertheless submit progressively
longer strings without waiting for an earlier POST or the watch stream; the
authority must accept them because they are the recovery path once a request
has become ambiguous. For example, these requests may be in flight at the
same time:

```json
{
  "base": "248",
  "updates": [
    {
      "change": "change-one",
      "trace": null,
      "candidate": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "resolves": [],
      "objects": [],
      "deltas": []
    }
  ]
}
```

```json
{
  "base": "248",
  "updates": [
    {
      "change": "change-one",
      "trace": null,
      "candidate": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "resolves": [],
      "objects": [],
      "deltas": []
    },
    {
      "change": "change-two",
      "trace": null,
      "candidate": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "resolves": [],
      "objects": [],
      "deltas": []
    }
  ]
}
```

Within one client epoch, every later request must preserve the exact semantic
earlier elements and only append. The transport representation of an element's
objects and deltas may change without changing its identity. A client must not
rewrite an element's change ID, trace, candidate, resolution declarations, or precondition, or fork two different
successors from one prefix. It starts a new epoch only after the previous
speculative string has been completely acknowledged and its resulting accepted
transition has been durably applied, using that watchpoint as the new `base`.

The host derives a credential-scoped request digest for each element. For
the first element the digest basis is the accepted update id in `base`. For
each later element it is `{ requestDigest, candidate }` from the preceding
element. Consequently every digest commits to the complete prefix, and the
same prefix has the same identities in every longer request.

The host serializes update strings per tree. Before processing new work,
it finds the longest supplied prefix already represented by successful
credential-scoped request digests in accepted history and trims that prefix.
If the longer request arrives first it may apply every element; if a shorter
request arrives first the longer request resumes after it; an old shorter
request arriving last changes nothing. A previously returned `unchanged` element
need not have its own durable resolution record: a later accepted element
proves its prefix was processed, while an otherwise unresolved `unchanged`
element may be evaluated again without creating accepted history.

For each untrimmed element, the logical base root is the preceding submitted
candidate, not the preceding accepted or merged root. Thus, if `B` to `C1` is
merged into `M1`, the next element is reconciled as `(base: C1, candidate: C2,
current: M1)`. Only the incremental `C1` to `C2` change is applied to the
merged state. Each successful state-changing element is committed and emitted
on watch separately. A rejection stops the string at that element; its
successful prefix remains accepted and later elements are not attempted. An accepted
unresolved decision is a successful result and does not stop the remaining string.

Each `candidate` names the exact Overstory root encoding the desired complete tree
state. The host decodes and validates its modeled state and all
projection-specific fidelity required by that encoding. Each element may omit
objects available from the preceding graph, but the complete request must be
self-contained from its retained accepted `base` plus its `objects` and valid
`deltas`. The host may reconstruct an already-applied prefix from the
repeated request instead of retaining its submitted candidate graph. The
[delta rules](#25-sparse-transfer-with-object-deltas) define interchangeable
transfer representations; they do not change a candidate's identity.

### 2.2 Reconciliation and exact-state preconditions

Ordinary updates reconcile authored contributions with current accepted state.
Independent effects combine; format-aware rules may resolve differences; remaining
representable ambiguity is accepted as explicit decisions. There is no `ifMatch`,
`onConflict` or resolved-only submission mode. Bytes/model hashes still define
representation and model equality, but do not substitute for accepted state identity.

An optional `ifCurrent` names the exact accepted update ID required immediately
before this element is processed. A mismatch rejects that element with `409 conflict`
without accepting its effects; the completed prefix is retained. Same-root metadata
advancement also fails the guard. Exact successful replay is recognized before
rechecking this precondition, so retry returns the original result. The guard is
per element, not a transaction around the entire request. Callers generally cannot
predict new accepted IDs for later elements and should not invent them.

Tree activation uses `base: null` and the existing reservation/authorization rules;
its first element has no `ifCurrent` or resolution declarations because no accepted
state exists yet. Semantic reference, resolution and model constraints always apply,
with or without an exact-state precondition. A complete property-map replacement
still preserves applicable identity declarations and leaves unrelated content alone.

### 2.3 Accepting and merging

Acceptance is decided from authored effects and accepted semantic state, not solely
from the candidate and current root hashes. Semantic state includes contributions,
origin bindings, unresolved alternatives and explicit resolutions as well as the
projected file graph. Apply the following procedure to each element after exact
replay handling in §2.1:

1. Reconstruct the candidate and validate its authored effects against its logical
   basis. For an operation-bearing update, execution must reproduce the candidate
   projection while preserving all declared semantic effects, including those not
   visible in that projection. For a snapshot, derive only the effects justified by
   the exact observed projection. Validate authorization, references and explicit
   guards before treating the submission as a no-op.
2. Enforce the optional exact-state precondition in §2.2. Combine independent
   contributions and apply
   applicable format-aware rules. If valid competing effects cannot be uniquely
   combined, retain them as unresolved decisions within the representation limits
   of [source intent §6–7](10-source-intent.md#6-accepted-decisions-and-continued-editing).
   Missing automatic merge rules alone do not require rejection. Ordinary operations
   and snapshots preserve existing decisions; only guarded explicit resolution
   closes them.
3. Compare the resulting semantic state with current. Return `unchanged` without a
   new accepted update only if there is no new contribution, origin binding,
   alternative continuation, resolution or projected change to record. A snapshot
   with no authored change can qualify. Equal candidate/current roots, equal
   candidate/base roots, or equal alternative bytes do not establish a semantic
   no-op. An independent deletion contribution, hidden-alternative edit or resolution
   choosing the existing projection can require a new update with the same root.
4. Otherwise commit the resulting semantic state and projection atomically. Return
   `accepted` whether or not reconciliation was needed. The resulting state may have
   `conflicted: true`; acceptance does not imply resolution. Assign a new accepted
   update ID and advance observation even if the root is unchanged. Continue processing the remaining elements against their respective
   authored bases, carrying accepted provenance and decisions through the sequence.
5. If a required match/guard fails or the effects cannot be validly retained within
   the contract, reject with the applicable structured error. A reconciliation
   rejection uses `409 conflict`, with current state, reasons and the draft
   transition. Preserve the successful prefix and leave later elements unattempted.
   Never substitute a rejected local draft for accepted alternatives.

Format-aware rules may produce a clean merge or explicitly resolve guarded decisions
under [source intent §7](10-source-intent.md#7-format-aware-merge-rules-and-explicit-automatic-resolution).
They must honor the applicable model constraints, including
[collection-file rules](06-child-backings.md#23-accepted-update-validation-and-merge).
The host retains unresolved choices when no rule justifies resolution. Concrete
reference-implementation rule names and rollout limitations belong in implementation
documentation and status.

### 2.4 Results, conflicts, and retry

A successful response is always plural and contains one result for every
element, including any element trimmed as an exact replay:

```ts
type UpdateResponse = {
  results: UpdateResult[];
  observedThrough: EventCursor;
};

type UpdateResult = {
  outcome: "unchanged" | "accepted";
  update: AcceptedUpdate;
  requestDigest: Hash;
  reconciliation?: TransitionPayload;
};
```

`results` is nonempty and preserves request order. HTTP status is `201` if at
least one result is `accepted`, including replay of a previously accepted result;
otherwise it is `200`. `unchanged` means no semantic transition was committed for
that element. `accepted` includes direct application, reconciliation, restoration
and metadata-only changes. How a result was produced is recorded as provenance,
not duplicated in an outcome enum or accepted-state kind.

`update` is the accepted state standing after that element: existing state for
`unchanged`, or the newly accepted state for `accepted`. `observedThrough` is the
observation boundary after the whole string was processed; it is not each result's
update ID and must not be used as a per-element accepted-state guard. Exact replay
returns the original per-element receipt even if current has since advanced; the
response observation boundary must not be taken as proof that its last historical
receipt is the current head. Observe subsequent updates or refresh the descriptor.

`reconciliation` is present exactly when the accepted root differs from the
submitted candidate: it is the transition from the candidate root to
`update.root` under the [deltas](#25-sparse-transfer-with-object-deltas) rules, so
a superseded, merged, or replayed result is applied with the same code that
applies a watch frame. A result whose projected root equals the candidate returns none, including
metadata-only acceptance. Its accepted identity still must be applied.

A rejected reconciliation uses the shared `ArborError` envelope with
`details.kind: "server-update" | "account-configuration"`. Its details include
`completed`, the ordered successful prefix results; `failedIndex`; the current
`AcceptedUpdate`; the logical base and candidate roots; structured conflict
reasons naming each conflicting node; and `draft`, the transition from the
candidate root to the draft root the client keeps.

A direct client treats `failedIndex` as a sequencing boundary. It reviews only
that failed element; later elements have not conflicted because the host
has not examined them. After the reviewed result is accepted, the client
replays each retained suffix change in order against the resulting accepted
state. Replay preserves the original change between adjacent submitted
candidates. It does not reuse an old complete candidate under a new logical
base or collapse the suffix into one root. A guarded replay that cannot be
applied exactly becomes a new client-owned conflict before submission.

Semantic request identity is the SHA-256 of the
[canonical CBOR encoding](#41-cbor-and-hashes)
of `{ domain: "arbor-update/2", tree, base, change, trace, candidate, resolves, ifCurrent }`,
with absent `ifCurrent` encoded as CBOR null. The digest covers the whole trace,
including each frame's `before` and `after`, so the same operations divided into
different frames are a different change. Ordered arrays retain their submitted
order, including resolution declarations and reviewed alternative IDs. Identity is
scoped to the authenticated credential.
For the first element, `base` is the request's accepted update id or `null`.
For each later element, `base` is
`{ requestDigest: previousDigest, candidate: previousCandidate }`. This latter
object is part of semantic identity but is implicit in the ordered JSON request.
`objects`, `deltas`, and their ordering are
transport choices and are excluded. An ambiguous retry may therefore replace a
delta with complete bytes without changing identity. Exact accepted
elements replay their original results and create no duplicate accepted update.
An `unchanged` element may be evaluated again. Clients durably retain their epoch
base, ordered elements, required content, successful-prefix boundary, and any
conflict draft until the reviewed element and every retained suffix change have
been applied.

A conflict and every other error use the shared envelope:

```ts
type ArborError<TDetails = unknown> = {
  error: string;
  message: string;
  retryable: boolean;
  tree?: TreeID;
  path?: LogicalPath;
  details?: TDetails;
};
```

Three tokens that serve different purposes are often encountered together:

- An accepted-update `id` identifies one durable accepted transition of one tree.
  Its predecessor link gives accepted order; an observation cursor identifies stream
  progress and may cover several transitions.
- A client-authored `change` identifies an immutable authored change; operation
  material results are named by that change and their operation keys, without an
  independently named output. A moved result retains existing origins.
- A credential-scoped `requestDigest` identifies one canonical update
  semantic request across retries and different object/delta packaging.

### 2.5 Sparse transfer with object deltas

A transition transfers the content-addressed graph sparsely. Each changed
object travels either as its complete canonical bytes or as a delta against an
object reachable in the relevant basis graph:

| Representation | Update submission | Accepted transition | Intended use |
|---|---|---|---|
| `ObjectEnvelope` | Yes | Yes | New objects, or whenever complete canonical bytes are smallest |
| `ObjectDelta` | Yes | Yes | Any changed file or directory whose predecessor shares most of its bytes |

An `ObjectDelta` concatenates ordered instructions into the complete canonical
bytes of the `result` object. `copy` addresses the exact canonical bytes of the
`base` object and `insert` is canonical padded base64. Copy ranges are
nonempty, nonnegative safe JSON integers wholly within the base bytes; inserts
and the instruction list are nonempty. Because instructions address encoded
bytes rather than a decoded payload, one rule covers every object kind: a
one-entry change to a large directory or a one-paragraph change to a large file
can use a few instructions, and a moved region is a copy rather than a
retransmission.

A file delta addresses file bytes directly: editor replacements copy unchanged
ranges at their original byte offsets and insert replacement bytes. Any instruction sequence that
reconstructs the exact result is valid; the diff algorithm is the sender's
choice and never part of identity.

The base must be reachable in the relevant basis graph: the request's retained
accepted watchpoint for its first element, the preceding candidate graph for a
later element, or the transport basis root (`from.root` when present, otherwise
`update.previous.root`) for a watch transition. The
receiver hash-verifies that base, applies the instructions, requires the
reconstructed bytes to hash to `result`, and decodes them as a valid canonical
object. It then treats the result exactly like a complete object. A result
appears exactly once across complete objects and deltas. New objects use
complete bytes; otherwise the sender normally chooses the smaller form. The
encoding is a transport choice: the identified result object and accepted
roots remain canonical, and retries or later storage packing may choose
another transfer representation without changing semantic identity. Duplicate
results, a result also supplied as a complete object, noncanonical base64,
out-of-bounds copies, arithmetic overflow, and quota excess are invalid.

## 3. Editor round trip

> **Learning tip:** Make authored work durable locally before network
> submission. The update response and its watch event may race; both must be
> idempotent, and editor history remains distinct from accepted tree
> transitions.

### 3.1 One complete round trip

This non-normative example shows how the preceding operations compose for a
working tree: the node index, local overlay, and object store an editor edits
directly. The normative client behavior is the update machine in
[working-tree updates](09-client-synchronization.md).

0. The working tree is installed from an accepted snapshot. On a device that
   shares an installation with the folder's daemon it installs a **sparse
   spine** (directories and Markdown inline, other files by hash and lazily
   fetched from the loopback object route) rooted at the host's accepted
   root; the daemon's pending request is never adopted. Elsewhere it
   installs from the host. Either way it records the confirmed
   `{ root, update, cursor }` watchpoint.
1. Each authored generation is appended to the working tree's change log
   and becomes locally durable at once (the editor is a source of local
   changes); unsent changes are published together so that one request
   represents one intentional accepted-history boundary.
2. After a short trailing delay it persists one exact request from the
   confirmed update to its latest durable head: a complete candidate graph
   omitting unchanged objects, using an `ObjectDelta` where that is smaller
   than the complete changed object. The request is durable before its first
   network attempt and is never rewritten afterwards.
3. It transmits that one request. Local work that arrives while it is in
   flight is retained as a single successor head; the client does not post a
   longer string merely because another edit arrived.
4. The response and the corresponding `tree.update` event may arrive in either
   order. The client correlates them by the private per-element
   `requestDigest` and by the accepted update, applies whichever arrives
   first, and ignores the other.
5. After validating and durably materializing the accepted result it advances
   the watchpoint and, if a successor head exists, publishes it as a new
   request against the new watchpoint without waiting.
6. If the request's outcome is unknown when transport returns, the client
   retries it exactly. If newer durable heads exist behind an ambiguous
   request, it issues one longer string that repeats the transmitted prefix
   exactly and appends the latest head once; the host trims the accepted
   prefix. This is the only use of a longer overlapping request.
7. A working tree at its accepted base applies a contiguous transition batch
   in memory and durably materializes only its final state, fetching any
   object it does not hold through its object store. A working tree with
   local changes submits its own candidate. Missing history or any failed
   check falls back to a coherent snapshot.

A watch event acknowledges candidate intent, not submitted delta bytes: a
merge may produce a different accepted representation. If an element is
rejected, the client retains the complete conflict durably, allows further
local work, and exits that rejected sequence only through explicit review and
resubmission at the verified current base. Proven independent work may proceed
under the client synchronization contract while the original sequence stays held.
Rejected conflicts never appear on watch.

## 4. Encoding details

### 4.1 CBOR and hashes

Whenever Overstory hashes a structured value, it first encodes that value as
canonical CBOR and then hashes those bytes with SHA-256. The section that
defines a particular hash defines the value being encoded; this subsection
defines the common structured-value encoding.

The permitted CBOR subset is: `null`; booleans; integers in the safe 53-bit
range as CBOR integers with minimal-length heads; every other finite number as
a 64-bit float; UTF-8 text; byte strings; arrays; and maps whose keys are text,
unique, and ordered by the bytes of their encoded form. Non-finite numbers,
indefinite lengths, tags, and non-text keys are invalid.

For an Overstory object, the envelope is constructed as follows:

```text
objectBytes = fileBytes OR canonicalCBOR(directory)
envelope = {
  hash: sha256(objectBytes),
  bytes: paddedBase64(objectBytes)
}
```

To validate an envelope, the receiver decodes `bytes` as canonical padded
base64 and requires the SHA-256 of the resulting bytes to equal `hash`.
Graph validation separately interprets directory objects according to their
references and requires their canonical encoding. The envelope is not itself hashed and is not a node in the object graph;
it only carries an addressed object's hash and bytes through a JSON response or
transition payload.

Model hashes, collection-file `childSetHash` values, update and mutation
request digests, and query output hashes apply the same CBOR-then-SHA-256
procedure to the distinct structured values defined by their own contracts.
They are not hashes of an Overstory object unless their contract says so, and
nothing in Overstory is identified by canonical JSON text.

When the value being identified is already an exact byte sequence, Overstory
hashes those bytes directly instead. In particular, `schemaFingerprint` is
the SHA-256 of the exact UTF-8 bytes of `schema.ts`, and therefore equals
that file's object hash. The
[`canonical-cbor-values`](conformance/canonical-cbor-values.json) vectors
freeze valid encodings and rejected byte sequences for every language binding.

### 4.2 Stream framing and errors

Tree watch and query result streams use one UTF-8 SSE framing rule: blank lines
separate frames, multiple `data:` lines join with newlines, and clients ignore
comments and keepalives. The `event` field names the typed event and `data` is
one canonical JSON value. Producers share escaping, cancellation,
bounded-buffer, and terminal-close behavior.

```ts
type ObservationEvent<TKind extends string, TChange> = {
  cursor: EventCursor;
  tree: TreeID;
  kind: TKind;
  change: TChange;
};
```

This shared transport does not imply shared cursor semantics. A tree watch sets
a replayable `id`, carries the complete `ObservationEvent`, and supports
`Last-Event-ID`, retained history, and `resync-required`. A query stream omits
`id`, sends the remaining event members after `type`, and establishes fresh
derived state with `ready`; reconnection repeats the complete query.

The shared error envelope and common codes are normative. Narrow server-only
codes include `already-claimed`. Base/update mismatch,
reserved boundaries, policy failures, and merge conflicts use `conflict` with
discriminated `server-update` or `account-configuration` details where
applicable.

### 4.3 Other constraints

Names reject NUL, slashes, backslashes, dot segments, non-NFC text, and
reserved ambiguity. Directory entries are canonically ordered.
