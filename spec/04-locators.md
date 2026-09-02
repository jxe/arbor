# Arbor locators
*Part of the [Arbor spec](../spec.md): portable references through primary
TreeID identity, tree-relative paths, revisions, and DNS/Canopy canonical
lookup.*

*Owns: locator grammar, parsing, resolution, the routes that find trees, and the public HTTP projection. References: row segments ([child backings](07-child-backings.md)).*

## 1. Forms

Portable Arbor content uses these locator forms:

```text
arbor://<TreeID>/path[;arbor-key=<base64url-key>][;arbor-rev=sha256:<root>][?application-query][#content-fragment]
./relative/tree/path[;arbor-key=<base64url-key>][;arbor-rev=sha256:<root>][?application-query][#content-fragment]
/tree-rooted/path[;arbor-key=<base64url-key>][;arbor-rev=sha256:<root>][?application-query][#content-fragment]
https://community.example/~profile/path[;arbor-key=<base64url-key>][;arbor-rev=sha256:<root>][?application-query][#content-fragment]
arbor://community.example/~profile/path[;arbor-key=<base64url-key>][;arbor-rev=sha256:<root>][?application-query][#content-fragment]
```

`arbor://<TreeID>/...` directly names the primary tree identity plus a logical
path. A `TreeID` begins with `tr_`, and an underscore cannot appear in a DNS
label, so the authority component is unambiguously either a TreeID or a DNS
name; an authority beginning `tr_` that is not a well-formed TreeID is invalid.
Relative and tree-rooted paths resolve within an already selected
tree. Their portable meaning is never an operating-system path. Canonical HTTP
and `arbor://<authority>/...` names first resolve through the secondary
canonical lookup: the URI's DNS authority places/selects a Canopy, then that
Canopy resolves its longest readable registered boundary to a TreeID. `authority`
here is the URI authority component. Operating-system paths and `system:` content
addresses are facilities of a local implementation, not portable Arbor
locators; a separately specified capability field ([deferred 9](../spec.md#deferred)) may use a
`system:` reference without making it a content locator.

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

## 2. Stable keys, revisions, and fragments

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
arbor://<TreeID>/roadmap;arbor-key=<base64url-key>
arbor://<TreeID>/practices/walking;arbor-key=<base64url-key>
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

Append `;arbor-rev=sha256:<root>` to the final path segment, after any
identity suffix, to select an immutable wire root of the addressed tree:

```text
arbor://<TreeID>/notes;arbor-rev=sha256:<root>
arbor://community.example/~alice/atlas/notes;arbor-rev=sha256:<root>
./notes;arbor-key=<base64url-key>;arbor-rev=sha256:<root>
```

A revision locator is read-only. Mutations against it fail as read-only. The
identity suffix and the revision suffix are the only segment parameters; they
appear at most once each and in that order.

A query string follows the segment parameters and belongs completely to the
addressed application document:

```text
arbor://<TreeID>/Practice;arbor-key=<base64url-key>?id=p_123&edit
```

Arbor routing consumes neither application keys nor values. Other fragments
remain ordinary content-local navigation and are not used as node identity:

```text
arbor://<TreeID>/roadmap;arbor-key=<base64url-key>#implementation
```

This separation is required for server rendering: the authority receives the
path-attached stable key on the initial HTTP request, while browsers do not send
the content fragment and executable documents retain their full query-string
namespace.

This version does not define one Markdown relative link carrying both a
stable key and a separate within-node content fragment ([deferred 7](../spec.md#deferred)).
Authors choose rename-healable node navigation or within-node navigation for
that link. A later structured fragment form may add both without changing the
three-part node reference.

## 3. Parsing and canonicalization

An external URL parser separates the final raw segment's parameter block,
beginning at its first `;arbor-`, before percent-decoding path components. A
literal suffix-like filename encodes its semicolon as `%3B`; it is data, not
identity syntax. Within the block, any parameter other than `arbor-key` and
`arbor-rev`, a repeated parameter, an empty value, or the two in the wrong
order makes the locator invalid rather than path data. The parser then
percent-decodes each path component exactly once. Every internal logical path is
already decoded and may contain a literal `%`, including text resembling
another escape. Resolvers, routers, clients, and stores must not decode it again.
Canonical-boundary matching uses this suffix-free decoded path, including when
the locator addresses the canonical root node itself.

`.` and `..` are resolved only while parsing a relative reference or URL. A resolved logical path is absolute within its tree, contains no empty interior component, and cannot escape its tree root. Backslash and NUL are invalid logical-path characters. URL serialization percent-encodes decoded components once.

Authored `.md`, `.mdx`, `.tsx`, and `/_index.md` spellings may be accepted as input aliases, but emitted links and canonical locations use extensionless logical paths and the locator forms above.

## 4. Resolution rules

- A canonical server path resolves to the longest readable registered boundary, as specified by [the wire](#5-finding-trees); an inaccessible nested boundary is not resolved through its parent.
- A raw TreeID locator resolves independently of its current public name, using a verified endpoint hint or already-known server record.
- A relative or tree-rooted reference retains the tree scope of its resolution context and cannot cross a nested tree boundary without an explicit canonical or raw locator.
- When `stableKey` is non-null, the resolver validates it against the addressed schema. A key from a tree identity declaration may repair the path anywhere in that tree; a key from a parent's children declaration may repair only the final child component after the parent path resolves. The declaration site supplies this keyspace; the identity rule has no separate `scope` field.
- If a valid key resolves a different current path, native/local editors heal the readable path while preserving the Markdown key alias and application query. An HTTP authority redirects to the current canonical path while preserving the path-attached suffix and application query; ordinary HTTP fragment inheritance preserves a content fragment when one is present. Duplicate, invalid, inaccessible, or out-of-scope keys fail rather than falling back to a coincidental path match.
- Ambiguous identity is an error. A resolver never guesses among placements, endpoints, stable-key owners, or boundary records.

Locator resolution is separate from rendering. A successful result always retains explicit tree scope so mounted/composed child actions, search results, backlinks, and historical reads cannot silently fall back to a parent's tree.

## 5. Finding trees

Canonical URLs are a secondary index over the global TreeID space:

```ts
type CanonicalURLs = Map<`${DNSName}${PathPrefix}`, TreeID>
```

The DNS name reaches one Canopy through normal DNS and HTTPS. Within that
authority, resolution selects the longest readable registered path boundary
and returns its TreeID plus the remaining logical path and optional stable key.
URL nesting does not imply common storage, history, ownership, or access: if
one tree is canonical at `/~alice` and another at `/~alice/atlas`, the latter
boundary wins below it.

Canonical placement is mutable naming. Changing the Canopy's DNS name, moving
a registered boundary, or renaming a node changes canonical URLs without
changing TreeID or stable key. Moving the physical server behind an unchanged
DNS origin changes neither. A raw `arbor://<TreeID>/...` locator remains the
primary address when a canonical name is absent, unknown, inaccessible, or
changing.

```text
GET /.arbor/health
GET /.arbor/account
GET /.arbor/trees
GET /.well-known/arbor[/{path}]
```

Authenticated account and tree-list reads use explicit envelopes carrying
`observedThrough`; bare arrays and descriptors are not mutable responses. The
same snapshot-then-observe rule as the core tree API applies. For an ordinary
tree, its accepted-update ID is its `observedThrough` cursor unless a later
event other than an accepted update advances that tree's observation stream; `tree.update` remains
the content synchronization base.

Well-known and canonical-path resolution return `LocatorResolution`, using the
longest readable registered boundary. Inaccessible nested boundaries cannot be
read through a parent. The private account-configuration tree is absent from
public discovery and canonical resolution.

```ts
type LocatorResolution = {
  ref: NodeRef;
  enclosingTree: TreeDescriptor;
  historical: boolean;
  observedThrough: EventCursor;
};
```

## 6. Public HTTP projection

Readable canonical paths have safe HTTP and `arbor://` projections. HTML,
Markdown, files, and redirects retain canonical tree/path provenance and never
broaden access. Historical roots remain immutable and read-only. The server
does not publish or resolve the account-configuration tree.

Rows in a recognized synchronized CSV/JSON/JSONL collection file have the same
ordinary public path and stable-key locator projection as expanded children.
The parent page lists those logical rows rather than `_store.*` or `schema.ts`.
A path lookup or stable-key lookup may render a row as an HTML property page or
a Markdown data projection; a stale readable path redirects permanently to the
current row path while preserving the key, application query, and content
fragment. Public projection never materializes a row as a Markdown file and
never exposes the reserved representation objects as children.
