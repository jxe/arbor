# Portable authored format
*Part of the [Arbor spec](../spec.md): files and reserved names that remain meaningful across implementations.*

## Logical nodes

A logical node may have both a body and children. `x.md` supplies the body for logical path `/x`; sibling directory `x/` supplies its children. When `x.md` is absent, `x/_index.md` is the directory-body fallback. URLs, links, API paths, search results, and visible names use extensionless logical paths.

`x.md` and `x/` therefore coexist as one logical node. Creating a child does not move or rename `x.md`. Merely reading a bodyless directory does not create `_index.md`. The first authored body/property edit, authored child ordering, or operation requiring durable document identity may materialize it.

`x.md` together with `x/_index.md` is ambiguous. A conforming implementation reports `duplicate-body-representation` and refuses mutations of that logical node until a person explicitly chooses which body remains. Rename, move, copy, trash, and restore treat a sibling body and directory as one logical unit and never silently merge an occupied destination.

## Markdown documents and identity

Markdown frontmatter contains authored properties; the remainder is the authored body. A materialized Markdown document may carry an opaque durable `id`, called `PageID` by REST v1. A `PageID` remains stable across rename and move. Six-character lowercase IDs are a legacy convention, not the grammar: conforming implementations accept opaque non-empty IDs supported by the protocol.

```md
---
id: a1b2c3
title: Atlas
---

# Atlas
```

Authored Markdown is canonical. A client may parse it into an interactive model, but an untouched document must round-trip byte-for-byte. Generated presentation state, editor block IDs, synthetic rows, and caches are not authored Markdown.

## Complete directory projection

A client presents a directory document as:

1. its stored body and properties, or an empty implicit body;
2. the first eligible authored standalone link to each immediate child, in authored position;
3. one synthetic managed row for every otherwise unmentioned immediate child, in stable directory order.

Additional links remain ordinary prose links. Projected rows carry out-of-band target provenance, including resolved tree scope and `PageID` where available. Synthetic rows never persist as Markdown and never cross a mutation or wire boundary as if authored. Reordering or acting on a managed row is a structural mutation; editing prose or properties is a content mutation. A client must split those intentions before persistence.

Links use [Arbor locators](locators.md). Relative and tree-rooted logical paths are valid within a resolved tree; cross-tree links use canonical or raw TreeID locators. A Markdown link may carry a `PageID` fragment. When a path and valid ID disagree, the ID identifies the document and the readable path may be healed through an ordinary authored mutation. Ordinary non-Markdown files remain path-identified.

## Profiles and groups

Person and group profiles are complete shared trees with ordinary root Markdown:

```yaml
type: person
```

```yaml
type: group
members:
  - arbor://community.example/~alice
  - arbor://community.example/~bob
```

The profile tree's `TreeID`, not its mutable title or root `PageID`, is the stable person or group identity. Group membership is the authored `members` list. Membership does not itself grant write access to the group tree.

## Recognized authored files

- `schema.ts` declares a file-backed collection row schema as specified by [stores](stores.md).
- `_store.csv`, `_store.jsonl`, `_store.sqlite3`, and `_store.postgres` select collection backing behavior specified by [stores](stores.md).
- `.tsx` files may define Arbor scripts as specified by [scripts](scripts.md).
- Markdown files may define agents as specified by [agents](agents.md).

These recognizers do not make generated declarations, compiled bundles, database credentials, or execution transcripts part of this format unless they are themselves deliberately authored ordinary tree content.

## Reserved names and sidecars

- `_index.md` is the fallback body for its directory and is never exposed as a child.
- `_store.*` names select the enclosing collection's backing and are not ordinary row children.
- `Trash` is a recovery namespace owned by the enclosing local durability domain; it is not synchronized as an ordinary user directory unless explicitly authored outside that role.
- `Assets` is the conventional destination for imported binary assets and remains ordinary content.
- `.arbor` is reserved so legacy or implementation-maintained material cannot be mistaken for authored content. Its presence is not required, and it must not be synchronized unless another specification explicitly says so.

Credentials, access-link secrets, private indexes, journals, recovery databases, and device identity records are never portable authored format.
