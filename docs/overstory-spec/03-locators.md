# Overstory locators
*Part of the [Overstory spec](README.md): portable references through primary
TreeID identity, tree-relative paths, revisions, and DNS/host canonical
lookup.*

*Owns: locator grammar, parsing, resolution, the routes that find trees, and the public HTTP projection. References: row segments ([child backings](06-child-backings.md)).*

## 1. Forms

Portable Overstory content uses these locator forms:

```text
arbor://<TreeID>/path[;arbor-key=<key-token>][;arbor-rev=sha256:<root>][?application-query][#content-fragment]
./relative/tree/path[;arbor-key=<key-token>][;arbor-rev=sha256:<root>][?application-query][#content-fragment]
/tree-rooted/path[;arbor-key=<key-token>][;arbor-rev=sha256:<root>][?application-query][#content-fragment]
https://canopy.example/path[;arbor-key=<key-token>][;arbor-rev=sha256:<root>][?application-query][#content-fragment]
arbor://canopy.example/path[;arbor-key=<key-token>][;arbor-rev=sha256:<root>][?application-query][#content-fragment]
```

`arbor://<TreeID>/...` directly names the primary tree identity plus a logical
path. A `TreeID` begins with `tr_`, and an underscore cannot appear in a DNS
label, so the authority component is unambiguously either a TreeID or a DNS
name; an authority beginning `tr_` that is not a well-formed TreeID is invalid.
Relative and tree-rooted paths resolve within an already selected
tree. Their portable meaning is never an operating-system path. Canonical HTTP
and `arbor://<authority>/...` names first resolve through the secondary
canonical lookup: the URI's DNS authority places/selects a host, then that
host resolves its longest readable registered boundary to a TreeID. `authority`
here is the URI authority component. Operating-system paths and `system:` content
addresses are facilities of a local implementation, not portable Overstory
locators; a separately specified capability field ([deferred 9](README.md#deferred)) may use a
`system:` reference without making it a content locator.

Canonical public names are replaceable human names, not tree identity. A
canonical resolver returns the selected host origin, the `TreeID` selected by
its longest readable registered boundary, the decoded logical path remainder, optional
immutable revision, access, and enough server provenance to perform a permitted
operation.

A canonical path is a host-assigned name, not a profile identifier. Overstory
does not prescribe where profiles, groups, or any other trees are placed:
which paths exist, their shape, and which account may declare each are host
policy ([canopyd's](../architecture/canopyd/README.md#accounts-and-canonical-paths) uses `/~name` segments). The same path at two
hosts implies no relationship, and one profile `TreeID` may be associated with
differently shaped account locators at several hosts. An account locator may
also exist before any tree is registered at it. Profile identity equality comes only from the profile `TreeID` recorded by the
account, never from a handle or canonical URL. A new person-profile TreeID is
self-certifying as defined by [accounts §1.1](04-accounts-and-devices.md#11-beginning-a-person-identity);
ordinary and group-profile TreeIDs remain opaque identifiers.

Every successfully resolved node locator yields the same information:

```text
(TreeID, path, stable key or null, live or revision,
 application query, content fragment)
```

## 2. Stable keys, revisions, and fragments

A node's stable key is [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)
canonical JSON for an array of `[field, value]` pairs in the identity rule's
declared field order, where each value is a JSON string, boolean, or finite
number—for example `[["id","x7f3q2"]]`. A schema normalizes any other backing
value to a string before it can be a key. This canonical JSON is the
`stableKey` value carried in node references.

A locator carries the key as a **key token**, the single textual encoding of
a stable key:

```text
key-token = pair *( "," pair )          ; pairs in key order
pair      = name ":" string-value       ; a string value
          / name "=" literal            ; `true`, `false`, or RFC 8785 number text
```

`name` and `string-value` percent-encode, as `%XX` with uppercase hex over
UTF-8, every byte outside the URI unreserved set `A-Z a-z 0-9 - . _ ~`. A
decoder accepts a token only if encoding the key it decodes reproduces the
token exactly, so each key has one token and each token one key. Markdown IDs
are minted from `[a-z0-9]`, so their tokens read as written and a plain text
search for an ID finds every link that names it:

| Key | Token |
|---|---|
| `[["id","x7f3q2"]]` | `id:x7f3q2` |
| `[["slug","walking"],["lang","en"]]` | `slug:walking,lang:en` |
| `[["id",42]]` | `id=42` |
| `[["t","a b"]]` | `t:a%20b` |

The token appears in exactly two places, one per kind of surface:

| Surface | Spelling |
|---|---|
| Node reference (`NodeRef.stableKey`) | the canonical key JSON itself |
| `arbor://`, canonical HTTP, and tree-rooted locators; any locator that also carries a revision or a content fragment | `;arbor-key=<key-token>` on the final path segment |
| Relative link written in Markdown | `<file>#arbor-key=<key-token>` (§2.1) |
| Markdown document identity | frontmatter `id: x7f3q2`, which is the key `[["id","x7f3q2"]]` ([directory format](02-directory-format.md#3-properties-markdown-content-and-identity)) |
| Collection row child segment | the row segment rule of [child backings](06-child-backings.md) (still under review, [Postgres 005](../../plans/postgres/005-representation-equivalence.md)) |

The suffix supplies the third component of `(TreeID, path, stable key or
null)`; it is not part of the decoded logical path.

```text
arbor://<TreeID>/roadmap;arbor-key=id:x7f3q2
arbor://<TreeID>/practices/walking;arbor-key=slug:walking
```

The same syntax is used for a Markdown `id`, a collection primary key, or any
later schema identity rule. There is no `PageID` locator variant and no row-only
locator shape. A bare `#<fragment>` is only ever a content fragment: earlier
bare `#<PageID>` and `#row=<key>` input, and base64url key tokens, are no longer
read.

### 2.1 Links written in Markdown

A relative link in a Markdown file is an ordinary relative URL, so any Markdown
reader or editor follows it:

- It resolves against the tree directory that holds the source file: the
  parent directory for `x.md`, and `x/` itself for `x/_index.md`. A node
  whose body is not stored yet resolves as if it had `x/_index.md`.
- Writers name the target's body file: `Calendar.md`, `Picture-of-Life/Foo.md`,
  `x/_index.md`. A target with no Markdown file of its own, such as a row
  inside a collection file or a directory without a body, is named by its
  extensionless logical path. Readers accept `x.md`, `x/_index.md`, `x/`, and
  `x` as the same node.
- The key is the Markdown alias `#arbor-key=<key-token>`, which a
  non-Overstory reader treats as a missing anchor and ignores:

```md
[Walking](walking.md#arbor-key=slug:walking)
[List](List/_index.md?id=p_123#arbor-key=id:k2m9xq)
```

The alias is the same stable-key component as the path suffix, not an
ordinary content fragment, and is permitted only on relative authored links.
An Overstory HTTP renderer rewrites the destination to the server-visible
`walking;arbor-key=slug:walking` form before emitting HTML, preserving the
application query unchanged. A link that needs a content fragment or a
revision as well as a key uses the path suffix instead, for example
`Calendar.md;arbor-key=id:h31mlm#june`, which Overstory resolves but other
Markdown readers do not.

Append `;arbor-rev=sha256:<root>` to the final path segment, after any
identity suffix, to select an immutable Overstory root of the addressed tree:

```text
arbor://<TreeID>/notes;arbor-rev=sha256:<root>
arbor://community.example/~alice/atlas/notes;arbor-rev=sha256:<root>
./notes.md;arbor-key=<key-token>;arbor-rev=sha256:<root>
```

A revision locator is read-only. Mutations against it fail as read-only. The
identity suffix and the revision suffix are the only segment parameters; they
appear at most once each and in that order.

A query string follows the segment parameters and belongs completely to the
addressed application document:

```text
arbor://<TreeID>/Practice;arbor-key=<key-token>?id=p_123&edit
```

Overstory routing consumes neither application keys nor values. Other fragments
remain ordinary content-local navigation and are not used as node identity:

```text
arbor://<TreeID>/roadmap;arbor-key=<key-token>#implementation
```

This separation is required for server rendering: the host receives the
path-attached stable key on the initial HTTP request, while browsers do not send
the content fragment and executable documents retain their full query-string
namespace.

The Markdown alias cannot carry a content fragment as well
([deferred 7](README.md#deferred)); such a link uses the path suffix (§2.1).

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

`x.md`, `x/_index.md`, and `x/` are input spellings of the node `x`. Links written in Markdown name the physical body file (§2.1); canonical URLs, API paths, and every other emitted locator use extensionless logical paths. `.mdx` and `.tsx` stay literal path components here: whether one is a node's executable body is decided by the tree's [directory format](02-directory-format.md#2-mapping-files-and-directories-to-nodes), not by the locator parser.

## 4. Resolution rules

- A canonical server path resolves to the longest readable registered boundary, as specified by [the protocol](#5-finding-trees); an inaccessible nested boundary is not resolved through its parent.
- A raw TreeID locator resolves independently of its current public name, using a verified endpoint hint or already-known server record.
- A relative or tree-rooted reference retains the tree scope of its resolution context and cannot cross a nested tree boundary without an explicit canonical or raw locator.
- When `stableKey` is non-null, the resolver validates it against the addressed schema. A key from a tree identity declaration may repair the path anywhere in that tree; a key from a parent's children declaration may repair only the final child component after the parent path resolves. The declaration site supplies this keyspace; the identity rule has no separate `scope` field.
- If a valid key resolves a different current path, local editors heal the link to name the target's current file (§2.1), preserving the key, application query, and content fragment. When a source file itself moves or changes body form (`x.md` ↔ `x/_index.md`), the writer that moves it rewrites its own relative links against the new directory in the same change. An HTTP authority redirects to the current canonical path while preserving the path-attached suffix and application query; ordinary HTTP fragment inheritance preserves a content fragment when one is present. Duplicate, invalid, inaccessible, or out-of-scope keys fail rather than falling back to a coincidental path match.
- Ambiguous identity is an error. A resolver never guesses among placements, endpoints, stable-key owners, or boundary records.
- An authored source locator resolves from its defining module through explicit logical placements and nested tree boundaries; an imported helper retains the resolution context of the module that authored the locator. Physical filesystem paths, sampled table names and the current browser document are never fallback resolution contexts. A locator that is unavailable, ambiguous, stale or unauthorized fails before data access and is never redirected to a same-named store: matching names are not proof of identity.

Locator resolution is separate from rendering. A successful result always retains explicit tree scope so mounted/composed child actions, search results, backlinks, and historical reads cannot silently fall back to a parent's tree.

## 5. Finding trees

Canonical URLs are a secondary index over the global TreeID space:

```ts
type CanonicalURLs = Map<`${DNSName}${PathPrefix}`, TreeID>
```

The DNS name reaches one host through normal DNS and HTTPS. Within that
authority, resolution selects the longest readable registered path boundary
and returns its TreeID plus the remaining logical path and optional stable key.
URL nesting does not imply common storage, history, ownership, or access: if
one tree is canonical at `/~alice` and another at `/~alice/atlas`, the latter
boundary wins below it.

Host policy assigns each registered canonical boundary to the account allowed
to declare it ([canopyd's policy](../architecture/canopyd/README.md#accounts-and-canonical-paths)). Longest-boundary lookup
resolves declared trees below a path whether or not a tree is registered at
the path itself. No allocation rule is part of the portable locator grammar.

Canonical placement is mutable naming. Changing the host's DNS name, moving
a registered boundary, or renaming a node changes canonical URLs without
changing TreeID or stable key. Moving the physical server behind an unchanged
DNS origin changes neither. A raw `arbor://<TreeID>/...` locator remains the
primary address when a canonical name is absent, unknown, inaccessible, or
changing.

```text
GET /.arbor/health
GET /.arbor/integrity
GET /.arbor/account
GET /.arbor/trees
GET /.well-known/arbor[/{path}]
```

`health` is a cheap readiness check that answers `{"status":"ok"}` while the
server's own database is consistent; poll it freely. `integrity` audits every
object reachable from retained history and can take minutes on a large server;
concurrent requests share one audit, and it is for operators, not polling.

Authenticated account and tree-list reads use explicit envelopes carrying
`observedThrough`; bare arrays and descriptors are not mutable responses. The
same snapshot-then-observe rule as the core tree API applies. The accepted-update
ID remains the content synchronization base; `observedThrough` independently records
the read/watch boundary. Clients must not substitute one for the other, even if an
implementation happens to encode them identically.

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
The parent page lists those logical rows rather than `_store.*` or `schema.cddl`.
A path lookup or stable-key lookup may render a row as an HTML property page or
a Markdown data projection; a stale readable path redirects permanently to the
current row path while preserving the key, application query, and content
fragment. Public projection never materializes a row as a Markdown file and
never exposes the reserved representation objects as children.
