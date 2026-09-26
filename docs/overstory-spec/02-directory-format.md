# Portable directory projection
*Part of the [Overstory spec](README.md): one human-editable filesystem/Markdown
projection of the [Overstory data model](01-tree-operations.md).*

*Owns: how files, directories, frontmatter, `_index.md`, child placement, and reserved names map to nodes, and which directory entries are tree content. References: stable keys ([locators](03-locators.md)) and the [property write](01-tree-operations.md#22-reconciliation-and-exact-state-preconditions).*

## 1. Projection boundary

This format is not the Overstory ontology. It maps ordinary directory entries,
Markdown/frontmatter, reserved store files, and child-placement syntax to the
representation-independent nodes, properties, content, children, and identities
defined by the data model. Another conforming projection may arrange source
differently while preserving the same model and the projection-specific fidelity
guarantees it advertises.

The directory projection preserves exact authored source in addition to modeled
state, so its writes match on [bytes hashes](01-tree-operations.md#representation-and-model-equality):
file bytes, frontmatter spelling/order/comments, and reserved collection-file
bytes
change the bytes hash even when the model hash is unchanged.

## 2. Mapping files and directories to nodes

A directory projects one node. Its ordinary entries supply the node's child
set; reserved body, collection-file, and schema entries instead
supply the node's content or the interpretation of its children. Its own
content lives inside it as `x/_index.md`, so a node that has children keeps
everything in one place. A node may instead keep its content beside the
directory: `x.md`, `x.mdx`, or `x.tsx` supplies the content of `/x` when `x/`
has no `_index.md`, and the sibling directory `x/`, if present, still supplies
the children. `.md` supplies non-executable Markdown, while `.mdx` and a
default-exporting `.tsx` may supply an executable component body as specified
by [executable documents](07-executable-documents.md). URLs, API paths, and
visible names use extensionless logical paths either way; a relative link
written in Markdown names the body file itself and resolves from the directory
that holds the file containing it ([locators §2.1](03-locators.md#21-links-written-in-markdown)).

`_index.md` takes precedence. When both `x/_index.md` and a sibling body exist,
`_index.md` is the node's content, the sibling body is not part of the model,
and a conforming implementation reports `shadowed-body` as a diagnostic so a
person can remove or merge the sibling; the node stays readable and editable.
More than one sibling body, such as `x.md` beside `x.mdx`, is ambiguous with
nothing to prefer: the implementation reports `duplicate-body-representation`
and refuses rendering or mutation of that node until a person chooses which
remains.

A sibling body and `x/` coexist as one logical node. Creating a child does not
move or rename the content. Merely reading a contentless directory does not
create `_index.md`. The first authored Markdown content/property edit,
authored child ordering, or operation requiring durable Markdown document
identity may materialize it. Rename, move, copy, trash, and restore treat
sibling content and its directory as one logical unit and never silently merge
an occupied destination.

Because relative links resolve from the directory holding the file that
contains them, a body that changes form or place (a sibling `x.md` replaced by
`x/_index.md`, or any rename or move) moves the base of its own relative
links, and links elsewhere that spell its old file name go stale. The writer
that makes the change rewrites the moved body's relative links against its new
directory in the same change and heals the links that name it as for any
other move ([locators §4](03-locators.md#4-resolution-rules)). A reader still
resolves a stale `x.md` spelling to the node `x`.

## 3. Properties, Markdown content, and identity

Markdown frontmatter is the Markdown provider's authored serialization of node
properties; the remainder is the node's Markdown content. The property API and
the Markdown editor therefore address one value rather than parallel record and
document state. A property mutation rewrites frontmatter through the same exact-
source concurrency boundary as a body mutation.

A [property write](01-tree-operations.md#22-reconciliation-and-exact-state-preconditions) preserves
the Markdown body exactly. Providers may expose the property and content
capabilities separately even when both match values currently name the same
Markdown source bytes. In that shared-byte representation, a successful
frontmatter-only write changes both capabilities' bytes hashes even though the
logical Markdown body is byte-for-byte unchanged.

A materialized Markdown document may carry an opaque durable `id`. This
projection historically calls its value a `PageID`; in the common data model it
is simply the stable key selected by the tree's identity declaration, encoded
and addressed as [locators](03-locators.md#2-stable-keys-revisions-and-fragments)
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

## 4. Complete documents for nodes with children

When this format projects a node with children and without executable content,
it exposes one operational Markdown document. The directory provider forms it
from the stored sibling/index Markdown body, or an empty implicit body. Authored
placement and child membership are distinct:

1. Walk standalone links in source order. The first link that resolves to each immediate child represents that child at its authored position. Inline links never qualify, and later standalone links to the same child remain ordinary duplicate links.
2. A standalone `<!-- arbor:children -->` marker represents every otherwise-unmentioned immediate child at that position. When source contains no marker, one implicit marker exists after the authored source. More than one marker is `duplicate-children-marker` and blocks authored placement edits until repaired.
3. The provider enumerates the marker's remainder in canonical logical-path order and may page or virtualize it. The operational document retains the marker rather than expanding one literal source link per child. Reading, rendering, indexing, searching, backlinks, hosted output, and export consume the same placement model.

Reading an implicit body or marker does not materialize it. The first authored
content/property/placement write persists only the exact authored source; it
does not serialize the marker's remainder. A placement write must match the parent's bytes hash together with the
children cursor it observed. Child add/remove/relocate/identity changes
invalidate a concurrent placement write; property or content changes within an
existing child do not change parent membership unless they also change its
location or identity.

Link ordering, nesting, labels, and deletion are ordinary source edits. Removing
an explicit child link returns that child to the marker; it never deletes the
target. Create, move, rename, copy, delete, restore, and row mutations are
explicit structural or provider operations. Filesystem entries, collection
rows, database tables, database records, and mounted boundaries are all children
when their provider exposes them as such. A transient query result is not a node
or child unless an explicit materialization operation creates one.

Links use [Overstory locators](03-locators.md). Relative and tree-rooted logical
paths are valid within a resolved tree; cross-tree links use canonical or raw
TreeID locators; a document-link row naming a node in the same tree is a
relative link, not an `arbor://` locator. A relative link names the target's
body file and carries its stable key as `#arbor-key=<key-token>`, as
[locators §2.1](03-locators.md#21-links-written-in-markdown) defines. When its
readable path and valid stable key disagree, the key selects the node within
its declaring keyspace and the authored content may be healed through an
ordinary mutation that rewrites only the link's destination; the key,
application query, and content fragment survive. Overstory renderers translate
the alias to the server-visible path suffix before emitting HTTP links. Nodes
with a null stable key remain path-identified.

## 5. Recognized authored files

- `schema.cddl` declares a collection child schema, stable key, and optional
  logical-name rule in the declarative profile specified by
  [child backings](06-child-backings.md#24-collection-schema-profile). No
  other file name selects a collection schema; a `schema.ts`, for example, is
  an ordinary file.
- `_store.csv`, `_store.json`, `_store.jsonl`, `_store.sqlite3`, and
  `_store.yaml` select child/store representation behavior specified by
  [child backings](06-child-backings.md). `_store.yaml` is driver-dispatched; its filename does
  not imply Postgres.
- `.ts` and `.tsx` files may define Overstory handles, components, and executable documents as specified by [executable documents](07-executable-documents.md).
- `.mdx` files may define explicit executable component documents as specified by [executable documents](07-executable-documents.md).
- Markdown files may define agents as specified by [executable documents](07-executable-documents.md#13-agents).

These recognizers do not make generated declarations, compiled bundles, database credentials, or execution transcripts part of this format unless they are themselves deliberately authored ordinary tree content.

For a collection-file directory, the selected `_store.csv`, `_store.json`, or
`_store.jsonl` and `schema.cddl` remain exact authored file entries in the protocol
graph, while the directory's `childrenSource` descriptor marks their decoded
rows as the complete immediate logical child set. Those reserved files are not
themselves logical children. `_index.md` may still supply the directory node's
own content, but mixing collection-file-derived rows with other expanded
immediate children is invalid. The descriptor's Overstory shape is defined with
[tree snapshots](01-tree-operations.md#112-reading-an-accepted-snapshot);
its interpretation and validation are defined by
[child backings §2.1](06-child-backings.md#21-accepted-overstory-representation).

## 6. Reserved names and sidecars

- `_index.md` is its directory's own content and is never exposed as a child.
- `_store.*` names select the enclosing collection's backing and are not ordinary row children.
- `.state` is forbidden in a tree configuration graph as specified by [configuration](04-accounts-and-devices.md#2-tree-configuration-graph).

The account YAML is human-editable special control content, not portable authored format. Credentials, access-link secrets, private indexes, journals, recovery databases, and private device credential records are never portable authored format.

## 7. Tree membership and ignore files

Not every entry in a placed directory is tree content. An entry that one of the
rules below excludes is not a node, is not part of any snapshot, and is never
published. Writing accepted state into the directory never overwrites or
deletes it. It stays an opaque placement file: it remains on disk and
local tools may open it, but it belongs to that placement, not to the tree.

**Mandatory exclusions.** These are never tree content, whatever an ignore file
says: directories named `.git`, `node_modules`, `.arbor`, `Trash`, `.build`, or
`DerivedData` and everything beneath them; write and transaction temporaries
(names containing `.arbor-write-` or `.arbor-txn-`); operating-system metadata
the system rewrites on its own, namely macOS Finder's `.DS_Store` and
AppleDouble `._name` files, at any depth; a cloud provider's
placeholder for an evicted file, such as iCloud's `.name.icloud`, which stands
for its logical file; symbolic links; and the root of a nested tree mounted in
the directory, whose content belongs to that tree. A root accepted before an
exclusion applied may still name such a path; a folder client neither writes
nor removes the local file there, and publishes the root without it.

**Ignore files.** `.arborignore` is the portable spelling of an ignore file.
`.gitignore` is read with the same meaning for compatibility. Each applies from
the directory that contains it downward and uses Git's pattern grammar: blank
lines, `#` comments, backslash escapes, unescaped trailing spaces removed, `!`
negation, a trailing `/` for directories only, a leading or inner `/` anchoring
the pattern to the file's directory, and `*`, `?`, bracket expressions, and
`**`. Paths are matched with `/` separators, case-sensitively, one Unicode
character at a time. A rule in a deeper file overrides one in a shallower
file, `.arborignore` overrides `.gitignore` beside it, and within a file the
last matching rule decides. As in Git, an entry beneath an excluded directory
cannot be re-included, and ignore files inside an excluded directory are not
read. An ignore file that is not valid UTF-8 contributes no rules. An
implementation reports that locally, naming the file but never its contents,
and continues.

Ignore files are themselves ordinary tree content. They are published like any
other file, and no rule excludes them except by excluding a directory that
contains them. Only these files decide membership: `.git/info/exclude`,
`core.excludesFile`, a global Git ignore file, and Git's index are never
consulted, because they are private to one machine and would make the same
directory yield different trees on different devices.

**Tracked entries.** Rules keep new local content out of a tree; they do not
take out content already in it. A path in the tree the directory last held is
*tracked*: it stays tree content even when a rule matches it, so its local
edits are published and accepted changes to it are written. It leaves the tree
only through an explicit deletion, local or accepted. After that, a local file
at that path that a rule matches is untracked and stays in the directory,
unpublished. A directory placed for the first time has nothing tracked, so its
rules apply before its first snapshot. Editing an ignore file therefore never
deletes anything from a tree, and writing accepted state never deletes
untracked content that the directory's rules, before or after the write,
exclude.
