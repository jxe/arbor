# Arbor data model
*Part of the [Arbor spec](../spec.md): the global TreeID space, trees, nodes,
structured data, projections, and equivalence.*

The small TypeScript shapes in this document are explanatory pseudocode. They
show how the concepts fit together; they are not required APIs, wire values, or
in-memory representations.

## 1. The global TreeID space

Arbor is conceptually a global hash table of trees:

```ts
type Arbor = Map<TreeID, Tree>
```

This is a global identity space, not one global database. A `TreeID` denotes the
same logical tree and history wherever Arbor is implemented, but no server can
enumerate every TreeID and knowing an ID grants neither discovery nor access.
Each device, community, and application sees only the partial map it can locate
and read.

Copies carrying the same `TreeID` are placements or replicas of one tree, not
new trees. They may temporarily observe different revisions while
synchronization is unsettled. Local, private, unpublished, imported, and
offline trees remain members of the conceptual map even when no public service
can currently find them.

## 2. Trees and nodes

The value at a TreeID is a rooted hierarchy of nodes:

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

The map key gives the tree its durable identity. A tree is also one independent
history, synchronization stream, and whole-tree permission boundary. A
revision is an observation of this tree state; the Wire and projection specs
define their exact revision values rather than the data model requiring one
universal serialization or hash.

The root node has logical path `/`. Looking up successive names in `children`
produces every other logical path. Each child therefore has one structural
parent within that tree state; neither the child nor the parent needs a second
stored copy of its path.

A nested or mounted Arbor tree remains a separate entry in the global TreeID
map. A workspace resolver may present it below a node in another tree, but its
nodes, history, access, and mutations are not copied into that parent.

Properties, optional authored content, children, and schema are independent
dimensions. A node may have any combination of them. Document, directory, file,
collection, table, record, row, script, profile, executable document, and agent
describe roles, capabilities, or projections of a node. They are not separate
node kinds or identity systems.

Child membership is part of the tree structure. Content can present or position
children—for example through Markdown links and `<!-- arbor:children -->`—but
that syntax remains content. It is not a second child list or a separate link
facet.

A workspace is a resolved view across several trees plus any ordinary local
material that has not been promoted into a tree. It is not necessarily a tree,
revision, or synchronization boundary.

## 3. Node references and stable keys

Every Arbor node reference has the same shape:

```ts
type NodeRef = [tree: TreeID, path: Path, key: Key | null]
```

The current readable path is always present. When `key` is `null`, `(TreeID,
path)` identifies the node. A schema may instead select one or more required
properties as a stable key, scoped either to the whole tree or to the node's
parent. The third component then carries their canonical value and can check or
repair a stale readable path within that scope.

Markdown's `id` property is a tree-scoped key. A collection primary key is a
parent-scoped key. They use the same slot and rules; there is no `page | row`
reference union. Changing key properties is normally forbidden. Where a
contract permits it, the change removes one node identity and creates another.

A canonical key is RFC 8785 JSON for the identity rule's ordered array of
`[property, normalizedValue]` pairs. Values are required, non-null canonical
strings, booleans, or finite numbers. Locators transport its UTF-8 bytes as
unpadded base64url. The key is derived from ordinary properties and schema; it
is not parallel stored node metadata.

## 4. Canonical URL lookup

Canonical URLs are a secondary index over the TreeID map:

```ts
type CanonicalURLs = Map<`${DNSName}${PathPrefix}`, TreeID>
```

The DNS-name portion places a Canopy authority on the network. The path-prefix
portion is a canonical tree boundary served by that Canopy. Resolving a
canonical URL first uses its DNS authority to reach the Canopy, then strips any
locator key syntax and chooses the longest accessible path boundary there. The
result is that boundary's TreeID plus the remaining logical path and optional
stable key, still in the uniform `(TreeID, path, key)` shape.

This is explanatory composition, not a globally enumerable Arbor-owned DNS
database. Normal DNS and HTTPS establish how the Canopy is reached. The Canopy
is authoritative for which boundary records it serves and for access-controlled
resolution beneath its origin.

Together, canonical boundaries produce a forest-shaped URL view, but the view
is not Arbor's primary structure and is not governed by one server. URL nesting
does not imply common storage, history, ownership, or access. If one tree is
canonical at `/~alice` and another at `/~alice/atlas`, the latter boundary wins
for URLs beneath it.

Canonical placement is mutable naming at both levels. Replacing the DNS name of
a Canopy placement, moving a tree boundary within that Canopy, or renaming a
node changes canonical URLs without changing TreeID or stable key. Moving the
physical server behind an unchanged DNS origin changes neither. A raw
`arbor://tree/<TreeID>/...` locator addresses the primary namespace when a
canonical name is absent, unknown, inaccessible, or changing. Adding a
canonical boundary to a disconnected tree changes only this secondary lookup.

## 5. References and relationships

A node has no independently mutable `links` field. References occur in its
properties or content:

- a Markdown link is content syntax;
- a typed Arbor reference is a schema-interpreted property value; and
- a foreign key is a property value with a schema-declared target and
  constraint behavior.

Search indexes may extract these references. Backlinks are their derived
inverse. A schema may name relationships derived from properties. None of these
indexes or derived edges becomes a second source of authored node state.

A database can enforce a foreign-key relationship only within a transaction
domain it controls. A reference to another tree remains a reference; URL or
TreeID reachability does not make it a transactional foreign key.

## 6. Representing structured data

Ordinary application data uses the same nodes:

| Data role | Node interpretation |
|---|---|
| Record | Fields are node properties |
| Collection | Records are child nodes governed by a shared schema |
| Row | One child node, usually with a parent-scoped stable key |
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

## 7. Projections and materializations

A projection expresses some model nodes as editable, stored, transported, or
presented data. A materialization maintains such a form for execution or
performance. Neither creates a second node identity system.

Examples include:

- sibling content files and directories;
- `_index.md`, frontmatter, standalone Markdown links, and the child marker;
- expanded record files;
- `_store.csv`, `_store.json`, `_store.jsonl`, and `_store.sqlite3`;
- `_store.yaml` external providers;
- placement-private SQLite projections and authority Postgres materializations;
- deterministic Wire objects; and
- HTML, native, editor, and table presentations.

A projection may retain facts that are not model values: Markdown or
frontmatter spelling, JSON whitespace, CSV quoting, SQLite indexes, Postgres
query plans, provider diagnostics, readiness, writability, and observation
cursors. Its own spec says which such facts round-trip exactly.

The [directory projection](02-directory-format.md) defines how ordinary files,
`_index.md`, frontmatter, and child presentation map to nodes.
[Locators](03-locators.md) encode TreeID, path, stable key, revision,
application query, and content fragment. [Wire](04-wire.md) transports exact
synchronized representations and observations. [Stores](06-stores.md) defines
rollups, database providers, and placement materializations. [Executable
documents](07-executable-documents.md) defines queries and mutations over nodes
rather than provider-specific rows.

## 8. Equivalence

Arbor states equivalence at the level relevant to the claim. It does not require
one universal serialized graph or one universal logical hash.

### Identity equivalence

Two copies are the same logical tree when they have the same `TreeID`, even if
their observed revisions have not settled. Two references identify the same
keyed node when their TreeIDs, key-scope owners, and non-null keys agree. With a
null key, TreeID and current path establish identity. Equal names, non-key
values, content, positions, or canonical URLs do not.

### Model-state equivalence

Two tree states are model-state equivalent over a declared scope when their
nodes have the same identities, properties, content, child names/membership,
and schemas after schema-declared normalization. Extracted references,
backlinks, relationships, and content-derived child presentation must then also
agree, but remain derived observations.

Canonical-boundary state is excluded when comparing one tree's contents. It is
included only when the claim covers canonical URL resolution.

### Projection equivalence

Two projections are equivalent when decoding them produces model-state-
equivalent nodes over the claimed scope. Their bytes, filenames, whitespace,
quoting, physical row order, indexes, database pages, plans, and private caches
may differ unless the claim explicitly includes those facts.

Expanded Markdown records, JSON, SQLite, and Postgres may therefore be
equivalent representations of one collection even though none is the canonical
serialization of the others.

### Execution equivalence

After synchronization and materialization settle, two application placements
are execution-equivalent when the same source nodes, component/script versions,
bound data-node state, schemas, trusted user, and inputs produce the same public
query results, mutation validation/effects, constraints, and public errors.
Physical provider choices and projection details are not application semantics.
