# Arbor data model
*Part of the [Arbor spec](../spec.md): the global TreeID space, trees, nodes,
structured data, projections, and equivalence.*

*Owns: the TreeID space, nodes, canonical lookup, revisions, equivalence, and the glossary of identities. References: every projection.*

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

The DNS-name portion specifies a Canopy server on the network. The path-prefix portion specifies a tree served by that Canopy. Resolving a canonical URL first uses its DNS authority to reach the Canopy, then selects the longest readable registered boundary there, as specified by [the wire](04-wire.md#4-finding-trees). The result is that boundary's TreeID plus the remaining logical path and optional stable key, still in the uniform `(TreeID, path, key)` shape.

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

Because the readings are defined on the model, the representation is free to
vary, and several representations of the same nodes may exist at once. The
same schema-governed children may be expanded Markdown files, one
`_store.csv`, `_store.json`, or `_store.jsonl`, a SQLite table, or a Postgres
relation; a Canopy may read them from Postgres while a laptop keeps a SQLite
copy for offline use; an `_index.md` presents a node's children as a Markdown
document. A query or link that addresses the nodes does not change when their
representation does ([stores](06-stores.md)). A file named `something.json`
is a content node; only the reserved `_store.json` name means "these are the
collection's children".

A schema is what turns a set of children into a collection. It declares
property and content types, the stable-key rule that gives each child its
identity, allowed child shapes and discriminated unions, references and
relationships, uniqueness, ordering, and foreign-key behavior. A development
compiler can read the schema at a literal Arbor location and generate types
from it rather than inferring them from sample values.

## 5. Revisions and equivalence

Section 4 separated the model from its representations. That separation
means there are two different questions a reader can ask about change, and a
third about time. Arbor answers each with one token and never blurs them.

### 5.1 Did the bytes change? The source revision

A source revision is the hash of an exact representation: a wire object, the
wire root, a file's bytes. It exists only where bytes exist. Reformatting a
CSV, reordering frontmatter keys, or re-encoding a directory changes it even
though nothing in the model moved. Its job is compare-and-swap for byte-level
synchronization and proof that authored source is untouched.

### 5.2 Did the data change? The model digest

A model digest is the hash of model state: the canonical CBOR of a node's
schema, properties, content, and the digests of its children. It is defined
for every node, and a provider computes it wherever it can. Two
representations of one model state have different source revisions and the
same model digest; that is why the wire root is not a logical hash. Its job is
proof of equality: skipping work, showing that a reformat or migration
preserved the data, and defining equivalence. A database row's digest is
cheap, so it serves as the row's write guard. A live database does not
maintain a digest for a whole table, and says so by returning a cursor
instead.

### 5.3 What changed since I looked? The observation cursor

An observation cursor is an ordered position in a provider's committed-change
stream. Every read returns the cursor it observed through, and every
dependency is a provider, a cursor, and a precision scope
([stores](06-stores.md#13-revisions-and-committed-change-observation)).
Cursors are the only way to follow change; hashes never are.

### 5.4 Which one a rule uses

A write is guarded by the token of the level it edits: a source revision when
it edits a representation, such as an editor saving Markdown or the wire's
accepted base, and a model digest when it edits the model, such as a row
mutation. A claim of equality uses whichever level the claim is about.
Invalidation uses cursors, narrowed by precision.

A node's properties are one map however they are edited: a property write
replaces the complete map under the guard it observed, cannot change the
property selected by the applicable identity declaration, and leaves content
and children alone.

### 5.5 When two things are the same

- **Identity.** Two copies are the same logical tree when they have the same
  `TreeID`, even if their observed revisions have not settled. Two references
  identify the same keyed node when their TreeIDs, key-scope owners, and
  non-null keys agree. With a null key, TreeID and current path establish
  identity.
- **Model.** Two tree states, or two representations after decoding, are
  model-equivalent over a declared scope when their model digests agree:
  their nodes have the same identities, properties, content, child
  membership, and schemas after schema-declared normalization. Expanded
  Markdown records, JSON, SQLite, and Postgres may therefore be equivalent
  representations of one collection even though none is the canonical
  serialization of the others.

## 6. Identities and revisions

Every identifier and change token the specification uses, in one place. [Section 5](#5-revisions-and-equivalence) defines the three change
tokens; this table says who mints each token, where it travels, and what
it survives.

| Token | Identifies | Minted by | Appears in | Survives |
|---|---|---|---|---|
| `TreeID` | one logical tree and its history | the declaring client: `tr_` plus 26 base32 characters | every wire operation, `trees.yaml`, locators, `NodeRef` | rename, move, re-placement, and any change of canonical name |
| `DeviceID` | one credential binding for one account | the device: `dv_` plus 26 base32 characters | `devices/<DeviceID>.yaml`, `admins` | everything except deletion of its file, which retires it |
| `PairingID` | one short-lived pairing secret | the server | the pairing claim route ([wire §5.2](04-wire.md#52-device-pairing)) | nothing; it is single use |
| stable key | one keyed node within its declaring keyspace | the schema's identity rule, as canonical key JSON | `NodeRef.stableKey`, `;arbor-key=`, the Markdown alias, row segments ([locators §2](03-locators.md#2-stable-keys-revisions-and-fragments)) | rename, move, reformat, and representation migration |
| source revision | one exact representation | hashing the bytes | object hashes, wire roots, `ref`, `base`, `candidate`, and editor write guards | nothing that changes a byte |
| model digest | one model state | hashing the canonical CBOR of the model | `RollupDescriptor.modelDigest`, projection state, equivalence claims | reformatting, representation migration, and merges that preserve the model |
| observation cursor (`EventCursor`, `QueryCursor`) | a position in one provider's committed-change stream | the provider | `observedThrough`, the watch `after` parameter, receipts, dependency plans | nothing; it only orders |
| accepted update `id` | one accepted transition of one tree | the server's observation ordinal | `AcceptedUpdate.id`, `UpdateRequest.base`, `tree.ref` frame ids ([wire §1.5](04-wire.md#15-watch-accepted-transitions)) | it is that update's cursor by construction |
| `requestDigest` | the semantic intent of one update or mutation | canonical CBOR of `updates-v1` or `mutate-v1` | update results, the submitter's `tree.ref` events, mutation receipts | retransmission with different objects or deltas |
| `mutationID` | one caller's mutation attempt | the caller | `MutateRequest`, receipts ([wire §2.2](04-wire.md#22-execute-named-mutations)) | exact retries; reuse with a different digest conflicts |
| `outputHash` | one complete public query result | canonical CBOR of the result | query `result` and `ready` events, placement projections | provider or plan changes that leave the result identical |
| schema fingerprint | one compiled schema | executing `schema.ts` or introspecting a database | `RollupDescriptor.schema`, manifests, activated bindings, dependency plans | nothing that changes the compiled schema |
| code version | one compiled handle or document | the compiler | `QueryHandleRef.version`, `document.version`, manifests ([executable documents §3](07-executable-documents.md#3-modules-and-named-handles)) | moving the source tree; not a code change |
| access-link digest | one access link | hashing the secret | `trees.yaml` ACL subjects, `AccessSubject` ([configuration §2](05-configuration.md#2-configuration-yaml)) | the secret is never shown again; deleting the rule revokes it |
