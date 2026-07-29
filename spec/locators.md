# Locators
*Part of the [Arbor spec](../spec.md): the common syntax for naming live or historical content.*

An **Arbor locator** is a user-facing expression that tells Arbor what content to resolve. It is deliberately broader than a URL: the same command may receive a local path, a canonical network name, a raw tree identity, or a historical revision.

“Reference” is reserved for already resolved protocol values such as `NodeRef` and the wire's current-root ref. A locator is input to resolution; it may depend on the current directory, enclosing tree, local placements, endpoint hints, or authority namespace.

## 1. Forms

```text
<location>[@{<revision>}][#<fragment>]
```

| Location form | Example | Meaning |
|---|---|---|
| Relative local path | `./notes` or `../roadmap` | an OS path from the command's current directory, or a logical path from a containing document |
| Absolute local path | `/Users/joe/notes` or `~/notes` | an OS path on this device |
| Named HTTP URL | `https://notes.example/atlas` | a tree or node in a named authority namespace |
| Named Arbor URL | `arbor://notes.example/atlas` | the live Arbor form of the same canonical name |
| Personal root | `arbor://alice.example/` | the root profile of Alice's public personal tree |
| Tree-ID URL | `arbor://tree/tr_7k3m…/essays/drift` | a tree or node by durable `TreeID` |
| Access link | `https://notes.example/.arbor/access/ac_7k3m…#secret` | a one-claim route to a tree's canonical locator |
| Tree-rooted path | `/essays/drift` | a logical node rooted at the enclosing shared tree when document context exists |
| System locator | `system:trees/tr_7k3m…` | a safe record in the local arbord control tree |

Shell commands accept local paths, `system:` locators, and absolute HTTP/Arbor forms. In a shell, a leading `/` is always an OS path. Contextual tree-rooted paths belong in Markdown, scripts, browser location fields, and APIs that already supply an enclosing tree; a command does not silently guess which tree `/notes` means.

A named authority normally resolves its first path segment to a shared-tree boundary and treats the remainder as a path within that tree. A personal authority may also mount its owner's public personal tree at `/`; registered child boundaries still resolve independently and do not inherit the root tree's public access. The reserved `tree` authority takes a `TreeID` as its first segment.

HTTP and Arbor spellings may name the same live content. HTTP is the universal fallback and publication surface; `arbor://` states Arbor resolution explicitly. Canonical spellings are never credentials. Private content keeps its ordinary name and still requires authority.

Person and group identity use this same locator language rather than a second name syntax. A person's canonical root locator resolves to their public personal tree; its `TreeID` is the stable person identity and its root Markdown document supplies the mutable display profile. A group locator resolves to an ordinary `type: group` Markdown document by `(TreeID, PageID)`. Commands and access controls inspect the resolved document type, retain the durable identity, and never treat a display name as authority.

An access link is deliberately noncanonical. Its fragment contains a claim secret that Arbor consumes once, stores as an issued credential, and replaces with the ordinary credential-free canonical locator. The fragment is never sent in a normal HTTP request. Access links are valid `browse` and remote-source `sync` inputs but are not authored into shared content.

## 2. Revisions

The optional `@{…}` suffix selects a shared tree's immutable root revision:

```text
./atlas@{sha256:7db4…}
https://notes.example/atlas@{sha256:7db4…}
arbor://notes.example/atlas/essay@{sha256:7db4…}
arbor://tree/tr_7k3m…/essay@{sha256:7db4…}
```

Omitting the suffix means the live tree: the current verified local or authority tip. The first normative revision selector is the full root object hash `sha256:<hex>`. Friendly labels, dates, ancestry expressions, and ranges are not accepted until their meaning and authority are specified.

The revision always selects the whole tree root; the location's node path is then walked inside that immutable graph. A local path can use a revision suffix only when it resolves inside a known shared-tree placement. Unpromoted local files have no revision namespace.

A revision-selected locator is read-only. Browsing it opens a historical view. Syncing it to a local path creates or reconciles a pinned read-only placement rather than following future tips. The pin changes only when the authored locator changes.

`@{` begins a revision suffix only when a valid selector and closing `}` occupy the end of the location, before any fragment. A literal local or logical filename with that spelling escapes the `@` as `%40`.

## 3. Fragments and document identity

A fragment follows the optional revision suffix:

```text
../roadmap@{sha256:7db4…}#x7f3q2
reading-room.tsx#recentEssays
```

On Markdown, the fragment is the target document's durable `PageID`. When path and ID disagree within the selected tree revision, the ID wins. On a script it names an exported query, mutation, or component. On an access link it is the one-time claim secret. Target kind disambiguates these uses; shared content never authors an access link.

Bodyless directories begin path-only. Arbor minimally materializes Markdown identity before creating an identity-bearing link or performing an authored move that requires continuity. Ordinary files remain path-only; Arbor does not invent a durable `NodeID` for every filesystem object.

## 4. Resolution

Resolution produces a concrete tree, logical path, optional immutable root hash, and optional document/export identity:

1. Normalize a local path. If it lies within a shared placement, resolve it to that placement's `TreeID` and tree-relative path; otherwise it remains local filesystem scope.
2. Resolve named HTTP/Arbor locations through a local placement or visit first, then the authority namespace. The reference host uses `/.well-known/arbor` for an optional personal tree mounted at `/` and `/.well-known/arbor/<segment>` for named child trees.
3. Resolve an access link by atomically claiming it for the current personal `TreeID`, storing the issued credential, and continuing with the returned canonical locator. Repeating a successfully claimed link as the same person is idempotent.
4. Resolve `arbor://tree/<TreeID>/…` from a known placement, visit, credential, or signed endpoint hint. A TreeID alone does not reveal its authority.
5. If a revision suffix is present, verify and walk that immutable root instead of the live ref.
6. Resolve a `PageID` fragment inside that selected root. Access checks happen after naming and never derive from obscurity.

Nested shared trees remain boundaries. Walking a parent locator encounters the child `TreeID`; following it requires the child's own access entry and selects the child's own live or pinned root.

The resolved local REST representation remains `NodeRef`; locators are not added as another `TreeRef` variant. Arbord or its client resolves a locator before ordinary node, file, or mutation calls.

## 5. Commands and authored links

The ordinary command surface uses locators directly:

```text
arbor browse <locator>
arbor sync <source-locator> <destination-locator> [-<mode>]
```

`browse` accepts any resolvable locator. `sync` has two defined directions:

- live local path → named canonical URL: create or reconcile identity, self-sync, and publication;
- live or pinned remote locator or access link → local path: claim when necessary, then create or reconcile a following or pinned placement.

Two local operands or two remote operands are invalid until a distinct copy/transfer operation is specified. Publication mode belongs only to the owner direction. Repeating either valid form is idempotent.

Markdown link destinations use the same logical and global forms, but portable shared content does not author OS-absolute or `system:` locators. Relative destinations resolve from the containing logical document as a directory-like base, independent of whether `x.md`, `x/_index.md`, or an implicit directory supplies its body. Storage suffixes are accepted as compatibility input and immediately canonicalized away.

## 6. Legacy-web bridge

A published HTTP page may advertise its live Arbor locator through `<link rel="arbor">` or the `Arbor-Tree` response header. An Arbor-aware browser can upgrade that page to the live or explicitly revision-pinned tree; a legacy browser continues to see HTML.
