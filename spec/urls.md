# Names and URLs
*Part of the [Arbor spec](../spec.md): every form of name in the system, and how each resolves.*

## 1. One Markdown link syntax

Arbor does not add a link type to Markdown. A destination in `[label](destination)` is a URL reference with these forms:

| Form | Example | Names |
|---|---|---|
| Relative path | `notes` or `../roadmap` | a child or sibling relative to the containing logical document |
| Tree-rooted path | `/essays/drift` | a node rooted at the enclosing tree |
| Named Arbor URL | `arbor://library.meaningalignment.org/essays/drift` | a node in a shared tree with a DNS alias |
| Tree-ID Arbor URL | `arbor://tree/tr_7k3m…/essays/drift` | a node in a shared tree by raw `TreeID` |
| System path | `system:roots/rt_x7f3q2ab7c` | an arbord control view ([system.md](system.md) §1) |
| Overlay ref | `local:annotations/railton` | a local overlay tree, referenced from a tree placement |
| Document-ID fragment | `../roadmap#x7f3q2` | the target Markdown document's durable `PageID` |
| Export fragment | `reading-room.tsx#recentEssays` | a script export — a query, mutation, or component handle |
| Legacy URL | `https://…` | the legacy web, through the hatch (§4) |

The `arbor` scheme is always absolute. A DNS name is its authority; `tree` is the reserved authority whose first path segment is the opaque `TreeID`. Bare domain/path names and the earlier `tree:tr_…/path` spelling are accepted as compatibility input, but link healing and copy-link actions emit `arbor://…`.

Fragments are disambiguated by target kind: on a Markdown document they carry its durable `PageID`; on a script they name an export. `arbor run ./reading-room.tsx#recentEssays` and a link block rendering the same export use the identical name.

## 2. Logical relative paths

Every Markdown document is a logical node that may have children, regardless of its physical body representation. Relative destinations therefore resolve from the containing **logical document as a directory-like base**. The resolver appends an implicit `/` to the canonical logical address before applying standard URL-reference resolution; that slash defines the base and is not added to the displayed browser route:

```text
containing document                 destination       resolves to
/projects/atlas                     notes             /projects/atlas/notes
/projects/atlas                     ./notes           /projects/atlas/notes
/projects/atlas                     ../roadmap         /projects/roadmap
/projects/atlas                     /people/alice      /people/alice
```

This base never changes when `atlas.md`, `atlas/_index.md`, or a bodyless projected directory supplies the body. Giving a leaf document its first child likewise cannot reinterpret its existing links. `.` and `..`, percent encoding, query/fragment separation, and path normalization follow ordinary URL-path rules; attempts to traverse above the enclosing tree fail.

The plain local filesystem is the degenerate no-tree scope. Outside any tracked root or mounted tree, a node's logical address is its OS-absolute path, and the browser traverses it like any other part of the one navigable tree. Tree-rooted destinations resolve at the enclosing tree; with no enclosing tree they resolve at the filesystem root — the honest limit of the degenerate case. Untracked local scopes are never globally nameable: only a shared tree confers `arbor://` addresses, and `system:`/`local:` remain arbord-local ([system.md](system.md) §1).

An absolute Arbor URL may also appear as the `source` of a path-keyed `~/.arbor/trees.yaml` entry. It names the shared tree and optional source-relative path only. The placement key chooses the reader-local position, while revision selection, access ceiling, overlay, endpoint hints, credentials, replication, and materialization policy remain separate fields or trusted local state.

Markdown node names never expose their storage suffix. Sibling body `x.md`, child directory `x/`, and fallback body `x/_index.md` all contribute to exactly `/x`; the root `_index.md` names `/`. `.md` and `/_index.md` spellings are accepted only as compatibility aliases at resolution boundaries and immediately canonicalized. They never appear in browser routes, API results, link healing, search results, generated types, or user-visible filenames. `x.md` may coexist with `x/`, but not with `x/_index.md` ([format.md](format.md) §1).

## 3. Identity, movement, and global resolution

The readable path says where a document is now; the fragment can say which document was meant. `PageID` is REST v1's name for this durable document identity and is stored as frontmatter `id`. When `../roadmap#x7f3q2` resolves to a different document than `x7f3q2`, the ID wins, arbord returns the current path, and the stale destination heals lazily through the normal authored commit path. Moving or renaming a document therefore does not break identity-bearing links, backlinks, history, or an open editor session. Arbor's Copy Link and link-insertion surfaces include the ID for Markdown targets; a hand-authored link without one deliberately retains ordinary path-only move semantics.

A bodyless directory projection is initially path-only so browsing does not create files. Before Arbor creates an identity-bearing link to it or performs an authored move that must preserve its document identity, arbord ensures a `PageID`, minimally materializing the appropriate Markdown body when necessary. Ordinary non-Markdown files remain path-only; Arbor does not promise a durable `NodeID` for every filesystem object. Moving content across shared-tree identity boundaries is an explicit transfer and cannot be made transparent by a tree-scoped link alone.

Every node in a shared tree has a global resolvable name `(TreeID, path)`. Its canonical URL is either `arbor://<dns-name>/<path>` or `arbor://tree/<TreeID>/<path>` ([wire.md](wire.md) §2). The `canonical:` metadata field, when present, contains one of these absolute Arbor URLs:

```yaml
id: x7f3q2
canonical: arbor://library.meaningalignment.org/essays/drift#x7f3q2
```

Canonical position is descriptive and citable; it is neither a mount nor a grant.

Resolution happens **in the reader's workspace first**, so another author's global link can land in the reader's mounted or annotated copy:

1. Relative and tree-rooted paths resolve within the enclosing tree using §2. Script path literals use the same resolver and are typed through the generated registry ([format.md](format.md) §5).
2. A document-ID fragment consults that tree's ID index; the ID wins over a stale path.
3. If the named or Tree-ID tree is already mounted or visited, the reader's local mount and overlay resolve it.
4. Otherwise, a named authority resolves through DNS `_arbor` to `(endpoint, TreeID)`; `arbor://tree/<TreeID>/…` uses endpoint hints already known from a mount, visit, invitation, or signed descriptor. With no hint it remains unresolved until one is learned.
5. `system:` and `local:` are arbord-local schemes: never part of a publishable tree and never remotely resolvable.

Naming is universal; access is not. Resolving private content still requires a grant. Credentials and invitation tokens never appear in ordinary Markdown links, and Arbor never treats an obscure URL as a secret.

## 4. The legacy bridge

`https://` remains an explicit legacy hatch. A deployed website advertises its live tree via `<link rel="arbor" …>` or the `Arbor-Tree:` response header carrying `(endpoint, TreeID)`; an Arbor-aware browser landing there upgrades to the live tree while legacy browsers see plain HTML ([wire.md](wire.md) §7, [browser.md](browser.md) §3).
