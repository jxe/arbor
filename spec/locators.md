# Arbor locators
*Part of the [Arbor spec](../spec.md): one locator language for local, shared, historical, and system content.*

## Forms

An Arbor locator is one of:

```text
/absolute/local/path
./relative/local/path
https://community.example/~profile/path
arbor://community.example/~profile/path
arbor://tree/<TreeID>/path
system:device
system:trees
```

Canonical HTTP and `arbor://<authority>/...` names resolve through the community authority. `arbor://tree/<TreeID>/...` is the raw identity locator and remains valid when a public name changes. Local paths resolve through the local arbord and its placement registry. `system:` locators address the safe virtual control tree.

Canonical public names are replaceable human names, not tree identity. A resolver returns a concrete tree scope, decoded logical path, optional immutable root, access, and enough authority provenance to perform a permitted operation.

## Revisions and fragments

Append `@sha256:<root>` to an Arbor tree locator to select an immutable wire root:

```text
arbor://tree/<TreeID>@sha256:<root>/notes
arbor://community.example/~alice/atlas@sha256:<root>/notes
```

A revision locator is read-only. It may be browsed transiently but never creates a pinned persistent placement. Mutations against it fail as read-only.

A fragment identifies content within the resolved node. Markdown `PageID` fragments are opaque:

```text
arbor://tree/<TreeID>/roadmap#opaque-page-id
```

Clients must not validate fragments as six-character lowercase IDs. Other fragment interpretations may be defined by the addressed content type without changing tree resolution.

## Parsing and canonicalization

An external URL parser percent-decodes each path component exactly once at the parsing boundary. Every internal logical path is already decoded and may contain a literal `%`, including text resembling another escape. Resolvers, routers, clients, and stores must not decode it again.

`.` and `..` are resolved only while parsing a local path or URL. A resolved logical path is absolute within its tree, contains no empty interior component, and cannot escape its tree root. Backslash and NUL are invalid logical-path characters. URL serialization percent-encodes decoded components once.

Authored `.md`, `/_index.md`, and legacy `tree:` spellings may be accepted as input aliases, but emitted links and canonical locations use extensionless logical paths and the locator forms above.

## Resolution rules

- A local path uses the longest canonical placement-path prefix from [`trees.yaml`](system.md#placement-registry-treesyaml). If none exists, it is `tree: "local"` and has no durable Arbor identity.
- A nested placement enters the child tree. Parent discovery, watching, indexing, snapshots, pulls, and deletion exclude that mounted root.
- A canonical authority path uses the longest registered canonical boundary prefix, subject to access. An inaccessible nested boundary is not resolved through its parent.
- A raw TreeID locator resolves independently of its current public name, using a verified endpoint hint or already-known authority record.
- When the same live shared tree has a local placement, a local client may resolve a canonical or raw locator to that placement. The identity and decoded logical path remain unchanged.
- Ambiguous identity is an error. A resolver never guesses among placements, endpoints, PageIDs, or boundary records.

Locator resolution is separate from rendering. A successful result always retains explicit tree scope so projected child actions, search results, backlinks, and historical reads cannot silently fall back to a parent's tree.
