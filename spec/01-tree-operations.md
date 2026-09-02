# Tree reads, writes, watching, and editor round trips
*Part of the [Arbor spec](../spec.md): the logical tree model and the canonical
operations that read, change, observe, and faithfully materialize it.*

*Owns: the global TreeID space; logical nodes and child sets; accepted state
and its canonical Wire encoding; tree reads, updates, transitions, replay,
streams, errors, and editor round trips; and the shared values those operations
use. Other documents define directory projection, locators, accounts, access,
child backings, executable documents, and authoring APIs.*

## 1. Tree reads: logical state and exact bytes

> **Learning tip:** Read Arbor at two levels. Logical nodes answer “what data is
> this?” Exact Wire bytes answer “what authored representation was accepted?”
> A child backing explains how one placement supplies a logical child set; it
> is neither the child set itself nor part of node identity.

### 1.1 The global TreeID space

Arbor is conceptually a global hash table of trees:

```ts
type Arbor = Map<TreeID, Tree>
```

A `TreeID` denotes the same logical tree and history wherever Arbor is implemented, but no server can enumerate every TreeID. Each device, community, and application sees only the partial map it can locate and read.

Copies with the same `TreeID` are placements or replicas of one tree, not new trees. They may temporarily observe different revisions while synchronization is unsettled. Local, private, unpublished, imported, and offline trees remain members of the conceptual map even when no public service can currently find them.

### 1.2 Trees and nodes

A tree is a rooted hierarchy of nodes:

```ts
interface Tree {
  root: Node
}

interface ChildSet {
  members: Map<Name, Node>
  schema?: ChildSchema
}

interface Node {
  properties: Record<string, Value>
  content?: Content
  children: ChildSet
}
```

`Name` is one valid logical path component. `ChildSchema` denotes the
validated schema meaning shared by a child set; its authored and Wire forms are
defined by [child backings](07-child-backings.md) and this document's Wire
encoding,
not by this conceptual shape.

A tree also has independent history, a synchronization stream, and a whole-tree permission boundary.

The root node has logical path `/`. Looking up successive names in
`children.members`
produces every other logical path.

The child set, rather than the node as an undifferentiated whole, owns any
schema shared by its members. That schema defines the members' property and
content shapes, stable-key rule, logical-name rule, relationships, ordering,
and constraints. A stable key identifies one member within its declaring child
set while `Name` is its current readable path component; a rename may change
the latter without changing the former.

Arbor trees can be mounted inside other arbor trees, but they remain a separate entry in the global TreeID map. A placement may present it below a node in another tree, but its
nodes, history, access, and mutations are not copied into that parent.

### 1.3 One node shape for every kind of data

A node has three parts: properties, optional content, and children. Arbor has
no second shape for records, tables, files, or documents. Each of those is a
way of reading the same three parts, and one node can be read several ways at
once.

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
frontmatter is a document and a record. A folder of such pages that share a
schema is a directory and a collection, and each page in it is a row that
still has a body and may have children of its own. Inserting a database row
creates a child node, updating a column changes that child's properties, and
deleting the row removes the child; nothing about the row stops it from also
being a document.

Content and children belong to one node. There is no separate "page" that
owns the content and "folder" that owns the children; a representation may
store them in two places, as the [directory format](03-directory-format.md#2-mapping-files-and-directories-to-nodes)
does with `_index.md` inside a directory or a file beside it, but the model
sees one node.

Because the readings are defined on the model, the backing is free to vary,
and several backings of the same nodes may exist at once. The same
schema-governed child set may use expanded Markdown files, one collection file
(`_store.csv`, `_store.json`, or `_store.jsonl`), a SQLite database, or a
Postgres database. A Canopy may read it from Postgres while a laptop keeps
a SQLite projection for offline use. A query or link that addresses the nodes
does not change when their backing does ([child backings](07-child-backings.md)). A file named
`something.json` is a content node; only the reserved `_store.json` name is a
collection file.

A child schema is what turns a child set into a collection. It declares member
property and content types, the stable-key rule that gives each child its
identity, the logical-name rule used by compact backings, allowed child shapes
and discriminated unions, references and relationships, uniqueness, ordering,
and foreign-key behavior. A development
compiler can read the schema at a literal Arbor location and generate types
from it rather than inferring them from sample values.

**Child set** is the logical term. **Backing** describes how a placement
supplies it: expanded files, a collection file, a database, or an external
store. **Collection file** is the narrow exact-source CSV/JSON/JSONL form used
by the Wire. SQLite is a database backing, not a collection file. Backing
metadata is observational capability information and never becomes node
identity.

| Layer | Term | Example | What it identifies |
|---|---|---|---|
| Logical model | child set | the members and shared schema below `/books` | model state, independent of storage |
| Placement | child backing | expanded files, collection file, database, external store | how one placement supplies the child set |
| Accepted encoding | physical Wire entries | `_store.json` and `schema.ts` file objects | exact authored bytes and reachability |
| Wire interpretation | collection-file descriptor | `childrenSource` on the directory object | how those physical entries decode as one child set |

### 1.4 Change and equivalence

Section 3 separated the model from its representations. That separation
means there are two different questions a reader can ask about change, and a
third about time. Arbor answers each with one token and never blurs them.

#### 1.4.1 Did the bytes change? The bytes hash

A bytes hash is the hash of a representation's exact bytes, which the
directory format calls authored source. The wire encodes
an accepted tree state as a graph of wire objects, one per file and
directory, each addressed by the hash of its bytes; the hash of the top
directory object is the wire root, and it identifies one whole snapshot. A
file's bytes have a bytes hash in the same way. It exists only where
bytes exist. Reformatting a
CSV, reordering frontmatter keys, or re-encoding a directory changes it even
though nothing in the model moved. Its job is compare-and-swap for byte-level
synchronization and proof that authored source is untouched.

#### 1.4.2 Did the data change? The model hash

A model hash is the hash of model state: the canonical CBOR of a node's
properties, content, and child set, including the child schema and the model
hashes of its members. It is defined
for every node, and a provider computes it wherever it can. Two
representations of one model state have different bytes hashes and the
same model hash; that is why the wire root is not a logical hash. Its job is
proof of equality: skipping work, showing that a reformat or migration
preserved the data, and defining equivalence. A database row's model hash is
cheap, so it is what a row write must match. A live database does not
maintain a model hash for a whole table, and says so by returning a cursor
instead.

#### 1.4.3 What changed since I looked? The observation cursor

An observation cursor is an ordered position in a provider's committed-change
stream. Every read returns the cursor it observed through, and every
dependency is a provider, a cursor, and a precision scope
([child backings](07-child-backings.md#13-read-boundaries-and-committed-change-observation)).
Cursors are the only way to follow change; hashes never are.

#### 1.4.4 Which one a write names

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

#### 1.4.5 When two things are the same

- **Identity.** Two copies are the same logical tree when they have the same
  `TreeID`, even if their observed revisions have not settled. Two references
  identify the same keyed node when their TreeIDs, key-scope owners, and
  non-null keys agree. With a null key, TreeID and current path establish
  identity.
- **Model.** Two tree states, or two representations after decoding, are
  model-equivalent over a declared scope when their model hashes agree:
  their nodes have the same identities, properties, content, child
  membership, and schemas after schema-declared normalization. Expanded
  Markdown records, JSON, SQLite, and Postgres may therefore be equivalent
  representations of one collection even though none is the canonical
  serialization of the others.

### 1.5 Accepted state and canonical Wire encoding

An accepted tree state contains the logical model plus the tree-owned authored
representation fidelity required to reproduce that state faithfully. The
logical model is derived from the accepted representation by deterministic
decoding and schema validation; it is not a second independently mutable copy.
Placement-private paths, indexes, caches, readiness, database pages, WAL files,
and query plans are not accepted tree state.

The canonical lossless Wire encoding of one immutable accepted state names a
root directory object. This directory-shaped graph is an encoding of the model
and its authored fidelity, not another logical ontology and not a requirement
that every backing be directory-shaped. All objects are canonical CBOR
addressed by `sha256:<lowercase-hex>` of their exact bytes.

The Wire root is therefore a bytes hash. Per-node model hashes and
collection-file child-set hashes are derived logical equality proofs. A
formatting-only edit can change the Wire root while leaving every affected
logical hash unchanged.

#### 1.5.1 Physical entries and child-set interpretation

Physical authored entries and their logical interpretation are separate:

```ts
type WireFile = {
  type: "file";
  bytes: Uint8Array;
};

type WireDirectoryEntry =
  | { name: Name; hash: Hash }
  | { name: Name; tree: TreeID };

type CollectionFileDescriptor = {
  version: 1;
  type: "collection-file";
  format: "csv" | "json" | "jsonl";
  source: "_store.csv" | "_store.json" | "_store.jsonl";
  schemaSource: "schema.ts";
  schemaFingerprint: Hash;
  childSetHash: Hash;
};

type WireDirectory = {
  type: "directory";
  entries: WireDirectoryEntry[];
  childrenSource?: CollectionFileDescriptor;
};
```

Every declared source names an ordinary file entry in the same directory
object. Its entry hash makes the exact authored bytes reachable and
materializable. `source` must agree with `format`, and `schemaSource` names the
exact schema source. These reserved files are physical entries but are not
logical children.

A directory without `childrenSource` derives expanded logical children from
its entries under the [directory projection](03-directory-format.md). A
directory with a collection-file source derives its complete logical child set
from that source. It may otherwise contain only the enclosing node's body and
the descriptor's declared representation files; mixing collection-file rows
with another immediate-child backing is invalid.

The authority executes `schema.ts` through the same restricted application-code
runtime used locally, recomputes `schemaFingerprint`, and never trusts
client-asserted compiled metadata. It validates and normalizes every row,
derives its stable key and logical name through the schema's `childName` rule,
and recomputes `childSetHash` over stable-key-ordered
`{ key, name, properties }` entries. A mismatch is invalid. `childSetHash` is
the logical contribution of the complete child set, not the enclosing node's
model hash. The enclosing node's model hash combines its properties and
content with its child schema and child set.

Names reject NUL, slashes, backslashes, dot segments, non-NFC text, and
reserved ambiguity. Directory entries are canonically ordered; decoders reject
noncanonical encodings, missing or multiply claimed source entries, and hash
mismatches.

Database placements may expose the same logical subtree, but they do not use
the collection-file encoding. Wire database synchronization names committed
logical changes and, when required for resync, a content-addressed canonical
logical checkpoint produced at one database snapshot. Such a checkpoint is an
explicit synchronization artifact, not what an ordinary read matches on, and
contains no SQLite pages/WAL bytes or Postgres storage representation. Its
change-log/checkpoint format is deferred ([deferred 5](../spec.md#deferred)).

#### 1.5.2 Canonical encoding and hashes

Arbor has one canonical CBOR rule. The permitted subset is: `null`; booleans;
integers in the safe 53-bit range as CBOR integers with minimal-length heads;
every other finite number as a 64-bit float; UTF-8 text; byte strings; arrays;
and maps whose keys are text, unique, and ordered by the bytes of their encoded
form. Non-finite numbers, indefinite lengths, tags, and non-text keys are
invalid.

Object hashes, the `updates-v1` and `mutate-v1` semantic digests, query output
hashes, collection-file `childSetHash` values, and schema fingerprints are all
`sha256:` of this encoding of the identified value; nothing on the Wire is
identified by canonical JSON text. The
[`canonical-cbor-values`](../conformance/canonical-cbor-values.json) vectors
freeze valid encodings and rejected byte sequences for every language binding.

Authorities advertise collection-file, schema, and row quotas and never
accept a collection file they cannot validate completely. Semantic merge
reports `collection-file-row-conflict`, `collection-file-schema-conflict`, or
`collection-file-constraint-conflict`; a row conflict path uses the parent
logical path plus its `arbor-key` identity suffix. Database backings do not use
this exact-source descriptor and their live storage bytes are never accepted
as Wire objects.

### 1.6 Shared foundation values

These transport-neutral values are shared by every route. Language bindings must be
equivalent and consume the language-neutral vectors under
[`conformance`](../conformance).

```ts
type TreeID = string;
type LogicalPath = string;
type EventCursor = string;
type Hash = `sha256:${string}`;
type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [name: string]: JSONValue };
type Diagnostic = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  path?: LogicalPath;
  row?: number;
  field?: string;
};
type AccessLevel = "none" | "read" | "write";
type ReadWriteAccess = "read" | "write";

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

type NodeRef = {
  tree: TreeID;
  path: LogicalPath;
  stableKey: string | null;
};

type LocatorResolution = {
  ref: NodeRef;
  enclosingTree: TreeDescriptor;
  historical: boolean;
  observedThrough: EventCursor;
};

type ArborError<TDetails = unknown> = {
  error: string;
  message: string;
  retryable: boolean;
  tree?: TreeID;
  path?: LogicalPath;
  details?: TDetails;
};

type ObservationEvent<TKind extends string, TChange> = {
  cursor: EventCursor;
  tree: TreeID;
  kind: TKind;
  change: TChange;
};
```

`NodeRef` is the sole tree/path/identity carrier: `stableKey` is
`null` or the canonical key JSON defined by
[locators](04-locators.md#2-stable-keys-revisions-and-fragments). The
node-sampling values built on `NodeRef` (`NodeSummary`, `NodeSnapshot`,
`ChildrenPage`, and their capabilities) are not wire operations; the reference
local API documents them in
[docs/arborsync-api.md](../docs/arborsync-api.md#5-model-sampling-values).

New tree IDs are `tr_` plus 26 lowercase base32 characters encoding 128 random
bits. New device IDs use the same encoding after `dv_`. Existing shorter IDs
may remain valid during migration, but activation and pairing require the new
form. Generating an ID neither reserves it nor contacts the server.

Server resolution always supplies `enclosingTree`. Ordinary hosted trees
have complete non-null canonical data: the decoded canonical `path`, the
tree-scoped `endpoint` (`{origin}/.arbor/trees/{TreeID}`), and the enclosing
`parentTree`. The tree's public HTTP URL and `arbor://` locator are not carried
on the wire; clients derive them as the endpoint's origin (respectively its
host) followed by the canonical path percent-encoded segment by segment. The
authenticated account-configuration tree is returned only to its account and
has `kind: "account-configuration"` and `canonical: null`.

Every tree operation, result, event, effect, and relevant error names its `TreeID`. `local` and `system` are not wire values. Writability is derived from effective access and historical state.

The wire's own tokens, and what each survives:

| Token | Identifies | Minted by | Survives |
|---|---|---|---|
| wire root and object hashes | one exact encoded snapshot or object; the tree's bytes hashes ([§1.4.1](#141-did-the-bytes-change-the-bytes-hash)) | hashing canonical CBOR bytes | nothing that changes a byte |
| accepted update `id` | one accepted transition of one tree | the server's observation ordinal | it is that update's `tree.update` cursor by construction |
| `EventCursor` | a position in one tree's observation stream | the server | nothing; it only orders |
| `QueryCursor` | a position in a host's derived-query observation domain | the host | nothing; it only orders |
| `requestDigest` | the semantic intent of one update or mutation | canonical CBOR of `updates-v1` or `mutate-v1` | retransmission with different objects or deltas |
| `mutationID` | one caller's mutation attempt | the caller | exact retries; reuse with a different digest conflicts |
| `outputHash` | one complete public query result | canonical CBOR of the result | provider or plan changes that leave the result identical |

### 1.7 A server and its trees

Synchronization transports observations and changes of the
[model](#12-trees-and-nodes). Its
envelopes may include access, capabilities, materialization state,
diagnostics, cursors, bytes hashes, and transport hints that are
not stored model properties.

The operations have distinct relationships to the model:

- `GET /.arbor/trees/{TreeID}` observes the current accepted tree state,
  while `snapshot` and `objects` transfer its deterministic lossless encoding;
- `updates` proposes a complete candidate tree state through that encoding;
- `watch` monitors ordered accepted tree-state transitions with replay;
- `queries` derives current typed values from any reviewed logical nodes; and
- `mutate` executes reviewed transactional model intent.

The synchronized root is a [bytes hash](01-tree-operations.md#14-change-and-equivalence):
it identifies the exact Wire encoding of one accepted tree state and serves as
its compare-and-swap key. Different roots may decode to model-equivalent trees
when authored representation details differ.

An Arbor server represents one community. It owns accounts and profile
claims, canonical tree boundaries, the private account-configuration trees,
credential bindings, access enforcement, one mutable accepted root per tree,
immutable objects, and observation streams. It need not implement a local
placement, filesystem replica, or UI. Because it accepts complete candidate
states and merges them itself, it is more than a content-addressed store. It
implements:

- the content-addressed object store, one compare-and-swap root per tree, and
  the ordered observation log with watch replay ([§1.8](#18-reading-a-tree), [§3](#3-watching));
- the merge of disjoint nodes under `ifMatch: "modelHash"`, and the
  `markdown-additive-v1` merge rule for two edits to one Markdown node
  ([§2.2](#22-updating-a-tree));
- collection-file decoding, the `collection-file-rows-v1` merge rule, and a
  restricted runtime that executes `schema.ts` to recompute schema
  fingerprints and child-set hashes
  ([accepted state and Wire](#15-accepted-state-and-canonical-wire-encoding));
- the `account-config-v1` merge rule and the governed configuration tree
  ([accounts §6](05-accounts-and-devices.md#6-governed-account-tree));
- profile claims, device pairing, access evaluation, and the public HTTP
  projection ([accounts §1.1](05-accounts-and-devices.md#11-profile-claim), [accounts §4](05-accounts-and-devices.md#4-device-pairing), [access control §1](06-access-control.md#1-subjects-and-rules), [locators §6](04-locators.md#6-public-http-projection)).

Hosting executable documents ([executable documents §12](08-executable-documents.md#12-wire-operations))
is optional; a server without that runtime answers those routes with `422 unsupported-operation`.

| Operation | Purpose | Durable effect | Replay boundary |
|---|---|---|---|
| descriptor, `snapshot`, `objects` | Read one accepted tree state | None | `observedThrough` starts a watch without a read/watch gap |
| `updates` | Propose a transition to a candidate state, matching on its bytes hash or its model hashes, or activate a reserved tree with a null base | May append one accepted update | Semantic request identity recovers an ambiguous result; a merged result carries the transition back |
| `watch` | Follow ordered accepted transitions | None | An event cursor resumes retained observation history |

The deterministic lossless graph is both the synchronization representation
and the faithful roundtrip encoding of accepted tree state. The server accepts
complete candidate states rather than imperative edit commands; only accepted,
merged, or restored states enter its ordered history. Identity, bootstrap,
governed configuration, activation, and access management use these same
primitives; [accounts and devices](05-accounts-and-devices.md) and
[access control](06-access-control.md) describe them.

### 1.8 Reading a tree

```text
GET /.arbor/trees/{TreeID}
GET /.arbor/trees/{TreeID}/snapshot
GET /.arbor/trees/{TreeID}/objects/{hash}
```

`GET /.arbor/trees/{TreeID}` is the tree resource itself: the small
current-state read. It returns:

```ts
type CurrentTree = {
  tree: RemoteTreeDescriptor;
  observedThrough: EventCursor;
};
```

The descriptor's `root` is the bytes hash of the current accepted tree state
and `update` is the accepted-update id that produced it.
`observedThrough` is the cursor after which a client can begin watching without
a read/watch race.

`GET .../snapshot` is the self-contained accepted-tree-state read: the
transition from nothing to the current root, so it carries only complete
objects.

```ts
type ObjectEnvelope = { hash: Hash; bytes: string };

type CurrentTreeSnapshot = {
  tree: RemoteTreeDescriptor;
  root: Hash;
  objects: ObjectEnvelope[];
  observedThrough: EventCursor;
};
```

Object bytes in JSON use canonical padded base64. The server captures one
accepted update and returns the complete graph for that update even if a newer
update is accepted while the response is being encoded. The response therefore
satisfies `tree.root === root`; it is an atomic current-state read, not an
accepted-history query.

`GET .../objects/{hash}` returns the exact canonical CBOR bytes for one
immutable component of the lossless Wire encoding. It uses
`application/cbor`, an ETag equal to the quoted hash, and immutable
cache headers. Possession of a hash is not authorization: the object must be
reachable from the current readable root of the named tree. Retained accepted
history does not create historical-object access. A snapshot is the ordinary
bootstrap and resynchronization read; the object endpoint is useful for
incremental graph traversal.

All three routes require read access. The descriptor and snapshot responses
are mutable observations and therefore carry `observedThrough`; immutable
object bytes do not need an independent observation cursor.

## 2. Updates and writes

> **Learning tip:** An update proposes a complete candidate state, even when it
> transfers only changed objects. `ifMatch: "modelHash"` still means the model
> hash of each complete touched logical node. A collection file's
> `childSetHash` is narrower: it proves only the decoded child-set contribution
> inside such a node, so the two names must not be interchanged.

### 2.1 Deltas

A transition transfers the content-addressed graph sparsely. Each changed
object travels either as its complete canonical bytes or as a delta against an
object reachable in the relevant basis graph:

| Representation | Update submission | Accepted transition | Intended use |
|---|---|---|---|
| `ObjectEnvelope` | Yes | Yes | New objects, or whenever complete canonical bytes are smallest |
| `ObjectDelta` | Yes | Yes | Any changed file or directory whose predecessor shares most of its bytes |

```ts
type ObjectDelta = {
  base: Hash;
  result: Hash;
  instructions: Array<
    | { copy: { offset: number; length: number } }
    | { insert: string }
  >;
};
```

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

### 2.2 Updating a tree

```text
POST /.arbor/trees/{TreeID}/updates
```

#### 2.2.1 Request

The client submits one complete candidate state, derived from an accepted
base it observed, together with which hash must still match for the
candidate to be accepted:

```ts
type TransitionPayload = {
  objects: ObjectEnvelope[];
  deltas?: ObjectDelta[];
};

type UpdateRequest = TransitionPayload & {
  base: string | null;
  candidate: Hash;
  ifMatch: "bytesHash" | "modelHash";
  onConflict?: "reject" | "merge";
};
```

An update proposes a transition from the accepted base to the candidate root;
the authority accepts it, or merges and answers with the transition from the
candidate to what it accepted; watch ([§3](#3-watching))
delivers every accepted transition in order. One payload shape serves all
three.

`base` is the id of the retained accepted update the candidate was derived
from; the authority knows that update's root, so the pair binds reconciliation
to one accepted event even when the same root appears again later. A `null`
base activates a reserved tree ([accounts §5](05-accounts-and-devices.md#5-declaring-and-activating-a-tree))
with its complete initial snapshot and carries no deltas. `candidate`
names the exact Wire root encoding the desired complete candidate tree state.
The authority decodes and validates its modeled state and all
projection-specific fidelity required by that encoding. `objects` supplies
canonical CBOR objects the server does not already retain; a client normally
walks base and candidate together and omits unchanged objects. The candidate
must still be complete and provable from retained base objects, supplied
objects, and valid `deltas`. The
[deltas](#21-deltas)
rules define those interchangeable representations; they do not change the
candidate's identity.

`ifMatch` names which hash of the [model](#14-change-and-equivalence)
must still match its value at base for the candidate to be accepted; `base`
supplies the values, as an ETag does for HTTP `If-Match`:

- `bytesHash`: the tree's bytes hash must still match, so current must still
  equal base. Any other change is a conflict and is always rejected; matching
  on bytes means "exactly what I saw", so a merge would contradict it.
  Activation uses it, and so does any tool that must replace the tree's exact
  state.
- `modelHash`: the model hash of each node the candidate changed must still
  match. The authority takes every node whose bytes differ between base and
  candidate, the candidate's *touched* nodes, and checks that each has the
  same model hash in current as it had at base. Nodes that current has reformatted without
  changing their model do not conflict, and neither does anything current
  changed elsewhere. `onConflict`, which defaults to `merge`, says what to do
  when a touched node's model did change in current: `reject` the candidate,
  or resolve each conflicting node with the representation's merge rule.

#### 2.2.2 Authority decision

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
`collection-file-rows-v1` for a collection file, and `account-config-v1` for
the governed configuration tree. A node
with no merge rule, or one the rule cannot combine, is a conflict.

#### 2.2.3 Results, reconciliation, and retry

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
  | { version: "account-config-v1"; mergedFields: number }
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
`update.root` under the [deltas](#21-deltas) rules, so
a superseded, merged, or replayed result is applied with the same code that
applies a watch frame. An accepted candidate returns none.

A conflict uses the shared `ArborError` envelope with
`details.kind: "server-update" | "account-configuration"`. Its details include the current `AcceptedUpdate`, the base and candidate
roots, structured conflict reasons naming each conflicting node, and `draft`,
the transition from the candidate root to the draft root the client keeps.

Semantic request identity is the SHA-256 of the
[canonical CBOR encoding](#152-canonical-encoding-and-hashes)
of `{ version: "updates-v1", tree, base, candidate, ifMatch, onConflict }`,
with `onConflict` as its effective value, scoped to the
authenticated credential. `objects`, `deltas`, and their ordering are
transport choices and are excluded. An ambiguous retry may therefore replace a
delta with complete bytes without changing identity. Exact accepted or merged
replay returns the original result and creates no duplicate accepted update.
Clients durably retain the base, candidate, required content, and any conflict
draft until the result has been applied.

#### 2.2.4 Collection files in a candidate

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

## 3. Watching

> **Learning tip:** Hashes compare state; cursors follow time. Begin a watch
> strictly after the `observedThrough` returned by a coherent read. If replay
> can no longer bridge that cursor, fetch a fresh snapshot and resume from its
> observation boundary.

### 3.1 Watching a tree

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

Accepted updates are ordered within their tree by their `id`, the observation
ordinal that recorded them; the same ordinal orders the combined observation
stream, so one counter yields update ids and event cursors. Initial accepted
updates have no transition.
Every later accepted update durably records one replay payload from its exact
`previousRoot` to `root`, regardless of whether the authority directly accepted,
merged, or restored that result.

The replay payload is a sparse proof of the target graph. `objects` contains
canonical target objects not reconstructed by a delta under the
[deltas](#21-deltas) rules. Submission and watch
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
request. It is correlation data, not authority. A non-retained event cursor, a
retained accepted update without a replay payload, or a batch too old for
retained transition data produces one terminal `resync-required` event and
closes; the client reads a new snapshot and resumes after its cursor.

`tree.activation` is the one observation kind that is not an accepted update. When a tree declared in
`trees.yaml` becomes active ([accounts §5](05-accounts-and-devices.md#5-declaring-and-activating-a-tree)), the
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

### 3.2 Streams and errors

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

> **Learning tip:** Make the edit durable locally before sending it. The update
> response and matching watch event may race, so clients apply both
> idempotently and clear their durable attempt only after the accepted graph is
> materialized. Editor history is local; accepted transitions describe tree
> state, not keystrokes.

### 4.1 Example: editor edit roundtrip

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
