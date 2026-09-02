# Arbor locators
*Part of the [Arbor spec](../spec.md): portable references through primary
TreeID identity, tree-relative paths, revisions, and DNS/Canopy canonical
lookup.*

## Forms

Portable Arbor content uses these locator forms:

```text
arbor://tree/<TreeID>/path[;arbor-key=<base64url-key>][?application-query][#content-fragment]
./relative/tree/path[;arbor-key=<base64url-key>][?application-query][#content-fragment]
/tree-rooted/path[;arbor-key=<base64url-key>][?application-query][#content-fragment]
https://community.example/~profile/path[;arbor-key=<base64url-key>][?application-query][#content-fragment]
arbor://community.example/~profile/path[;arbor-key=<base64url-key>][?application-query][#content-fragment]
```

`arbor://tree/<TreeID>/...` directly names the primary tree identity plus a
logical path. Relative and tree-rooted paths resolve within an already selected
tree. Their portable meaning is never an operating-system path. Canonical HTTP
and `arbor://<authority>/...` names first resolve through the secondary
canonical lookup: the URI's DNS authority places/selects a Canopy, then that
Canopy resolves its longest readable registered boundary to a TreeID. `authority`
here is the URI authority component. Operating-system paths and `system:` content
addresses are facilities of a local implementation, not portable Arbor
locators; a separately specified capability field may use a `system:` reference
without making it a content locator.

Canonical public names are replaceable human names, not tree identity. A
canonical resolver returns the selected Canopy origin, the `TreeID` selected by
its longest readable registered boundary, the decoded logical path remainder, optional
immutable revision, access, and enough server provenance to perform a permitted
operation.

Every successfully resolved node locator yields the same information:

```text
(TreeID, path, stable key or null, live or revision,
 application query, content fragment)
```

## Stable keys, revisions, and fragments

When the node has a schema-derived stable key, the final raw path segment may
carry `;arbor-key=<base64url-key>`. The value is the unpadded base64url encoding
of the UTF-8 canonical key JSON. This is the single definition of that
encoding: [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON for
an array of `[field, value]` pairs in the identity rule's declared field order,
where each value is a JSON string, boolean, or finite number—for example
`[["id","x7f3q2"]]`. A schema normalizes any other backing value to a string
before it can be a key. The same canonical JSON is the `stableKey` value carried
in node references. The suffix supplies the third component of
`(TreeID, path, stable key or null)`; it is not part of the decoded logical path.

```text
arbor://tree/<TreeID>/roadmap;arbor-key=<base64url-key>
arbor://tree/<TreeID>/practices/walking;arbor-key=<base64url-key>
```

The same syntax is used for a Markdown `id`, a collection primary key, or any
later schema identity rule. There is no `PageID` locator variant and no row-only
locator shape.

The portable directory projection has one additional relative-link spelling:

```md
[Walking](walking#arbor-key=<base64url-key>)
[List](List?id=p_123#arbor-key=<base64url-key>)
```

This is a Markdown compatibility alias for the same stable-key component, not
an ordinary content fragment. A non-Arbor Markdown reader follows the normal
relative path and may simply find no matching anchor. An Arbor-aware local
reader uses the key for resolution and link healing. An Arbor HTTP renderer
rewrites the destination to the server-visible
`walking;arbor-key=<base64url-key>` form before emitting HTML, preserving the
application query unchanged.

The Markdown alias is permitted only on relative or tree-rooted authored links
whose Arbor renderer can perform that translation. Raw TreeID, canonical Arbor,
and canonical HTTP locators use the path-attached suffix directly. Legacy bare
`#<PageID>` and `#row=<key>` spellings may be accepted as input during migration,
but conforming writers emit either the Markdown alias or the path suffix.

Append `@sha256:<root>` to an Arbor tree locator to select an immutable wire root:

```text
arbor://tree/<TreeID>@sha256:<root>/notes
arbor://community.example/~alice/atlas@sha256:<root>/notes
```

A revision locator is read-only. Mutations against it fail as read-only.

A query string follows the optional identity suffix and belongs completely to
the addressed application document:

```text
arbor://tree/<TreeID>/Practice;arbor-key=<base64url-key>?id=p_123&edit
```

Arbor routing consumes neither application keys nor values. Other fragments
remain ordinary content-local navigation and are not used as node identity:

```text
arbor://tree/<TreeID>/roadmap;arbor-key=<base64url-key>#implementation
```

This separation is required for server rendering: the authority receives the
path-attached stable key on the initial HTTP request, while browsers do not send
the content fragment and executable documents retain their full query-string
namespace.

Version 0.8 does not define one Markdown relative link carrying both a stable
key and a separate within-node content fragment. Authors choose rename-healable
node navigation or within-node navigation for that link. A later structured
fragment form may add both without changing the three-part node reference.

## Parsing and canonicalization

An external URL parser separates the final raw-segment `;arbor-key=` suffix
before percent-decoding path components. A literal suffix-like filename encodes
its semicolon as `%3B`; it is data, not identity syntax. The parser then
percent-decodes each path component exactly once. Every internal logical path is
already decoded and may contain a literal `%`, including text resembling
another escape. Resolvers, routers, clients, and stores must not decode it again.
Canonical-boundary matching uses this suffix-free decoded path, including when
the locator addresses the canonical root node itself.

`.` and `..` are resolved only while parsing a relative reference or URL. A resolved logical path is absolute within its tree, contains no empty interior component, and cannot escape its tree root. Backslash and NUL are invalid logical-path characters. URL serialization percent-encodes decoded components once.

Authored `.md`, `.mdx`, `.tsx`, `/_index.md`, and legacy `tree:` spellings may be accepted as input aliases, but emitted links and canonical locations use extensionless logical paths and the locator forms above.

## Resolution rules

- A canonical server path resolves to the longest readable registered boundary, as specified by [the wire](04-wire.md#4-finding-trees); an inaccessible nested boundary is not resolved through its parent.
- A raw TreeID locator resolves independently of its current public name, using a verified endpoint hint or already-known server record.
- A relative or tree-rooted reference retains the tree scope of its resolution context and cannot cross a nested tree boundary without an explicit canonical or raw locator.
- When `stableKey` is non-null, the resolver validates it against the addressed schema. A key from a tree identity declaration may repair the path anywhere in that tree; a key from a parent's children declaration may repair only the final child component after the parent path resolves. The declaration site supplies this keyspace; the identity rule has no separate `scope` field.
- If a valid key resolves a different current path, native/local editors heal the readable path while preserving the Markdown key alias and application query. An HTTP authority redirects to the current canonical path while preserving the path-attached suffix and application query; ordinary HTTP fragment inheritance preserves a content fragment when one is present. Duplicate, invalid, inaccessible, or out-of-scope keys fail rather than falling back to a coincidental path match.
- Ambiguous identity is an error. A resolver never guesses among placements, endpoints, stable-key owners, or boundary records.

Locator resolution is separate from rendering. A successful result always retains explicit tree scope so mounted/composed child actions, search results, backlinks, and historical reads cannot silently fall back to a parent's tree.
