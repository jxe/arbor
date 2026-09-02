# Arbor data model
*Part of the [Arbor spec](../spec.md): the global TreeID space, trees, nodes,
structured data, projections, and equivalence.*

*Owns: the TreeID space, nodes, canonical lookup, the property write, revisions, equivalence, and the glossary of identities. References: every projection.*

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

A property write is the one model-level mutation every projection must
support identically. It submits a complete candidate property map together
with the [write guard](#6-revisions-and-equivalence) the writer observed: omitted keys are deleted, an explicit
JSON `null` is retained as a value, content and children are untouched, a
stale revision is rejected, and a property selected by the applicable identity
declaration cannot change. Projections add only what their representation
requires, as the [directory format](02-directory-format.md#3-properties-markdown-content-and-identity)
and [stores](06-stores.md#2-file-backed-collections) specify.

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

## 4. Representing structured data

Ordinary application data uses the same nodes:

| Data role | Node interpretation |
|---|---|
| Record | Fields are node properties |
| Collection | Records are child nodes governed by a shared schema |
| Row | One child node, usually with a stable-key rule declared by its parent |
| File | A node projected primarily through content bytes |
| Directory | A projection of a node's children |
| Document | A node presented primarily through its content |
| Executable document or agent | A node whose content receives reviewed execution capabilities |

Inserting a database row creates a child node. Updating columns changes that
node's properties. Deleting the row removes the child. Rows may also have
content and children because they remain ordinary nodes.

Markdown frontmatter and record fields project properties. A Markdown body and
a content column or file project content. Expanded child files,
CSV/JSON/JSONL, SQLite, and Postgres can represent the same schema-governed
children. An ordinary `something.json` is still a content node; `_store.json`
is specifically a collection-child projection.

Schemas define property and content types, stable-key rules, allowed child
shapes, discriminated unions, references, relationships, uniqueness, ordering,
and foreign-key behavior. A development compiler can use the schema at a
literal Arbor location to generate TypeScript types without inferring them from
sample values.

## 5. Projections and materializations

A projection expresses some model nodes as editable, stored, transported, or
presented data. A materialization maintains such a form for execution or
performance.

Examples include:

- an `_index.md` is a Markdown projection of a node's children;
- `_store.csv`, `_store.json`, `_store.jsonl`, and `_store.sqlite3` are equivalent projections of the same collection children;
- canopy might have access to a postgres database, but sync a copy of the same collection children into a local SQLite projection for offline use;

The [directory projection](02-directory-format.md) defines how ordinary files,
`_index.md`, frontmatter, and child presentation map to nodes.
[Locators](03-locators.md) encode TreeID, path, stable key, revision,
application query, and content fragment. [Wire](04-wire.md) transports accepted
tree state through deterministic lossless encodings and observations.
[Stores](06-stores.md) defines rollups, database providers, and placement
materializations. [Executable documents](07-executable-documents.md) defines
queries and mutations over nodes rather than provider-specific rows.

## 6. Revisions and equivalence

The model is primary; files and databases implement it. A node's properties,
content, children, and schema are the thing. A Markdown file with frontmatter,
a `_store.csv`, a SQLite table, and a wire directory object are each one
representation of that thing. Every rule in this specification addresses one
of those two levels. Stable keys, queries and their dependencies, mutations,
equivalence, store migration, placement projections, and the consent statement
address the model. Wire synchronization, which must round-trip authored bytes
exactly, frontmatter preservation, and the concurrency guard on an editor's
write address a representation.

Three primitives describe change, one per job:

| Primitive | Level | Definition | Job |
|---|---|---|---|
| **Source revision** | representation | The hash of an exact representation: a wire object hash, the wire root, a file's bytes. It exists only where bytes exist. | Compare-and-swap for byte-level synchronization; proof that authored source is untouched. |
| **Model digest** | model | The Merkle hash of model state: the canonical CBOR of `{ schema, properties, content, children }`, where `children` maps each name to that child's digest. It is defined for every node, and a provider computes it wherever it can. | Proof of equality: skipping work, showing that a reformat or migration preserved the model, defining equivalence. |
| **Observation cursor** | provider | An ordered position in a provider's committed-change stream. Every read returns the cursor it observed through. | The only way to follow change. A dependency is a provider, a cursor, and a precision scope. |

Two representations of one model state have different source revisions and
the same model digest. That is expected, and it is why the wire root is not a
logical hash. A database row's digest is cheap, so it is that row's write
guard; a live database does not maintain a digest for a whole table and says
so by returning a cursor instead. [Stores](06-stores.md#13-revisions-and-committed-change-observation)
defines observation precision.

A write guard names a source revision when the write edits a representation,
such as an editor saving Markdown or the wire's accepted base, and a model
digest when it edits the model, such as a row mutation or a
[property write](#2-trees-and-nodes) on a row. Equality and skipping use
whichever level the claim is about. Invalidation uses cursors narrowed by
precision, never hashes.

Equivalence has two levels:

- **Identity.** Two copies are the same logical tree when they have the same
  `TreeID`, even if their observed revisions have not settled. Two references
  identify the same keyed node when their TreeIDs, key-scope owners, and
  non-null keys agree. With a null key, TreeID and current path establish
  identity.
- **Model.** Two tree states, or two representations after decoding, are
  model-equivalent over a declared scope when their model digests agree: their
  nodes have the same identities, properties, content, child membership, and
  schemas after schema-declared normalization. Expanded Markdown records,
  JSON, SQLite, and Postgres may therefore be equivalent representations of
  one collection even though none is the canonical serialization of the
  others.

## 7. Identities and revisions

Every identifier and change token the specification uses, in one place. The
[revisions](#6-revisions-and-equivalence) section defines the three change
primitives; this table says who mints each token, where it travels, and what
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
