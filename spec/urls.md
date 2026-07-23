# Names and URLs
*Part of the [Arbor spec](../spec.md): every form of name in the system, and how each resolves.*

## 1. Name forms

| Form | Example | Names |
|---|---|---|
| Tree-rooted path | `/essays/drift` | a node, rooted at the enclosing tree (the `arbor dev` root; later the shared tree's root) |
| Relative path | `../fidelity` | a node, relative to the containing page |
| Public name | `library.meaningalignment.org/essays/drift` | a node in a tree that has a DNS alias |
| Tree URI | `tree:tr_7k3m…/essays/drift` | a node by raw `TreeID`, when no alias exists |
| System path | `system:mounts/railton` | arbord control records ([system.md](system.md) §1) |
| Overlay ref | `local:annotations/railton` | a local overlay tree, referenced from a mount record |
| Page fragment | `notes#x7f3q2` | the target page's durable ID ([format.md](format.md) §4) |
| Export fragment | `reading-room.tsx#recentEssays` | a script export — a query, mutation, or component handle |
| Legacy URL | `https://…` | the legacy web, through the hatch (§3) |

Fragments are disambiguated by target kind: on a markdown page they carry the durable page ID; on a script they name an export. `arbor run ./reading-room.tsx#recentEssays` and a link block rendering the same export use the identical name.

Markdown node names never expose their storage suffix. Sibling body `x.md`, child directory `x/`, and fallback body `x/_index.md` all contribute to exactly `/x`; the root `_index.md` names `/`. `.md` and `/_index.md` spellings are accepted only as compatibility aliases at resolution boundaries and immediately canonicalized. They never appear in browser URLs, API results, link healing, search results, generated types, or user-visible filenames. `x.md` may coexist with `x/`, but not with `x/_index.md` ([format.md](format.md) §1).

Links are paths, made rename-proof by identity. The path is the human-readable primary; when a page fragment's ID and its path disagree — the file was renamed, or a new file reused the old name — the ID is authoritative, so renames break no inbound links. Stale destinations heal lazily to canonical `path#id` form. Fragment-less links keep pure path semantics.

Every node has a stable global name — `(TreeID, path)`, rendered as a domain URL where an alias exists — including every node of a private tree ([wire.md](wire.md) §2). Naming is universal; access is not: resolving a private name requires a capability, so links to private material are safe to embed anywhere and simply fail to resolve without a grant. Arbor never treats an obscure name as a secret.

## 2. Resolution

Resolution happens **in the reader's workspace first**, so another author's link can land in the reader's mounted or annotated copy:

1. Tree-rooted and relative paths resolve against the enclosing tree and the containing page respectively, then canonicalize Markdown storage aliases to their extensionless logical path. Script path literals are resolved by the compiler and typed through the generated registry ([format.md](format.md) §5).
2. A page fragment consults the ID index; the ID wins over the path when they disagree.
3. A public name not already mounted resolves through its DNS `_arbor` record to `(endpoint, TreeID)` ([wire.md](wire.md) §2) and opens as a visited tree ([browser.md](browser.md) §3).
4. A `tree:` URI or invitation descriptor resolves the same way, minus DNS.
5. `system:` and `local:` are arbord-local schemes: never part of any publishable tree, never resolvable remotely.

## 3. The legacy bridge

If a public domain has no `_arbor` record, plain `https://` is the legacy hatch. In reverse, a deployed website advertises its live tree via `<link rel="arbor" …>` or the `Arbor-Tree:` response header carrying `(endpoint, TreeID)`; an Arbor-aware browser landing there upgrades to the live tree while legacy browsers see plain HTML ([wire.md](wire.md) §7, [browser.md](browser.md) §3).
