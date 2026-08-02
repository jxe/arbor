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
| Named HTTP URL | `https://garden.example/~alice/atlas` | a tree or node in a community namespace |
| Named Arbor URL | `arbor://garden.example/~alice/atlas` | the live Arbor form of the same canonical name |
| Person/group profile | `arbor://garden.example/~alice/` | Alice's complete public profile tree |
| Tree-ID URL | `arbor://tree/tr_7k3m…/essays/drift` | a tree or node by durable `TreeID` |
| Access link | `https://garden.example/~alice/atlas#arbor-access=secret` | revocable secret-bearing access to one tree |
| Tree-rooted path | `/essays/drift` | a logical node rooted at the enclosing shared tree when document context exists |
| System locator | `system:trees/tr_7k3m…` | a safe record in the local arbord control tree |

Shell commands accept local paths, `system:` locators, and absolute HTTP/Arbor forms. In a shell, a leading `/` is always an OS path. Contextual tree-rooted paths belong in Markdown, scripts, browser location fields, and APIs that already supply an enclosing tree; a command does not silently guess which tree `/notes` means.

A named authority represents one community. `/` is its community profile, `/~<handle>` is a complete person or group profile tree, and any exact nested path may be another shared-tree boundary. Resolution selects the longest accessible boundary and walks the remaining path inside it. A longer boundary is valid only when its parent graph contains that exact nested-tree entry. The reserved `tree` authority takes a `TreeID` as its first segment.

HTTP and Arbor spellings may name the same live content. HTTP is the universal fallback and publication surface; `arbor://` states Arbor resolution explicitly. Canonical spellings are never credentials. Private content keeps its ordinary name and still requires authority.

Person and group identity use this same locator language rather than a second name syntax. `/~alice` and `/~editors` resolve to complete public profile trees whose `TreeID`s are stable identities. Their `_index.md` documents supply mutable authored display content. Profiles may contain arbitrary descendants and independently shared nested boundaries.

An access link is deliberately noncanonical. Its fragment contains a secret that the browser converts to an authorization header; fragments and raw secrets do not enter normal HTTP request URLs or authority storage. Revocation removes the digest-based access entry. Access links are not authored into shared content.

## 2. Revisions

The optional `@{…}` suffix selects a shared tree's immutable root revision:

```text
./atlas@{sha256:7db4…}
https://garden.example/~alice/atlas@{sha256:7db4…}
arbor://garden.example/~alice/atlas/essay@{sha256:7db4…}
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

1. Normalize a local path. If it lies within one or more shared placements, choose the longest local placement prefix and resolve it to that placement's `TreeID` and tree-relative path; otherwise it remains local filesystem scope. Nested local placements are the reader's layout only and do not imply a canonical boundary in the enclosing tree.
2. Resolve named HTTP/Arbor locations through a local placement or visit first, then `/.well-known/arbor/*`. Choose the longest accessible registered boundary and walk the remainder inside that tree.
3. Resolve an access link by retaining its secret outside durable content and presenting it only as authorization. A revoked link stops resolving.
4. Resolve `arbor://tree/<TreeID>/…` from a known placement, visit, credential, or signed endpoint hint. A TreeID alone does not reveal its authority.
5. If a revision suffix is present, verify and walk that immutable root instead of the live ref.
6. Resolve a `PageID` fragment inside that selected root. Access checks happen after naming and never derive from obscurity.

Nested shared trees remain boundaries. Walking a parent locator encounters the child `TreeID`; following it requires the child's own access entry and selects the child's own live or pinned root.

The resolved local REST representation remains `NodeRef`; locators are not added as another `TreeRef` variant. Arbord or its client resolves a locator before ordinary node, file, or mutation calls.

## 5. Commands and authored links

The ordinary command surface uses locators directly:

```text
arbor browse <locator>
arbor sync [audience-options] <source-locator> <destination-locator>
arbor unsync <local-path> [<canonical-locator>]
```

The local TreeHopper profile control claims a complete reserved person-profile locator and activates the returned device credential. `connect` is account plumbing for activating an already-issued credential. `browse` accepts any resolvable locator. `sync` has two defined directions:

- live local path → named canonical child beneath a writable profile: create or reconcile identity and sync, optionally changing ACL entries;
- live or pinned remote locator → local path: create or reconcile a following or pinned placement.

Two local operands or two remote operands are invalid until a distinct copy/transfer operation is specified. Audience options (`--access` and `--clear-access`) belong only to the local-to-canonical direction and are conventionally written before the locators. One `--access` value may contain comma-separated `<subject>=<read|write|none>` entries, and the flag itself may be repeated. `public` is the everyone subject; `~<handle>` resolves in the destination community. A new boundary without audience options is private and warns; an existing boundary without them preserves its audience. Repeating either valid form is idempotent.

`unsync` removes a local placement relationship, never its local files or remote tree. Its one-operand form identifies the placement by local path. Its two-operand form accepts the local path and canonical locator in either order and removes the relationship only if both identify the same pair.

Markdown link destinations use the same logical and global forms, but portable shared content does not author OS-absolute or `system:` locators. Relative destinations resolve from the containing logical document as a directory-like base, independent of whether `x.md`, `x/_index.md`, or an implicit directory supplies its body. Storage suffixes are accepted as compatibility input and immediately canonicalized away.

## 6. Legacy-web bridge

A published HTTP page may advertise its live Arbor locator through `<link rel="arbor">` or the `Arbor-Tree` response header. An Arbor-aware browser can upgrade that page to the live or explicitly revision-pinned tree; a legacy browser continues to see HTML.
