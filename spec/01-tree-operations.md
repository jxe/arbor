# Tree reads, writes, watching, and editor round trips
*Part of the [Arbor spec](../spec.md): the logical tree model and the operations that read, change, observe, and faithfully materialize copies.*

## The Arbor data model

### Trees and identity

Arbor is conceptually a global hash table of trees:

```ts
type Arbor = Map<TreeID, Tree>;
type TreeID = string;
```

The same tree can be placed many times. Copies with the same `TreeID` are placements or replicas of one tree. The `TreeID` denotes the same logical tree and history wherever Arbor is implemented. Even local, private, unpublished, and offline trees have these IDs, although no public service can find them yet. (Each device, community, and application knows only the partial map it can locate and read.)

TreeIDs are generated randomly and locally when people share files or folders, except for person-profile TreeIDs which are not generated randomly but based on a private key that user has, to prove that tree is owned by them. See [accounts §1.1](05-accounts-and-devices.md#11-beginning-a-person-identity).

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

type Name = string;
```

In arbor, records, tables, files, and documents are all ways to read nodes:

| Reading | Representation |
|---|---|
| Document | content, with properties as its frontmatter |
| File | content bytes |
| Directory | children |
| Record | properties as fields |
| Collection | children that share a schema |
| Row | one child of a collection, keyed by a rule its parent declares |
| Executable document or agent | content that has been granted reviewed execution capabilities |

So, a markdown page with frontmatter is both a document and a record. A folder of such pages can be
seen as either a directory and a database table (or both).

For representing typed collections, a child set may declare a schema shared by its members. A node whose children share such a schema can be read as a collection. The schema defines member property and content shapes, stable identity, logical naming, relationships, ordering, and constraints.

### Representations

Any particular materialized copy of an arbor tree can choose how to save things, although there are standard options for materializing a tree into a filesystem, described in [directory-format](03-directory-format.md), although those filesystem materializations can be augmented with other kinds of data materializations, described in [child backings](07-child-backings.md). Depending on how your own arbor is configured, it may roll up a remote node with many structured children into a .sqlite3 file, some .csv, etc. And when you share a local tree with sqlite3 files and so on in it, those will be mapped into this general representation.

We call this is the child set's *backing* at that placement.

## 1. Reading trees

### 1.1 Tree snapshots and then watching changes

Usually, a client will start off by grabbing a full snapshot of a tree, and then use the watch endpoint.

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
```

A directory entry either addresses another Wire object by hash or marks a
nested Arbor tree boundary by TreeID.

What exactly the hashes are of is described below in §4.

## 1.1.2 Watching

```text
GET /.arbor/trees/{TreeID}/watch?after={cursor}
```

The request carries `Accept: text/event-stream` and may carry `Last-Event-ID: {cursor}`. `after` and `Last-Event-ID` are equivalent.

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

Accepted updates are ordered within their tree by their `id`, the observation
ordinal that recorded them; the same ordinal orders the combined observation
stream, so one counter yields update ids and event cursors.

Every update records one transition from its exact `previousRoot` to `root`, regardless of whether the authority directly accepted, merged, or restored that result.

The transition can contain `objects` contains or [deltas](#26-sparse-transfer-with-object-deltas).

`transitions` is nonempty, chains exactly by root (each `previousRoot` is the preceding `root`), and ends at `change.descriptor.update` and `change.descriptor.root`. A client may apply a batch sequentially in memory and commit only the final materialization.

For `tree.update`, a transition's `requestDigest` is present only when the stream is authenticated by the exact bearer credential that submitted that accepted request. This allows watchers to identify the revision that includes an update they sent.

A non-retained event cursor, a retained accepted update without a replay
payload, or a batch too old for retained transition data produces one terminal
`resync-required` event and closes. The client reads a new coherent snapshot
and resumes strictly after that snapshot's cursor.

<!--todo: is the tree.activation thing necessary? why? it complicates the wire protocol in a way I am unsure about -->

`tree.activation` is the one observation kind that is not an accepted update. When a tree declared in
`trees.yaml` becomes active ([accounts §6](05-accounts-and-devices.md#6-declaring-and-activating-a-tree)), the
authority records one event on the declaring account's configuration-tree
stream:

```ts
type TreeActivationEvent = {
  cursor: EventCursor;
  tree: TreeID; // the account-configuration tree carrying the event
  kind: "tree.activation";
  change: { tree: TreeID; status: "active" };
};
```

`change.tree` names the newly active tree. The event advances the
configuration tree's observation stream and `observedThrough` without changing
its accepted content update; a watcher applies no transition for it.

### 1.2 Other ways to read trees

#### 1.2.1 Reading tree metadata

```text
GET /.arbor/trees/{TreeID}
```

Give you:

```ts
type CurrentTree = {
  tree: RemoteTreeDescriptor;
  observedThrough: EventCursor;
};
```

The descriptor's `root` is the bytes hash of the current accepted tree state
and `update` is the accepted-update id that produced it.
`observedThrough` is the cursor after which a client can begin watching without
a read/watch race. Hosted trees have, in addition, a canonical path,
endpoint, and might be nested inside a parent-tree.

#### 1.2.2 Reading a node at a time

This endpoint is only necessary for clients that don't grab a whole tree, so they can grab files and directories on demand.

```text
GET /.arbor/trees/{TreeID}/objects/{hash}
```

This route returns the same canonical CBOR bytes carried in an `ObjectEnvelope`, but directly as the response body. The hash is present in the URL, and repeated as the quoted ETag. The response uses `application/cbor` and immutable cache headers. The response body must hash to the requested value.

A client may also use this to refetch one missing or corrupt current object instead of downloading a complete snapshot. Because objects are immutable and addressed by their bytes, successful responses can be cached and reused wherever that hash remains reachable and authorized.

### 1.4 Interpreting the object graph

#### 1.4.1 Collection-file interpretation

<!--todo: this should be in directory-format and child-backings, not here-->

An ordinary directory represents immediate children with separate entries. A
collection-file directory instead stores many logical children inside one
physical file:

```text
Physical entries below /books:
  _store.json  → sourceHash
  schema.ts    → schemaHash

Logical children below /books:
  alice
  bob
```

The entry hashes prove and preserve the two files' exact bytes, but entries
alone do not say that rows in `_store.json` are children. The directory's
`childrenSource` descriptor supplies that interpretation:

```ts
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

| Fields | Meaning |
|---|---|
| `version`, `type` | Select this descriptor contract. |
| `format`, `source` | Select the physical collection file and the parser for its exact bytes. |
| `schemaSource` | Select the physical schema file used to interpret the rows. |
| `schemaFingerprint` | Commit to the exact UTF-8 bytes of the selected schema source. |
| `childSetHash` | Commit to the normalized logical children derived from the collection file and schema. |

A conforming authority validates the descriptor in this order:

1. Require `source` and `schemaSource` to name two ordinary file entries in
   the same directory, and require `source` to agree with `format`.
2. Load the exact source and schema bytes through those entries' hashes.
3. Recompute `schemaFingerprint` from the exact schema bytes, then evaluate
   `schema.ts` in the restricted application-code runtime.
4. Parse the collection file, then validate and normalize every row with that
   schema.
5. Derive every row's stable key and logical name using the schema's
   `childName` rule.
6. Canonically order the resulting `{ key, name, properties }` values and
   recompute `childSetHash`.
7. Reject a missing or multiply claimed source, an invalid row, key, or name,
   or either derived-hash mismatch.
8. Expose the normalized rows as the directory node's immediate logical
   children. Preserve `source` and `schemaSource` as physical authored
   entries, but do not expose them as logical children.

A directory without `childrenSource` derives its immediate children from
ordinary expanded entries. A directory with `childrenSource` derives the
complete immediate child set through the procedure above; mixing those
collection-file-derived children with expanded immediate children is invalid.

The three hashes identify different things. The collection file's
`childSetHash` identifies only the decoded child-set contribution. The
enclosing node's model hash additionally covers its properties, content, and
child schema. The Wire root identifies the exact authored object graph. A
formatting-only edit can therefore change the Wire root while leaving both
logical hashes unchanged.

Database-backed placements are not decoded through a
`CollectionFileDescriptor`; database pages and WAL files are never
`WireObject` values. Their snapshot, observation, and future synchronization
rules belong to [child backings](07-child-backings.md).

### 1.5 Equality after a read

<!--todo: this stuff should go under 'arbor data model' at the top, but should be more concise-->

There are three different comparisons a reader may need. They must not be
substituted for one another.

#### 1.5.1 Exact representation equality

A bytes hash identifies one exact byte sequence. For example, the bytes hash
of an authored file changes when a CSV is reformatted or frontmatter keys are
reordered, even if decoding produces the same model. It exists only where the
representation exposes bytes. Its uses are proving that authored source is
untouched and performing byte-level compare-and-swap.

The Wire root plays the corresponding role for a complete Wire snapshot. It
is the object hash of the top directory. Because that directory contains the
hashes of its children, it transitively commits to the exact canonical Wire
encoding of every reachable object. Equal Wire roots therefore prove equal
Wire snapshots. The Wire root is not a logical model hash.

#### 1.5.2 Logical model equality

A model hash identifies normalized model state: a node's properties, content,
and child set, including the child schema and the model hashes of its members.
Two representations can therefore have different authored bytes and Wire
roots but the same model hash.

Model hashes prove that decoding two representations produced equivalent
logical state. They support work avoidance and verification that a reformat or
migration preserved the data. Expanded Markdown records, JSON, SQLite, and
Postgres may represent one model-equivalent collection even though none is the
canonical serialization of the others.

A model hash is defined for every logical node, but a provider computes one
only where doing so is bounded and useful. A database row's model hash is
cheap, so a row write can match it. A live database does not maintain a model
hash for a whole table; table freshness is expressed with a committed
observation cursor instead.

The same tree or node can change both its representation hash and model hash
while retaining identity. Conversely, two different trees can happen to have
equal Wire roots or model hashes without becoming the same tree.

## 2. Updates and writes

### 2.1 The update request

```text
POST /.arbor/trees/{TreeID}/updates
```

The client submits some updates against an accepted base it observed, together with which hash must still match for the candidate to be accepted:

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
candidate to what it accepted; watch ([§3](#1.1.2-watching))
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
[delta rules](#26-sparse-transfer-with-object-deltas) define interchangeable
transfer representations; they do not change the candidate's identity.

### 2.2 What the write matches

`ifMatch` names which hash from the [read equality rules](#15-equality-after-a-read)
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

A merge rule is the representation-specific way to combine two changes to
one node: `markdown-additive-v1` for Markdown,
`collection-file-rows-v1` for a collection file, and `account-config-v2` for
the governed configuration tree. A node
with no merge rule, or one the rule cannot combine, is a conflict.

### 2.4 Collection-file validation and merge

<!--todo: this should also be moved to child-backings-->

When a candidate changes a recognized collection file, the submitted root
names the exact lossless encoding of that candidate tree state. The authority
decodes coherent base, current, and candidate representations under schema and
resource bounds, recomputes logical row identities and the collection file's
child-set hash, applies `collection-file-rows-v1` to a conflicting collection
file, validates all
keys, foreign keys, and constraints, and encodes the accepted representation.
It never trusts a client-supplied schema fingerprint or child-set hash.
Formatting-only changes advance the accepted root without changing the
child-set hash, so they invalidate no logical query dependency.

The update setting `ifMatch: "modelHash"` is intentionally not renamed: it
compares the complete model hash of every touched logical node, not the
collection file's narrower `childSetHash`. The latter is used while decoding
and merging the node's child-set contribution. SQLite and Postgres changes use
the database transaction,
observation, and semantic-checkpoint protocol specified separately; live
database storage bytes are never submitted or merged as a collection-file
object.

Authorities advertise collection-file, schema, and row quotas and never
accept a collection file they cannot validate completely. Semantic merge
reports `collection-file-row-conflict`, `collection-file-schema-conflict`, or
`collection-file-constraint-conflict`; a row conflict path uses the parent
logical path plus its `arbor-key` identity suffix. Database backings do not use
this exact-source descriptor and their live storage bytes are never accepted
as Wire objects.

### 2.5 Results, conflicts, and retry

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
present only when a merge rule ran; a merge of disjoint nodes carries none. An accepted update's `id` is the decimal ordinal
of the observation that recorded it, so it is also that update's `tree.update`
cursor and `observedThrough`. `reconciliation` is present exactly when the accepted root differs from the
submitted candidate: it is the transition from the candidate root to
`update.root` under the [deltas](#26-sparse-transfer-with-object-deltas) rules, so
a superseded, merged, or replayed result is applied with the same code that
applies a watch frame. An accepted candidate returns none.

A conflict uses the shared `ArborError` envelope with
`details.kind: "server-update" | "account-configuration"`. Its details include the current `AcceptedUpdate`, the base and candidate
roots, structured conflict reasons naming each conflicting node, and `draft`,
the transition from the candidate root to the draft root the client keeps.

Semantic request identity is the SHA-256 of the
[canonical CBOR encoding](#121-canonical-cbor-and-hashes)
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

An update has two identities:

<!--todo: turn the below into two bullets-->

| Token | Identifies | Survives |
|---|---|---|
| accepted update `id` | one accepted transition of one tree | it is also that update's `tree.update` cursor |
| `requestDigest` | canonical `updates-v1` semantic intent | retransmission with different object/delta packaging |

### 2.6 Sparse transfer with object deltas

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

## 4. Editor round trip

> **Learning tip:** Make authored work durable locally before network
> submission. The update response and its watch event may race; both must be
> idempotent, and editor history remains distinct from accepted tree
> transitions.

### 4.1 One complete round trip

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

## 5. encoding details

### 5.1 CBOR and hashes

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

### 5.2 Stream framing and errors

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

### 5.3 Other constraints

Names reject NUL, slashes, backslashes, dot segments, non-NFC text, and
reserved ambiguity. Directory entries are canonically ordered.
