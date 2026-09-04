# Tree reads, writes, watching, and editor round trips
*Part of the [Arbor spec](../spec.md): the logical tree model and the canonical
operations that read, change, observe, and faithfully materialize it.*

*Owns: the global TreeID space; logical nodes and child sets; accepted state
and its canonical Wire encoding; tree reads, updates, transitions, replay,
streams, errors, and editor round trips; and the values those operations use.*

An Arbor server represents one community. It owns accounts and profile claims,
canonical tree boundaries, private account-configuration trees, credential
bindings, access enforcement, one mutable accepted root per tree, immutable
objects, and an ordered observation stream. It need not implement a local
placement, filesystem replica, or UI.

The tree operations are deliberately separate from reviewed `queries` and
`mutate` transactions, which are owned by
[executable documents](08-executable-documents.md). Hosting those executable
routes is optional; a server without that runtime returns
`422 unsupported-operation`.

| Operation | Meaning | Durable effect |
|---|---|---|
| read | Observe logical state or transfer its exact accepted bytes | None |
| update | Propose a complete candidate accepted state | At most one accepted update |
| watch | Follow ordered accepted transitions after a read cursor | None |

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

A `TreeID` denotes the same logical tree and history wherever Arbor is
implemented, but no server can enumerate every TreeID. Each device, community,
and application sees only the partial map it can locate and read.

Copies with the same `TreeID` are placements or replicas of one tree, not new
trees. They may temporarily observe different revisions while synchronization
is unsettled. Local, private, unpublished, imported, and offline trees remain
members of the conceptual map even when no public service can currently find
them.

New ordinary and group-profile tree IDs are `tr_` plus 26 lowercase base32
characters encoding 128 random bits. A new person-profile TreeID is `tr_` plus
52 lowercase base32 characters encoding the complete SHA-256 digest of the
domain-separated Ed25519 public identity key defined by
[accounts §1.1](05-accounts-and-devices.md#11-beginning-a-person-identity).
The longer form is self-certifying: presenting the public key and a valid
signature proves control without making the public TreeID a credential. New
device IDs use the 128-bit encoding after `dv_`. Existing shorter IDs may remain
valid during migration, but new person identities use only the key-backed form
and new ordinary-tree activation and device pairing require their respective
current forms.

Opening a previously unidentified ordinary or group-profile local root
generates and durably stores its random TreeID before that tree has an account,
host, or canonical URL. Beginning a person identity is the separate explicit
operation that generates its identity key and derived TreeID. Neither operation
reserves a name nor contacts a server.

A tree has one root, its own history and observation stream, and a whole-tree
permission boundary. The root has logical path `/`. Arbor trees may be mounted
inside other Arbor trees, but remain separate entries in the TreeID map; a
mount does not copy the mounted tree's nodes, history, access, or mutations
into its parent.

### Nodes, children, and readings

A tree is a rooted hierarchy of nodes:

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

A node has three parts: properties, optional content, and children. Arbor has
no separate shapes for records, tables, files, or documents. Those are
compatible ways of reading the same node:

| Reading | Which part carries it |
|---|---|
| Document | content, with properties as its frontmatter |
| File | content bytes |
| Directory | children |
| Record | properties as fields |
| Collection | children that share a schema |
| Row | one child of a collection, keyed by a rule its parent declares |
| Executable document or agent | content that has been granted reviewed execution capabilities |

The readings compose because they use different parts. A Markdown page with
frontmatter is both a document and a record. A folder of such pages can be
both a directory and a collection, while each member remains a node that may
also have content or children. Content and children always belong to that one
node even when a representation stores them in separate physical places.

A `Name` is one valid logical path component. Looking up successive names in
`children.members` produces every path below the root. A child set may declare
a schema shared by its members. A node whose children share such a schema can
be read as a collection. The schema defines member property and content
shapes, stable identity, logical naming, relationships, ordering, and
constraints.

A stable key identifies a member within the scope that declares the key;
`Name` is its current readable path component. A rename may change the name
without changing the stable key:

```ts
type NodeRef = {
  tree: TreeID;
  path: LogicalPath;
  stableKey: string | null;
};
```

`stableKey` is `null` or the canonical key JSON defined by
[locators](04-locators.md#2-stable-keys-revisions-and-fragments).

### Representations

The logical model does not prescribe how a placement supplies a child set.
Expanded files, a collection file, a database, or an external store may expose
the same logical members and schema. That choice is the child set's *backing*
at that placement; it does not become node identity or determine query and
transaction semantics.

Accepted Wire state separately records the exact authored representation needed
to reproduce the tree. Section 1 defines how those bytes are read and decoded;
[child backings](07-child-backings.md) defines how placement providers expose
and modify logical children.

## 1. Reading accepted tree state

> **Learning tip:** These routes read one accepted tree state at two levels.
> The tree resource identifies the current state; a snapshot and its objects
> carry the exact authored representation. Decoding those objects produces the
> logical model above. Provider-neutral sampled node reads are a local API, not
> a second portable tree representation.

### 1.1 Reading the current tree

```text
GET /.arbor/trees/{TreeID}
```

This is the tree resource itself: the small current-state read. Its supporting
values and response are:

```ts
type EventCursor = string;
type Hash = `sha256:${string}`;
type AccessLevel = "none" | "read" | "write";
type TreeKind = "ordinary" | "account-configuration";

type TreeDescriptor = {
  id: TreeID;
  kind: TreeKind;
  access: AccessLevel;
  canonical: {
    path: LogicalPath;
    endpoint: string;
    parentTree: TreeID | null;
  } | null;
};

type RemoteTreeDescriptor = TreeDescriptor & {
  root: Hash;
  update: string;
};

type CurrentTree = {
  tree: RemoteTreeDescriptor;
  observedThrough: EventCursor;
};
```

The descriptor's `root` is the bytes hash of the current accepted tree state
and `update` is the accepted-update id that produced it.
`observedThrough` is the cursor after which a client can begin watching without
a read/watch race. Ordinary hosted trees have complete canonical path,
endpoint, and parent-tree data. An authenticated account-configuration tree has
`kind: "account-configuration"` and `canonical: null`.

### 1.2 Reading a snapshot

```text
GET /.arbor/trees/{TreeID}/snapshot
```

A snapshot is the self-contained accepted-tree-state read: the transition from
nothing to the current root, so it carries only complete objects.

```ts
type ObjectEnvelope = { hash: Hash; bytes: string };

type CurrentTreeSnapshot = {
  tree: RemoteTreeDescriptor;
  root: Hash;
  objects: ObjectEnvelope[];
  observedThrough: EventCursor;
};
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
nested Arbor tree boundary by TreeID. `childrenSource`, when present, explains
how certain file entries supply the directory node's logical children; it is
not another Wire object variant.

#### 1.2.1 Canonical CBOR and hashes

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

### 1.3 Reading an object

```text
GET /.arbor/trees/{TreeID}/objects/{hash}
```

This route returns the same canonical CBOR bytes carried in an
`ObjectEnvelope`, but directly as the response body rather than wrapped in
JSON or base64. The hash is already present in the URL and is repeated as the
quoted ETag. The response uses `application/cbor` and immutable cache headers.
The response body must hash to the requested value.

Possession of a hash is not authorization: the object must be reachable from
the current readable root of the named tree. Retained accepted history does
not create historical-object access.

#### 1.3.1 When to fetch individual objects

A full replica that starts from a self-contained snapshot, retains its object
graph, and applies every contiguous watch transition does not normally call
this route. Snapshot plus watch is sufficient for that synchronization path.

Individual object reads serve clients that intentionally do not download or
retain the complete graph. A transient or sparse reader first obtains the
current root, fetches that directory object, and follows only the hashes needed
to resolve the requested path. A client may also refetch one missing or corrupt
current object instead of downloading a complete snapshot. Because objects are
immutable and addressed by their bytes, successful responses can be cached and
reused wherever that hash remains reachable and authorized.

This route is not an alternative observation stream or a historical-object
API. Authorization is checked against the named tree's current readable root.
If the tree advances during sparse traversal and a required object is no longer
reachable from current, the client abandons that traversal and starts again
from a new descriptor or snapshot. Likewise, a client missing a delta base
that is no longer current-reachable resynchronizes from a snapshot rather than
using this route to recover retained history.

A snapshot is the ordinary bootstrap and resynchronization read; the object
endpoint is useful for incremental graph traversal. All three read routes
require read access. The tree and snapshot responses are mutable observations
and therefore carry `observedThrough`; immutable object bytes do not need an
independent observation cursor.

### 1.4 Interpreting the object graph

A complete snapshot is valid only when `root` names a `WireDirectory` and
every hash reachable from that directory is present in `objects`, hash-valid,
canonically encoded, and decodable as a `WireObject`. A sparse reader performs
the same traversal but may obtain each reachable object through the individual
object endpoint.

Starting at the root, the receiver interprets the graph by path:

- A hash entry names a file or directory object at that entry's name.
- A file object supplies that path's exact authored bytes, which the directory
  projection interprets as the node's content.
- A directory object supplies one logical node. The
  [directory projection](03-directory-format.md) derives that node's
  properties, optional content, and ordinary expanded children from the
  directory and its entries.
- A TreeID entry marks a nested-tree boundary. The nested tree retains its own
  root, history, and access rather than becoming part of this object graph.

The resulting logical tree is derived from the object graph by deterministic
decoding and schema validation; it is not a second independently mutable copy.
The graph also preserves the authored representation needed to reproduce the
accepted state exactly. Placement-private paths, indexes, caches, readiness,
database pages, WAL files, and query plans are not accepted tree state.

Names reject NUL, slashes, backslashes, dot segments, non-NFC text, and
reserved ambiguity. Directory entries are canonically ordered. A complete
snapshot is invalid if a referenced object is missing, a hash or encoding is
wrong, or any object or directory entry is malformed.

#### 1.4.1 Collection-file interpretation

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

#### 1.5.3 Continuing identity

Identity asks whether two observations concern the same continuing tree or
node, not whether their present bytes or model state are equal. Two copies
refer to the same logical tree when they carry the same `TreeID`, even if they
have observed different revisions. Two references identify the same keyed
node when their TreeIDs, key-scope owners, and non-null keys agree. With a null
key, TreeID and current path establish identity.

The same tree or node can change both its representation hash and model hash
while retaining identity. Conversely, two different trees can happen to have
equal Wire roots or model hashes without becoming the same tree.

## 2. Updates and writes

> **Learning tip:** An update proposes a complete candidate state even when
> it transfers only a few changed objects. A complete object and an object
> delta are two ways to deliver those objects; neither changes the candidate's
> identity.

### 2.1 The update request

```text
POST /.arbor/trees/{TreeID}/updates
```

The client submits one complete candidate state, derived from an accepted
base it observed, together with which hash must still match for the
candidate to be accepted:

```ts
type ObjectDelta = {
  base: Hash;
  result: Hash;
  instructions: Array<
    | { copy: { offset: number; length: number } }
    | { insert: string }
  >;
};

type TransitionPayload = {
  objects: ObjectEnvelope[];
  deltas: ObjectDelta[];
};

type UpdateRequest = TransitionPayload & {
  base: string | null;
  candidate: Hash;
  ifMatch: "bytesHash" | "modelHash";
  onConflict?: "reject" | "merge";
};
```

An `ObjectDelta` names an available object as `base` and the object it will
produce as `result`. Its ordered instructions build the result's complete
canonical bytes: `copy` reuses a byte range from the base, while `insert`
supplies new bytes as canonical padded base64. The receiver applies the
instructions and requires the produced bytes to hash to `result`.

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

An update proposes a transition from the accepted base to the candidate root;
the authority accepts it, or merges and answers with the transition from the
candidate to what it accepted; watch ([§3](#3-watching))
delivers every accepted transition in order. One payload shape serves all
three.

`base` is the id of the retained accepted update the candidate was derived
from; the authority knows that update's root, so the pair binds reconciliation
to one accepted event even when the same root appears again later. A `null`
base activates a reserved tree ([accounts §6](05-accounts-and-devices.md#6-declaring-and-activating-a-tree))
with its complete initial snapshot and carries no deltas. `candidate`
names the exact Wire root encoding the desired complete candidate tree state.
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

### 2.3 The authority decision

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

The update-specific identities are distinct:

| Token | Identifies | Survives |
|---|---|---|
| accepted update `id` | one accepted transition of one tree | it is also that update's `tree.update` cursor |
| `requestDigest` | canonical `updates-v1` semantic intent | retransmission with different object/delta packaging |

`QueryCursor`, mutation identity, and query output identity are defined with
the executable operations that own them, not by tree storage or synchronization.

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

## 3. Watching

> **Learning tip:** Hashes compare states; cursors order observations. Start
> from the cursor returned by a coherent read, apply contiguous accepted
> transitions in order, and fetch a new snapshot whenever replay cannot bridge
> the gap.

### 3.1 The watch endpoint and event values

```text
GET /.arbor/trees/{TreeID}/watch?after={cursor}
```

The request carries `Accept: text/event-stream` and may carry `Last-Event-ID: {cursor}`.

The client reads the descriptor or a snapshot and then observes strictly after its
`observedThrough`. `after` and `Last-Event-ID` are equivalent; supplying both
with different values is `invalid-request`.

Every frame satisfies `id === data.cursor` and `event === data.kind`. Its JSON
body is:

```ts
type AcceptedTransition = TransitionPayload & {
  update: AcceptedUpdate;
  requestDigest?: Hash;
};

type TreeUpdateEvent = {
  cursor: EventCursor;
  tree: TreeID;
  kind: "tree.update";
  change: {
    descriptor: RemoteTreeDescriptor;
    transitions: AcceptedTransition[];
  };
};
```

The generic observation envelope is:

```ts
type ObservationEvent<TKind extends string, TChange> = {
  cursor: EventCursor;
  tree: TreeID;
  kind: TKind;
  change: TChange;
};
```

### 3.2 Observation cursors and the no-gap start

An observation cursor is an ordered position in a provider's committed-change
stream. Every read returns the cursor it observed through, and every
dependency is a provider, a cursor, and a precision scope
([child backings](07-child-backings.md#13-read-boundaries-and-committed-change-observation)).
Cursors are the only way to follow change; hashes never are.

`EventCursor` identifies only a position in one tree's observation stream. It
does not prove state equality and survives nothing: its purpose is ordering.

### 3.3 Applying and replaying accepted transitions

Accepted updates are ordered within their tree by their `id`, the observation
ordinal that recorded them; the same ordinal orders the combined observation
stream, so one counter yields update ids and event cursors. Initial accepted
updates have no transition.
Every later accepted update durably records one replay payload from its exact
`previousRoot` to `root`, regardless of whether the authority directly accepted,
merged, or restored that result.

The replay payload is a sparse proof of the target graph. `objects` contains
canonical target objects not reconstructed by a delta under the
[deltas](#26-sparse-transfer-with-object-deltas) rules. Submission and watch
share the `ObjectDelta` primitive, but not editor history: after validation and
any merge, the authority derives the transition from the actual accepted
endpoints, diffing every changed directory and file against its predecessor at
the same path.

Transition identity is the ordered accepted update and its previous/target
roots, not the selected byte encoding. Canopy may replace or pack physical
representations later without changing accepted history or observable Wire
semantics. Content-addressed objects and accepted roots remain canonical;
transition chains are replay acceleration and never the sole recovery source.

`transitions` is nonempty, chains exactly by root (each `previousRoot` is the
preceding `root`), and ends at `change.descriptor.update` and `change.descriptor.root`. The frame ID is
the final transition's update ID. Live delivery normally has one entry. Replay
groups consecutive retained accepted-update events into bounded batches without
crossing another observation event; it does not structurally simplify or
re-diff them. A client may apply a batch sequentially in memory and commit only
the final materialization.

For `tree.update`, a transition's `requestDigest` is present only when the stream
is authenticated by the exact bearer credential that submitted that accepted
request. It is correlation data, not authority.

### 3.4 Activation and resynchronization

A non-retained event cursor, a retained accepted update without a replay
payload, or a batch too old for retained transition data produces one terminal
`resync-required` event and closes. The client reads a new coherent snapshot
and resumes strictly after that snapshot's cursor.

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

### 3.5 Stream framing and errors

Tree watch and query result streams use one UTF-8 SSE framing rule: blank lines
separate frames, multiple `data:` lines join with newlines, and clients ignore
comments and keepalives. The `event` field names the typed event and `data` is
one canonical JSON value. Producers share escaping, cancellation,
bounded-buffer, and terminal-close behavior.

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
