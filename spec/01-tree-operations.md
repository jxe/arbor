# Tree reads, writes, watching, and editor round trips
*Part of the [Arbor spec](../spec.md): the logical tree model and the operations that read, change, observe, and faithfully materialize copies.*

## The Arbor data model

### Trees and identity

Arbor is conceptually a global hash table of trees:

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

type Arbor = Map<TreeID, Tree>;
```

The same tree can be placed many times. Copies with the same `TreeID` are
placements or replicas of one tree. The `TreeID` denotes the same logical tree
and history wherever Arbor is implemented. Even local, private, unpublished,
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

In Arbor, records, tables, files, and documents are all ways to read nodes:

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
questions. A bytes hash identifies one exact authored byte sequence. The Wire
root is the corresponding exact identifier for a complete accepted snapshot:
as the object hash of the top directory, it transitively commits to the
canonical Wire encoding of every reachable object. It is not a logical model
hash.

A model hash identifies normalized node state: properties, content, and child
set, including the child schema and the model hashes of its members. Two
representations can therefore have different authored bytes and Wire roots but
the same model hash. Model hashes prove that decoding different
representations produced equivalent logical state; they do not turn two trees
with different `TreeID`s into the same tree.

A provider computes model hashes only where doing so is bounded and useful. A
database row can cheaply expose one for guarded writes, while a live database
does not maintain a whole-table model hash. Freshness for an unbounded or live
backing is expressed with its committed observation cursor instead.

## 1. Reading trees

### 1.1 Snapshot and watch

A full replica normally begins with a complete snapshot and then follows the
watch endpoint.

```text
GET /.arbor/trees/{TreeID}/snapshot
GET /.arbor/trees/{TreeID}/watch?after={cursor}
```

### 1.1.1 Getting a snapshot of the whole tree

```text
GET /.arbor/trees/{TreeID}/snapshot
```

A snapshot is the self-contained accepted-tree-state read: the transition from
nothing to the current root, so it carries only complete objects.

```ts
type CurrentTreeSnapshot = {
  tree: RemoteTreeDescriptor;
  root: Hash;
  objects: ObjectEnvelope[];
  observedThrough: EventCursor;
};

type RemoteTreeDescriptor = {
  id: TreeID;
  kind: "ordinary" | "account-configuration";
  access: "none" | "read" | "write";
  root: Hash;
  update: string;
  canonical: {
    path: LogicalPath;
    endpoint: string;
    parentTree: TreeID | null;
  } | null;
};

type ObjectEnvelope = { hash: Hash; bytes: string };
type EventCursor = string;
type Hash = `sha256:${string}`;
```

An `ObjectEnvelope` is JSON transport packaging for one encoded
`WireObject`. The decoded value has two variants:

```ts
type WireObject = WireFile | WireDirectory;

type WireFile = {
  type: "file";
  bytes: Uint8Array;
};

type WireDirectoryEntry =
  | { name: Name; hash: Hash }
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

A directory entry either addresses another Wire object by hash or marks a
nested Arbor tree boundary by TreeID. `childrenSource`, when present, records
how authored collection files supply the directory's logical children; its
projection and validation rules are defined by
[child backings §2.1](06-child-backings.md#21-accepted-wire-representation).

Section 4.1 defines the common encoding and hash rules.

#### 1.1.2 Watching

```text
GET /.arbor/trees/{TreeID}/watch?after={cursor}
```

The request carries `Accept: text/event-stream` and may carry
`Last-Event-ID: {cursor}`. `after` and `Last-Event-ID` are equivalent.

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
  previousRoot: Hash | null;
  kind: "initial" | "accepted" | "merged" | "restored";
  acceptedAt: number;
  subject: string | null;
  merge?: MergeSummary;
};

type MergeSummary =
  | { version: "markdown-additive-v1"; approximatePlacements: number }
  | { version: "account-config-v2"; mergedFields: number }
  | { version: "collection-file-rows-v1"; mergedRows: number };
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

Accepted updates are ordered within their tree by their `id`. That id is also
the cursor of the `tree.update` event that records the update.

Every update records one transition from its exact `previousRoot` to `root`, regardless of whether the authority directly accepted, merged, or restored that result.

The transition may carry complete `objects`, [deltas](#25-sparse-transfer-with-object-deltas), or both.

`transitions` is nonempty, chains exactly by root (each `previousRoot` is the preceding `root`), and ends at `change.descriptor.update` and `change.descriptor.root`. A client may apply a batch sequentially in memory and commit only the final materialization.

For `tree.update`, a transition's `requestDigest` is present only when the stream is authenticated by the exact bearer credential that submitted that accepted request. This allows watchers to identify the revision that includes an update they sent.

A non-retained event cursor, a retained accepted update without a replay
payload, or a batch too old for retained transition data produces one terminal
`resync-required` event and closes. The client reads a new coherent snapshot
and resumes strictly after that snapshot's cursor.

### 1.2 Other ways to read trees

#### 1.2.1 Reading tree metadata

```text
GET /.arbor/trees/{TreeID}
```

The response is:

```ts
type CurrentTree = {
  tree: RemoteTreeDescriptor;
  observedThrough: EventCursor;
};
```

The descriptor's `root` is the bytes hash of the current accepted tree state
and `update` is the accepted-update id that produced it.
`observedThrough` is the cursor after which a client can begin watching without
a read/watch race. Because accepted updates are the only state changes on a
portable tree watch, it equals `tree.update`; the separate field makes the
snapshot-then-watch boundary explicit. Hosted trees have, in addition, a
canonical path, endpoint, and might be nested inside a parent-tree.

#### 1.2.2 Reading an object at a time

Clients that do not retain a whole tree can use this endpoint to fetch files
and directories on demand.

```text
GET /.arbor/trees/{TreeID}/objects/{hash}
```

This route returns the same canonical CBOR bytes carried in an `ObjectEnvelope`, but directly as the response body. The hash is present in the URL, and repeated as the quoted ETag. The response uses `application/cbor` and immutable cache headers. The response body must hash to the requested value.

A client may also use this to refetch one missing or corrupt current object instead of downloading a complete snapshot. Because objects are immutable and addressed by their bytes, successful responses can be cached and reused wherever that hash remains reachable and authorized.

## 2. Updates and writes

### 2.1 The update request

```text
POST /.arbor/trees/{TreeID}/updates
```

The client submits one candidate against an accepted base it observed and says
which equality level must still match for that candidate to be accepted:

```ts
type UpdateRequest = TransitionPayload & {
  base: string | null;
  candidate: Hash;
  ifMatch: "bytesHash" | "modelHash";
  onConflict?: "reject" | "merge";
};
```

An update proposes a transition from the accepted base to the candidate root;
the authority accepts it, or merges and answers with the transition from the
candidate to what it accepted; watch ([§1.1.2](#112-watching))
delivers every accepted transition in order. One payload shape serves all
three.

`base` is the id of the accepted update the candidate was derived
from. `candidate` names the exact Wire root encoding the desired complete candidate tree state.
The authority decodes and validates its modeled state and all
projection-specific fidelity required by that encoding. `objects` supplies
canonical CBOR objects the server does not already retain; a client normally
walks base and candidate together and omits unchanged objects. The candidate
must still be complete and provable from retained base objects, supplied
objects, and valid `deltas`. The
[delta rules](#25-sparse-transfer-with-object-deltas) define interchangeable
transfer representations; they do not change the candidate's identity.

### 2.2 What the write matches

`ifMatch` names which hash from the [data-model equality rules](#representation-and-model-equality)
must still match its value at base, as an ETag does for HTTP `If-Match`:

- `bytesHash`: the tree's bytes hash must still match, so current must still
  equal base. Any other change is a conflict and is always rejected; matching
  on bytes means "exactly what I saw", so a merge would contradict it.
  Activation uses it, and so does any tool that must replace the tree's exact
  state.
- `modelHash`: the model hash of each node the candidate changed must still
  match. The authority takes every node whose bytes differ between base and
  candidate—the candidate's *touched* nodes—and checks that each has the same
  model hash in current as it had at base. A current-side reformat does not
  conflict, nor does a change elsewhere. `onConflict`, which defaults to
  `merge`, either rejects a touched-node model conflict or invokes that
  representation's merge rule.

A write says what must still match: the bytes hash it saw, or the model hash
of each node it changed. The authority rejects a write whose match fails,
unless the write allows a same-node conflict to be resolved by that
representation's merge rule
([updates §2](#2-updates-and-writes)). A claim of equality
uses whichever level the claim is about. Invalidation uses cursors, narrowed
by precision.

A node's properties are one map however they are edited: a property write
replaces the complete map under the match it names, cannot change the
property selected by the applicable identity declaration, and leaves content
and children alone.

The spelling `ifMatch: "modelHash"` is correct: it selects the complete model
hash of each touched logical node. A collection file's `childSetHash` proves
only that node's decoded child-set contribution. It is not a replacement name
for the update setting.

### 2.3 Accepting and merging

After reconstructing and validating the candidate graph, the server makes one
of these decisions:

1. If the candidate already equals current, return `200 current` and create no
   accepted update.
2. If the candidate equals the base while current has advanced, return the
   current accepted update and create no new update.
3. If current equals the base, atomically accept the candidate and return
   `201 accepted`.
4. Otherwise, if `ifMatch` is `modelHash` and every touched node still
   matches, or every conflicting
   node is resolved by a merge rule under `onConflict: "merge"`, merge: the
   result is current with the candidate's bytes for its touched nodes and the
   rule's output for any resolved node. Atomically accept it and return
   `201 merged`.
5. Otherwise return `409 conflict` with the current update, structured reasons
   naming each conflicting node, and the `draft` transition the client keeps.
   Accepted state does not advance and the rejected candidate does not become
   history.

A merge rule is the representation-specific way to combine two changes to one
node: `markdown-additive-v1` for Markdown,
[`collection-file-rows-v1`](06-child-backings.md#23-accepted-update-validation-and-merge)
for a collection file, and `account-config-v2` for the governed configuration
tree. A node with no merge rule, or one the rule cannot combine, is a conflict.

### 2.4 Results, conflicts, and retry

A successful response is:

```ts
type UpdateResult = {
  outcome: "current" | "accepted" | "merged";
  update: AcceptedUpdate;
  requestDigest: Hash;
  observedThrough: EventCursor;
  reconciliation?: TransitionPayload;
};
```

`update` is the accepted update that stands after the decision: the untouched
current one for `current`, or the newly accepted or merged one. `merge` is
present only when a merge rule ran; a merge of disjoint nodes carries none. An
accepted update's `id` is the decimal ordinal of the `tree.update` event that
recorded it, so it is also that event's cursor and `observedThrough`.
`reconciliation` is present exactly when the accepted root differs from the
submitted candidate: it is the transition from the candidate root to
`update.root` under the [deltas](#25-sparse-transfer-with-object-deltas) rules, so
a superseded, merged, or replayed result is applied with the same code that
applies a watch frame. An accepted candidate returns none.

A conflict uses the shared `ArborError` envelope with
`details.kind: "server-update" | "account-configuration"`. Its details include the current `AcceptedUpdate`, the base and candidate
roots, structured conflict reasons naming each conflicting node, and `draft`,
the transition from the candidate root to the draft root the client keeps.

Semantic request identity is the SHA-256 of the
[canonical CBOR encoding](#41-cbor-and-hashes)
of `{ version: "updates-v1", tree, base, candidate, ifMatch, onConflict }`,
with `onConflict` as its effective value, scoped to the
authenticated credential. `objects`, `deltas`, and their ordering are
transport choices and are excluded. An ambiguous retry may therefore replace a
delta with complete bytes without changing identity. Exact accepted or merged
replay returns the original result and creates no duplicate accepted update.
Clients durably retain the base, candidate, required content, and any conflict
draft until the result has been applied.

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

Two tokens that serve different purposes are often encountered together:

- An accepted-update `id` identifies one durable accepted transition of one
  tree and is also that transition's `tree.update` cursor.
- A credential-scoped `requestDigest` identifies one canonical `updates-v1`
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

A file object's canonical encoding carries its payload length, so a sender
deriving a delta from editor edits inserts the result's header bytes and copies
unchanged payload ranges at their base offsets. Any instruction sequence that
reconstructs the exact result is valid; the diff algorithm is the sender's
choice and never part of identity.

The base must be reachable in the relevant basis graph: the retained accepted
base for a submission, or the previous accepted root for a transition. The
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

This non-normative example shows how the preceding operations compose:

1. The client makes an editor change durable locally and records its accepted
   `{ root, update }` base.
2. It builds the complete candidate graph, omitting unchanged objects and using
   an `ObjectDelta` when that is smaller than the complete changed object.
3. It submits the candidate against its accepted base update id. The
   authority validates it, performs any merge, and atomically records at most
   one accepted update.
4. The response and the corresponding `tree.update` event may arrive in either
   order. The submitting client handles them idempotently; a matching private
   `requestDigest` is a causal acknowledgement of the frozen semantic intent.
5. A clean replica applies a contiguous transition batch in memory and durably
   materializes only its final state. A replica with local changes submits its
   own candidate. Missing history or any failed check falls back to a coherent
   snapshot.

The client clears its durable attempt only after applying the accepted or
merged graph and advancing its local base. The event acknowledges candidate
intent, not the submitted delta bytes: a merge may produce a different accepted
representation. Rejected conflicts never appear on watch.

## 4. Encoding details

### 4.1 CBOR and hashes

Whenever Arbor hashes a structured value, it first encodes that value as
canonical CBOR and then hashes those bytes with SHA-256. The section that
defines a particular hash defines the value being encoded; this subsection
defines the common structured-value encoding.

The permitted CBOR subset is: `null`; booleans; integers in the safe 53-bit
range as CBOR integers with minimal-length heads; every other finite number as
a 64-bit float; UTF-8 text; byte strings; arrays; and maps whose keys are text,
unique, and ordered by the bytes of their encoded form. Non-finite numbers,
indefinite lengths, tags, and non-text keys are invalid.

For a Wire object, the envelope is constructed as follows:

```text
objectBytes = canonicalCBOR(wireObject)
envelope = {
  hash: sha256(objectBytes),
  bytes: paddedBase64(objectBytes)
}
```

To validate an envelope, the receiver decodes `bytes` as canonical padded
base64, requires the SHA-256 of the resulting bytes to equal `hash`, requires
those bytes to be canonical CBOR, and decodes exactly one `WireObject` from
them. The envelope is not itself hashed and is not a node in the object graph;
it only carries an addressed object's hash and bytes through a JSON response or
transition payload.

Model hashes, collection-file `childSetHash` values, update and mutation
request digests, and query output hashes apply the same CBOR-then-SHA-256
procedure to the distinct structured values defined by their own contracts.
They are not hashes of a Wire object unless their contract says so, and
nothing on the Wire is identified by canonical JSON text.

When the value being identified is already an exact byte sequence, Arbor
hashes those bytes directly instead. In particular, `schemaFingerprint` is
the SHA-256 of the exact UTF-8 bytes of `schema.ts`. It differs from the hash
of the schema's `WireFile`, which covers the canonical CBOR encoding of the
file object. The
[`canonical-cbor-values`](../conformance/canonical-cbor-values.json) vectors
freeze valid encodings and rejected byte sequences for every language binding.

The server captures one accepted update and returns the complete graph for
that update even if a newer update is accepted while the response is being
encoded. The response therefore satisfies `tree.root === root`; it is an
atomic current-state read, not an accepted-history query.

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
