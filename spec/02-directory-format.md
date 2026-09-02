# Portable directory projection
*Part of the [Arbor spec](../spec.md): one human-editable filesystem/Markdown
projection of the [Arbor data model](01-data-model.md).*

## Projection boundary

This format is not the Arbor ontology. It maps ordinary directory entries,
Markdown/frontmatter, reserved store files, and child-placement syntax to the
representation-independent nodes, properties, content, children, and identities
defined by the data model. Another conforming projection may arrange source
differently while preserving the same model and the projection-specific fidelity
guarantees it advertises.

The directory projection preserves exact authored source in addition to modeled
state. File bytes, frontmatter spelling/order/comments, and reserved rollup bytes
therefore have exact representation revisions even when their decoded logical
values are unchanged.

## Mapping files and directories to nodes

One of `x.md`, `x.mdx`, or `x.tsx` supplies content for logical path `/x`; sibling directory `x/` supplies its children. `.md` supplies non-executable Markdown, while `.mdx` and a default-exporting `.tsx` may supply an executable component body as specified by [executable documents](07-executable-documents.md). When no sibling body exists, `x/_index.md` is the Markdown directory-content fallback. URLs, links, API paths, and visible names use extensionless logical paths.

One content file and `x/` therefore coexist as one logical node. Creating a child does not move or rename the content. Merely reading a contentless directory does not create `_index.md`. The first authored Markdown content/property edit, authored child ordering, or operation requiring durable Markdown document identity may materialize it.

More than one sibling content representation—such as `x.md` with `x.mdx`—is ambiguous. Sibling content together with `x/_index.md` is also ambiguous. A conforming implementation reports `duplicate-body-representation` and refuses rendering or mutation of that logical node until a person explicitly chooses which representation remains. Rename, move, copy, trash, and restore treat sibling content and its directory as one logical unit and never silently merge an occupied destination.

## Properties, Markdown content, and identity

Markdown frontmatter is the Markdown provider's authored serialization of node
properties; the remainder is the node's Markdown content. The property API and
the Markdown editor therefore address one value rather than parallel record and
document state. A property mutation rewrites frontmatter through the same exact-
source concurrency boundary as a body mutation.

The generic `writeProperties` operation submits a complete candidate property
map and the sampled `basePropertiesRevision`. Omitted keys are deleted; an
explicit JSON `null` is retained as a value. It preserves the Markdown body
exactly, rejects stale revisions, and cannot change a property selected by the
applicable identity declaration. Providers may expose the property and content
capabilities separately even when both revisions currently name the same
Markdown source bytes. In that shared-byte representation, a successful
frontmatter-only write advances both exact-source capability revisions even
though the logical Markdown body is byte-for-byte unchanged.

A materialized Markdown document may carry an opaque durable `id`. This
projection historically calls its value a `PageID`; in the common data model it
is simply the stable key selected by the tree's identity declaration, encoded
and addressed as [locators](03-locators.md#stable-keys-revisions-and-fragments)
specify. `id`
remains visible as an ordinary property, but it cannot be changed through an
ordinary property update and remains stable across rename and move.
Six-character lowercase values are a legacy convention, not the grammar:
conforming implementations accept opaque
non-empty values supported by the protocol.

```md
---
id: a1b2c3
title: Atlas
---

# Atlas
```

Authored Markdown is the canonical exact source for this projection. A client
may parse it into properties and an interactive content model, but an untouched
document must round-trip byte-for-byte. Frontmatter ordering, quoting, comments,
and whitespace are projection concerns even when the modeled properties are
semantically unchanged. Editor block IDs and caches are neither modeled nor
authored source.

## Complete documents for nodes with children

When this format projects a node with children and without executable content,
it exposes one operational Markdown document. The directory provider forms it
from the stored sibling/index Markdown body, or an empty implicit body. Authored
placement and child membership are distinct:

1. Walk standalone links in source order. The first link that resolves to each immediate child represents that child at its authored position. Inline links never qualify, and later standalone links to the same child remain ordinary duplicate links.
2. A standalone `<!-- arbor:children -->` marker represents every otherwise-unmentioned immediate child at that position. When source contains no marker, one implicit marker exists after the authored source. More than one marker is `duplicate-children-marker` and blocks authored placement edits until repaired.
3. The provider enumerates the marker's remainder in canonical logical-path order and may page or virtualize it. The operational document retains the marker rather than expanding one literal source link per child. Reading, rendering, indexing, searching, backlinks, hosted output, and export consume the same placement model.

Reading an implicit body or marker does not materialize it. The first authored
content/property/placement write persists only the exact authored source; it
does not serialize the marker's remainder. The directory projection's
`placementRevision` covers the exact stored source bytes plus the provider's
stable immediate-child generation. Child add/remove/relocate/identity changes
invalidate a concurrent placement write; property or content changes within an
existing child do not change parent membership unless they also change its
location or identity. This projection revision is extra observation detail and
does not collapse the data model's separate content and children revisions.

Link ordering, nesting, labels, and deletion are ordinary source edits. Removing
an explicit child link returns that child to the marker; it never deletes the
target. Create, move, rename, copy, delete, restore, and row mutations are
explicit structural or provider operations. Filesystem entries, collection
rows, database tables, database records, and mounted boundaries are all children
when their provider exposes them as such. A transient query result is not a node
or child unless an explicit materialization operation creates one.

Links use [Arbor locators](03-locators.md). Relative and tree-rooted logical
paths are valid within a resolved tree; cross-tree links use canonical or raw
TreeID locators. Any schema-identified node may use the Markdown-compatible
`#arbor-key=<base64url-key>` relative-link alias defined by
[locators](03-locators.md#stable-keys-revisions-and-fragments). When its readable path and
valid stable key disagree, the key selects the node within its declaring
keyspace and the authored content may be healed through an ordinary mutation. The alias
and application query survive healing unchanged. Arbor renderers translate the
alias to the server-visible path suffix before emitting HTTP links. Nodes with a
null stable key remain path-identified.

## Profiles and groups

Person and group profiles are complete Arbor trees with ordinary root Markdown:

```yaml
type: person
```

```yaml
type: group
members:
  - arbor://community.example/~alice
  - arbor://community.example/~bob
```

The profile tree's `TreeID`, not its mutable title or root `PageID`, is the stable person or group identity. The root document's `type: person` or `type: group` is the sole declaration of a profile's kind; wire tree descriptors carry no profile kind, and the server enforces `type: person` at an account's profile tree and `type: group` at the community root without validating `type:` elsewhere. Group membership is the authored `members` list. Membership does not itself grant write access to the group tree.

## Recognized authored files

- `schema.ts` declares a file-backed collection row schema as specified by [stores](06-stores.md).
- `_store.csv`, `_store.json`, `_store.jsonl`, `_store.sqlite3`, and
  `_store.yaml` select child/store representation behavior specified by
  [stores](06-stores.md). `_store.yaml` is driver-dispatched; its filename does
  not imply Postgres.
- `.ts` and `.tsx` files may define Arbor handles, components, and executable documents as specified by [executable documents](07-executable-documents.md).
- `.mdx` files may define explicit executable component documents as specified by [executable documents](07-executable-documents.md).
- Markdown files may define agents as specified by [agents](08-agents.md).

These recognizers do not make generated declarations, compiled bundles, database credentials, or execution transcripts part of this format unless they are themselves deliberately authored ordinary tree content.

## Reserved names and sidecars

- `_index.md` is the fallback body for its directory and is never exposed as a child.
- `_store.*` names select the enclosing collection's backing and are not ordinary row children.
- `.state` is forbidden in an account-configuration graph as specified by [configuration](05-configuration.md).

The account YAML is human-editable special control content, not portable authored format. Credentials, access-link secrets, private indexes, journals, recovery databases, and private device credential records are never portable authored format.
