# Arbor data model
*Part of the [Arbor spec](../spec.md): the global TreeID space, trees, nodes,
structured data, projections, and equivalence.*

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

Arbor trees can be mounted inside other arbor trees, but they remain a separate entry in the global TreeID map. A workspace resolver may present it below a node in another tree, but its
nodes, history, access, and mutations are not copied into that parent.

## 3. Canonical URL lookup

Canonical URLs are a secondary index over the TreeID map:

```ts
type CanonicalURLs = Map<`${DNSName}${PathPrefix}`, TreeID>
```

The DNS-name portion specifies a Canopy server on the network. The path-prefix portion specifies a tree served by that Canopy. Resolving a canonical URL first uses its DNS authority to reach the Canopy, then selects the longest readable registered boundary there, as specified by [the wire](04-wire.md#4-finding-trees). The result is that boundary's TreeID plus the remaining logical path and optional stable key, still in the uniform `(TreeID, path, key)` shape.

Normal DNS and HTTPS establish how the Canopy is reached.

URL nesting does not imply common storage, history, ownership, or access. If one tree is canonical at `/~alice` and another at `/~alice/atlas`, the latter boundary wins for URLs beneath it.

Canonical placement is mutable naming at both levels. Replacing the DNS name of a Canopy placement, moving a tree boundary within that Canopy, or renaming a node changes canonical URLs without changing TreeID or stable key. Moving the physical server behind an unchanged DNS origin changes neither. A raw `arbor://tree/<TreeID>/...` locator addresses the primary namespace when a canonical name is absent, unknown, inaccessible, or changing.

## 4. Representing structured data

Ordinary application data uses the same nodes:

| Data role | Node interpretation |
|---|---|
| Record | Fields are node properties |
| Collection | Records are child nodes governed by a shared schema |
| Row | One child node, usually with a stable-key rule declared by its parent |
| Table | A collection with relational query and mutation capabilities |
| Database | A node/subtree materialized by a database provider |
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

## 6. Equivalence

Arbor states equivalence at the level relevant to the claim. It does not require
one universal serialized graph or one universal logical hash.

### Identity equivalence

Two copies are the same logical tree when they have the same `TreeID`, even if
their observed revisions have not settled. Two references identify the same
keyed node when their TreeIDs, key-scope owners, and non-null keys agree. With a
null key, TreeID and current path establish identity.

### Model-state equivalence

Two tree states are model-state equivalent over a declared scope when their
nodes have the same identities, properties, content, child names/membership,
and schemas after schema-declared normalization.

### Projection equivalence

Two projections are equivalent when decoding them produces model-state-
equivalent nodes over the claimed scope.

Expanded Markdown records, JSON, SQLite, and Postgres may therefore be
equivalent representations of one collection even though none is the canonical
serialization of the others.

### Execution equivalence

After synchronization and materialization settle, two application placements
are execution-equivalent when the same source nodes, component/script versions,
bound data-node state, schemas, trusted user, and inputs produce the same public
query results, mutation validation/effects, constraints, and public errors.
Physical provider choices and projection details are not application semantics.
