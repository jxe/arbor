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

### 1.1 Current tree, accepted snapshots, and watch

A full replica reads the current tree descriptor, obtains that descriptor's
content-addressed accepted snapshot, and then follows the watch endpoint after
the descriptor's observation cursor.

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
  permissions: string[];
  root: Hash;
  update: string;
  canonical: {
    path: LogicalPath;
    endpoint: string;
    parentTree: TreeID | null;
  } | null;
};

type EventCursor = string;
type Hash = `sha256:${string}`;
```

The descriptor's `access` is the caller's effective whole-tree level and
`permissions` is the sorted, duplicate-free set of effective active
tree-scoped mutation permissions defined by
[access control](05-access-control.md#11-named-mutation-permissions).
The list is empty when the tree is unreadable or no named permission applies;
`write` additionally satisfies every tree-local permission without enumerating
them. The descriptor's `root` is the bytes hash of the current accepted tree state
and `update` is the accepted-update id that produced this observation.
`observedThrough` is the cursor after which watching begins. Because accepted
updates are the only state changes on a portable tree watch, it equals
`tree.update`; the separate field makes the read-then-watch boundary explicit.
Hosted trees have, in addition, a canonical path, endpoint, and might be nested
inside a parent tree.

The same root may be accepted again by a later update. Its graph remains the
same content-addressed snapshot, while the later descriptor's `update` and
`observedThrough` identify the later observation.

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
exact canonical CBOR bytes of one `WireObject`. Members are ordered
lexicographically by the SHA-256 hash derived from those bytes; hashes are not
repeated in the body.

The requested root in the URL identifies the graph and is not repeated in the
body. As the top directory object's hash, it transitively commits to every
reachable object. A client hashes every supplied byte string, rejects duplicate
hashes or noncanonical `WireObject` encodings, requires the requested root to
be present, and walks its graph. It rejects missing reachable objects and
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
verified response indefinitely. A Canopy need only answer a future origin
fetch while that accepted root remains retained.

Changing the current root or ACL does not change an already returned snapshot.
Revocation prevents a new authorized origin fetch but cannot retract bytes a
client or cache already received. In particular, a publicly cached accepted
root can remain publicly available after the tree ceases to grant public
access. Removing content from the current tree is therefore not erasure from
retained accepted snapshots or caches.

The decoded `WireObject` has two variants:

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
nested Arbor tree boundary by TreeID. A snapshot walk stops at such a boundary:
the nested tree has its own roots, history, and access. `childrenSource`, when
present, records how authored collection files supply the directory's logical
children; its projection and validation rules are defined by
[child backings §2.1](06-child-backings.md#21-accepted-wire-representation).

An `ObjectEnvelope` is JSON transport packaging for the same canonical object
bytes when another operation, such as an update request, carries objects inside
JSON. Its `hash` is the SHA-256 hash derived from its decoded `bytes`:

```ts
type ObjectEnvelope = { hash: Hash; bytes: string };
```

Section 4.1 defines the common encoding and hash rules.

#### 1.1.3 Watching

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
`resync-required` event and closes. The client reads a new current descriptor,
obtains its addressed snapshot, and resumes strictly after the descriptor's
`observedThrough` cursor.

### 1.2 Other ways to read trees

#### 1.2.1 Reading an object at a time

Clients that do not retain a whole tree can use this endpoint to fetch files
and directories on demand.

```text
GET /.arbor/trees/{TreeID}/objects/{hash}
```

This route returns the same canonical CBOR bytes carried in a snapshot bundle
or `ObjectEnvelope`, but directly as the response body. The hash is present in
the URL and repeated as the quoted ETag. The response uses `application/cbor`,
must hash to the requested value, and uses the same access-sensitive `Vary` and
`Cache-Control` policy as an accepted snapshot.

A new origin fetch remains authorized only when the object is reachable from
the named tree's current readable root; historical snapshot access does not
make this generic object route a historical-object oracle. A client may use it
to refetch one missing or corrupt current object instead of downloading a
complete snapshot. Because objects are immutable and addressed by their bytes,
successful responses can be cached and reused after verification.

## 2. Updates and writes

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
  candidate: Hash;
  ifMatch: "bytesHash" | "modelHash";
  onConflict?: "reject" | "merge";
};
```

`base` is the id of the accepted update and `tree.update` watchpoint from which
the string begins, or `null` when its first element activates a reserved tree.
Each element proposes one distinct accepted-history boundary. The first is
authored on the root at `base`; every later element is authored on the preceding
element's submitted `candidate`, whether or not that candidate has received an
authority response.

A client may submit progressively longer strings without waiting for an
earlier POST or the watch stream. For example, these requests may be in flight
at the same time:

```json
{
  "base": "248",
  "updates": [
    {
      "candidate": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "ifMatch": "modelHash",
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
      "candidate": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "ifMatch": "modelHash",
      "objects": [],
      "deltas": []
    },
    {
      "candidate": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "ifMatch": "modelHash",
      "objects": [],
      "deltas": []
    }
  ]
}
```

Within one client epoch, every later request must preserve the exact semantic
earlier elements and only append. The transport representation of an element's
objects and deltas may change without changing its identity. A client must not
rewrite an element's candidate or matching policy, or fork two different
successors from one prefix. It starts a new epoch only after the previous
speculative string has been completely acknowledged and its resulting accepted
transition has been durably applied, using that watchpoint as the new `base`.

The authority derives a credential-scoped request digest for each element. For
the first element the digest basis is the accepted update id in `base`. For
each later element it is `{ requestDigest, candidate }` from the preceding
element. Consequently every digest commits to the complete prefix, and the
same prefix has the same identities in every longer request.

The authority serializes update strings per tree. Before processing new work,
it finds the longest supplied prefix already represented by successful
credential-scoped request digests in accepted history and trims that prefix.
If the longer request arrives first it may apply every element; if a shorter
request arrives first the longer request resumes after it; an old shorter
request arriving last changes nothing. A previously returned `current` element
need not have its own durable resolution record: a later accepted element
proves its prefix was processed, while an otherwise unresolved `current`
element may be evaluated again without creating accepted history.

For each untrimmed element, the logical base root is the preceding submitted
candidate, not the preceding accepted or merged root. Thus, if `B` to `C1` is
merged into `M1`, the next element is reconciled as `(base: C1, candidate: C2,
current: M1)`. Only the incremental `C1` to `C2` change is applied to the
merged state. Each successful state-changing element is committed and emitted
on watch separately. A conflict stops the string at that element; its
successful prefix remains accepted and later elements are not attempted.

Each `candidate` names the exact Wire root encoding the desired complete tree
state. The authority decodes and validates its modeled state and all
projection-specific fidelity required by that encoding. Each element may omit
objects available from the preceding graph, but the complete request must be
self-contained from its retained accepted `base` plus its `objects` and valid
`deltas`. The authority may reconstruct an already-applied prefix from the
repeated request instead of retaining its submitted candidate graph. The
[delta rules](#25-sparse-transfer-with-object-deltas) define interchangeable
transfer representations; they do not change a candidate's identity.

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

For each untrimmed element, after reconstructing and validating its candidate
graph, the server makes one of these decisions:

1. If the candidate already equals current, return `current` and create no
   accepted update.
2. If the candidate equals the base while current has advanced, return the
   current accepted update and create no new update.
3. If current equals the base, atomically accept the candidate and return
   `accepted`.
4. Otherwise, if `ifMatch` is `modelHash` and every touched node still
   matches, or every conflicting
   node is resolved by a merge rule under `onConflict: "merge"`, merge: the
   result is current with the candidate's bytes for its touched nodes and the
   rule's output for any resolved node. Atomically accept it and return
   `merged`.
5. Otherwise stop and return `409 conflict` with the current update, structured reasons
   naming each conflicting node, and the `draft` transition the client keeps.
   Accepted state does not advance and the rejected candidate does not become
   history.

A merge rule is the representation-specific way to combine two changes to one
node: `markdown-additive-v1` for Markdown,
[`collection-file-rows-v1`](06-child-backings.md#23-accepted-update-validation-and-merge)
for a collection file, and `account-config-v2` for the governed configuration
tree. A node with no merge rule, or one the rule cannot combine, is a conflict.

### 2.4 Results, conflicts, and retry

A successful response is always plural and contains one result for every
element, including any element trimmed as an exact replay:

```ts
type UpdateResponse = {
  results: UpdateResult[];
  observedThrough: EventCursor;
};

type UpdateResult = {
  outcome: "current" | "accepted" | "merged";
  update: AcceptedUpdate;
  requestDigest: Hash;
  reconciliation?: TransitionPayload;
};
```

`results` is nonempty and preserves request order. The response status is `201`
if at least one result is `accepted` or `merged`, including an exact replay of
such a result, and otherwise `200`. `observedThrough` is the authority's
observation boundary after the whole string was processed. `update` is the
accepted update that stands after the decision: the untouched current one for
`current`, or the newly accepted or merged one. `merge` is present only when a
merge rule ran; a merge of disjoint nodes carries none. An accepted update's
`id` is the decimal ordinal of the `tree.update` event that recorded it, so it
is also that event's cursor and `observedThrough`.
`reconciliation` is present exactly when the accepted root differs from the
submitted candidate: it is the transition from the candidate root to
`update.root` under the [deltas](#25-sparse-transfer-with-object-deltas) rules, so
a superseded, merged, or replayed result is applied with the same code that
applies a watch frame. An accepted candidate returns none.

A conflict uses the shared `ArborError` envelope with
`details.kind: "server-update" | "account-configuration"`. Its details include
`completed`, the ordered successful prefix results; `failedIndex`; the current
`AcceptedUpdate`; the logical base and candidate roots; structured conflict
reasons naming each conflicting node; and `draft`, the transition from the
candidate root to the draft root the client keeps.

Semantic request identity is the SHA-256 of the
[canonical CBOR encoding](#41-cbor-and-hashes)
of `{ version: "updates-v1", tree, base, candidate, ifMatch, onConflict }`, with
`onConflict` as its effective value, scoped to the authenticated credential.
For the first element, `base` is the request's accepted update id or `null`.
For each later element, `base` is
`{ requestDigest: previousDigest, candidate: previousCandidate }`. This latter
object is part of semantic identity but is implicit in the ordered JSON request.
`objects`, `deltas`, and their ordering are
transport choices and are excluded. An ambiguous retry may therefore replace a
delta with complete bytes without changing identity. Exact accepted or merged
elements replay their original results and create no duplicate accepted update.
A `current` element may be evaluated again. Clients durably retain their epoch
base, ordered elements, required content, and any conflict draft until the
corresponding prefix has been applied.

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

The base must be reachable in the relevant basis graph: the request's retained
accepted watchpoint for its first element, the preceding candidate graph for a
later element, or the previous accepted root for a watch transition. The
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

1. The client records a confirmed `{ root, update }` watchpoint plus an ordered
   speculative string of locally durable authored generations.
2. It builds a complete candidate graph for every generation, omitting
   unchanged objects and using an `ObjectDelta` when that is smaller than the
   complete changed object. Every POST uses the epoch's confirmed update id as
   `base` and repeats the complete speculative string accumulated so far.
3. Once each generation is durable, the client may immediately submit the
   longer string without waiting for an earlier POST or watch event. The
   authority trims its accepted prefix, validates each remaining element,
   performs any merge, and atomically records at most one accepted update per
   element.
4. The responses and corresponding `tree.update` events may arrive in either
   order. The submitting client handles them idempotently; a matching private
   per-element `requestDigest` is a causal acknowledgement of one frozen
   generation and advances the confirmed prefix when all earlier generations
   are also known.
5. A clean replica applies a contiguous transition batch in memory and durably
   materializes only its final state. A replica with local changes submits its
   own candidate. Missing history or any failed check falls back to a coherent
   snapshot.

The client removes generations only from the acknowledged front of its durable
string. Once the string is empty, it starts a new epoch at the newest watchpoint
it has durably applied. An older in-flight POST is harmless because it contains
only already-acknowledged element identities. A watch event acknowledges
candidate intent, not submitted delta bytes: a merge may produce a different
accepted representation. If an element is rejected, later elements were
authored on an unaccepted graph; the client keeps that suffix for explicit
conflict handling or rebuilds it from the returned draft. Rejected conflicts
never appear on watch.

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
