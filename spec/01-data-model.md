# Arbor data model
*Part of the [Arbor spec](../spec.md): the global TreeID space, trees, nodes,
structured data, projections, and equivalence.*

*Owns: the TreeID space, nodes, canonical lookup, change and equivalence, the canonical encoding of a tree, and the values every route shares. References: [synchronization](02-synchronization.md) for how tree state moves.*

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

interface Node {
  properties: Record<string, Value>
  content?: Content
  children: Map<Name, Node>
  schema?: Schema
}
```

A tree also has independent history, a synchronization stream, and a whole-tree permission boundary.

The root node has logical path `/`. Looking up successive names in `children`
produces every other logical path.

Arbor trees can be mounted inside other arbor trees, but they remain a separate entry in the global TreeID map. A placement may present it below a node in another tree, but its
nodes, history, access, and mutations are not copied into that parent.

## 3. Canonical URL lookup

Canonical URLs are a secondary index over the TreeID map:

```ts
type CanonicalURLs = Map<`${DNSName}${PathPrefix}`, TreeID>
```

The DNS-name portion specifies a Canopy server on the network. The path-prefix portion specifies a tree served by that Canopy. Resolving a canonical URL first uses its DNS authority to reach the Canopy, then selects the longest readable registered boundary there, as specified by [the wire](04-locators.md#5-finding-trees). The result is that boundary's TreeID plus the remaining logical path and optional stable key, still in the uniform `(TreeID, path, key)` shape.

Normal DNS and HTTPS establish how the Canopy is reached.

URL nesting does not imply common storage, history, ownership, or access. If one tree is canonical at `/~alice` and another at `/~alice/atlas`, the latter boundary wins for URLs beneath it.

Canonical placement is mutable naming at both levels. Replacing the DNS name of a Canopy placement, moving a tree boundary within that Canopy, or renaming a node changes canonical URLs without changing TreeID or stable key. Moving the physical server behind an unchanged DNS origin changes neither. A raw `arbor://<TreeID>/...` locator addresses the primary namespace when a canonical name is absent, unknown, inaccessible, or changing.

## 4. One node shape for every kind of data

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

Because the readings are defined on the model, the representation is free to
vary, and several representations of the same nodes may exist at once. The
same schema-governed children may be expanded Markdown files, one
`_store.csv`, `_store.json`, or `_store.jsonl`, a SQLite table, or a Postgres
relation, and a Canopy may read them from Postgres while a laptop keeps a
SQLite copy for offline use. A query or link that addresses the nodes does not
change when their representation does ([stores](07-stores.md)). A file named
`something.json` is a content node; only the reserved `_store.json` name means
"these are the collection's children".

A schema is what turns a set of children into a collection. It declares
property and content types, the stable-key rule that gives each child its
identity, allowed child shapes and discriminated unions, references and
relationships, uniqueness, ordering, and foreign-key behavior. A development
compiler can read the schema at a literal Arbor location and generate types
from it rather than inferring them from sample values.

## 5. Change and equivalence

Section 4 separated the model from its representations. That separation
means there are two different questions a reader can ask about change, and a
third about time. Arbor answers each with one token and never blurs them.

### 5.1 Did the bytes change? The bytes hash

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

### 5.2 Did the data change? The model hash

A model hash is the hash of model state: the canonical CBOR of a node's
schema, properties, content, and the digests of its children. It is defined
for every node, and a provider computes it wherever it can. Two
representations of one model state have different bytes hashes and the
same model hash; that is why the wire root is not a logical hash. Its job is
proof of equality: skipping work, showing that a reformat or migration
preserved the data, and defining equivalence. A database row's model hash is
cheap, so it is what a row write must match. A live database does not
maintain a model hash for a whole table, and says so by returning a cursor
instead.

### 5.3 What changed since I looked? The observation cursor

An observation cursor is an ordered position in a provider's committed-change
stream. Every read returns the cursor it observed through, and every
dependency is a provider, a cursor, and a precision scope
([stores](07-stores.md#13-read-boundaries-and-committed-change-observation)).
Cursors are the only way to follow change; hashes never are.

### 5.4 Which one a write names

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

### 5.5 When two things are the same

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

## 6. The canonical encoding of a tree

The current canonical lossless Wire encoding of an immutable tree snapshot
names a root directory object. This directory-shaped object graph is a
synchronization encoding of accepted tree state, not Arbor's logical node
ontology and not a requirement that every backing be physically directory
shaped. All objects are canonical CBOR addressed by
`sha256:<lowercase-hex>` of their exact bytes. Directories map normalized UTF-8
names to file, directory, nested-tree, or versioned rollup entries. Files
contain exact bytes and media metadata. A rollup entry references its exact
source object, schema fingerprint, provider scope, and authority-derived
logical child/subtree root:

```ts
type RollupDescriptor = {
  version: 1;
  codec: "csv" | "json" | "jsonl";
  source: Hash;
  schemaSource: Hash;
  schema: Hash;
  scope: "children" | "subtree";
  modelHash: Hash;
};
```

`schemaSource` references the exact `schema.ts` file object. The authority
executes that source through the same restricted application-code runtime used
locally, recomputes `schema`, and never trusts client-asserted compiled
metadata. Schema execution shares the future isolation boundary with SSR,
queries, mutations, and executable documents; it does not require a second
authored schema. The descriptor lets remote resolution, paging, querying, search, and semantic
merge address rolled-up children without converting them into Markdown files
or making the reserved source file a visible row. A decoder recomputes `schema` and `modelHash` from `source`; a mismatch is
invalid. `modelHash` is the collection node's
[model hash](#5-change-and-equivalence), computed over its
schema-normalized rows in stable-key order as `{ key, path, properties }`
entries. Names reject NUL,
slashes, backslashes, dot segments, non-NFC text, and reserved ambiguity.
Directory entries are canonically ordered; decoders reject noncanonical
encodings and hash mismatches.

Arbor has one canonical encoding and one hash rule. The canonical CBOR subset
is: `null`; booleans; integers in the safe 53-bit range as CBOR integers with
minimal-length heads; every other finite number as a 64-bit float; UTF-8 text;
byte strings; arrays; and maps whose keys are text, unique, and ordered by the
bytes of their encoded form. Non-finite numbers, indefinite lengths, tags, and
non-text keys are invalid. Object hashes, the `updates-v1` and `mutate-v1`
semantic digests, query output hashes, rollup `modelHash` values, and schema
fingerprints are all `sha256:` of this encoding of the identified value;
nothing on the wire is identified by a canonical JSON text. The
[`canonical-cbor-values`](../conformance/canonical-cbor-values.json) vectors
freeze valid encodings and rejected byte sequences for every language binding.

Authorities advertise their rollup, schema, and row quotas and never accept a
rollup they cannot validate completely; the reference quotas are recorded in
[the reference implementation](../docs/reference-implementation.md#wire-encoding-reconciliation-and-hosting). Semantic merge reports `rollup-row-conflict`,
`rollup-schema-conflict`, or `rollup-constraint-conflict`; a row conflict path
uses the parent logical path plus its `arbor-key` identity suffix.

Database placements may expose the same logical subtree, but they do not use
this exact-source descriptor. Wire database synchronization names committed
logical changes and, when required for resync, a content-addressed canonical
logical checkpoint produced at one database snapshot. Such a checkpoint is an
explicit synchronization artifact, not what an ordinary read matches on, and
contains no SQLite pages/WAL bytes or Postgres storage representation. Its
change-log/checkpoint format is deferred ([deferred 5](../spec.md#deferred)).

### 6.1 Deltas

A transition ([synchronization](02-synchronization.md)) transfers the
content-addressed graph sparsely. Each changed object travels either as its
complete canonical bytes or as a delta against an object that is reachable in
the relevant basis graph:

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
one-entry change to a large directory or a one-paragraph change to a large
file costs a few instructions instead of the whole object, and a moved region
is a copy rather than a retransmission.

A file object's canonical encoding carries its payload length, so a sender
deriving a delta from editor edits inserts the result's header bytes and copies
the unchanged payload ranges at their base offsets. Any instruction sequence
that reconstructs the exact result is valid; the diff algorithm is the
sender's choice and never part of identity.

The base must be reachable in the relevant basis graph: the retained accepted
base for a submission, or the previous accepted root for a transition. The
receiver hash-verifies that base, applies the instructions, requires the
reconstructed bytes to hash to `result`, and decodes them as a valid canonical
object. It then treats the result exactly like a complete object. A result
appears exactly once across complete objects and deltas. New objects use
complete bytes. The sender chooses whichever representation is smaller. The
encoding is a transport choice: the identified result object and accepted
roots remain canonical, and retries or later storage packing may select a
different representation without changing semantic identity. Duplicate
results, a result also supplied as a complete object, noncanonical base64,
out-of-bounds copies, arithmetic overflow, and quota excess are invalid.

## 7. Shared values

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
| wire root and object hashes | one exact encoded snapshot or object; the tree's bytes hashes ([data model §5.1](#51-did-the-bytes-change-the-bytes-hash)) | hashing canonical CBOR bytes | nothing that changes a byte |
| accepted update `id` | one accepted transition of one tree | the server's observation ordinal | it is that update's `tree.update` cursor by construction |
| `EventCursor` | a position in one tree's observation stream | the server | nothing; it only orders |
| `QueryCursor` | a position in a host's derived-query observation domain | the host | nothing; it only orders |
| `requestDigest` | the semantic intent of one update or mutation | canonical CBOR of `updates-v1` or `mutate-v1` | retransmission with different objects or deltas |
| `mutationID` | one caller's mutation attempt | the caller | exact retries; reuse with a different digest conflicts |
| `outputHash` | one complete public query result | canonical CBOR of the result | provider or plan changes that leave the result identical |
