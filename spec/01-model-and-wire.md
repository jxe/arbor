# Arbor model and Wire encoding
*Part of the [Arbor spec](../spec.md): the global TreeID space, trees, nodes,
structured data, projections, and equivalence.*

*Owns: the TreeID space, logical nodes and child sets, change and equivalence,
accepted tree state, its canonical Wire encoding, and the values every route
shares. References: [synchronization](02-synchronization.md) for how accepted
tree state moves.*

## 1. The global TreeID space

Arbor is conceptually a global hash table of trees:

```ts
type Arbor = Map<TreeID, Tree>
```

A `TreeID` denotes the same logical tree and history wherever Arbor is implemented, but no server can enumerate every TreeID. Each device, community, and application sees only the partial map it can locate and read.

Copies with the same `TreeID` are placements or replicas of one tree, not new trees. They may temporarily observe different revisions while synchronization is unsettled. Local, private, unpublished, imported, and offline trees remain members of the conceptual map even when no public service can currently find them.

## 2. Trees and nodes

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

## 3. One node shape for every kind of data

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

## 4. Change and equivalence

Section 3 separated the model from its representations. That separation
means there are two different questions a reader can ask about change, and a
third about time. Arbor answers each with one token and never blurs them.

### 4.1 Did the bytes change? The bytes hash

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

### 4.2 Did the data change? The model hash

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

### 4.3 What changed since I looked? The observation cursor

An observation cursor is an ordered position in a provider's committed-change
stream. Every read returns the cursor it observed through, and every
dependency is a provider, a cursor, and a precision scope
([child backings](07-child-backings.md#13-read-boundaries-and-committed-change-observation)).
Cursors are the only way to follow change; hashes never are.

### 4.4 Which one a write names

A write says what must still match: the bytes hash it saw, or the model hash
of each node it changed. The authority rejects a write whose match fails,
unless the write allows a same-node conflict to be resolved by that
representation's merge rule
([synchronization §3](02-synchronization.md#3-updating-a-tree)). A claim of equality
uses whichever level the claim is about. Invalidation uses cursors, narrowed
by precision.

A node's properties are one map however they are edited: a property write
replaces the complete map under the match it names, cannot change the
property selected by the applicable identity declaration, and leaves content
and children alone.

### 4.5 When two things are the same

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

## 5. Accepted state and canonical Wire encoding

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

### 5.1 Physical entries and child-set interpretation

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

### 5.2 Canonical encoding and hashes

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

### 5.3 Deltas

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

## 6. Shared values

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
| wire root and object hashes | one exact encoded snapshot or object; the tree's bytes hashes ([§4.1](#41-did-the-bytes-change-the-bytes-hash)) | hashing canonical CBOR bytes | nothing that changes a byte |
| accepted update `id` | one accepted transition of one tree | the server's observation ordinal | it is that update's `tree.update` cursor by construction |
| `EventCursor` | a position in one tree's observation stream | the server | nothing; it only orders |
| `QueryCursor` | a position in a host's derived-query observation domain | the host | nothing; it only orders |
| `requestDigest` | the semantic intent of one update or mutation | canonical CBOR of `updates-v1` or `mutate-v1` | retransmission with different objects or deltas |
| `mutationID` | one caller's mutation attempt | the caller | exact retries; reuse with a different digest conflicts |
| `outputHash` | one complete public query result | canonical CBOR of the result | provider or plan changes that leave the result identical |
