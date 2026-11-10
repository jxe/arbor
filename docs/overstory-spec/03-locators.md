# Overstory locators
*Part of the [Overstory spec](README.md): portable references through primary
TreeID identity, tree-relative paths, revisions, and DNS/host canonical
lookup.*

*Owns: locator grammar, parsing, resolution, the routes that find trees, and the public HTTP projection. References: row segments ([child backings](06-child-backings.md)).*

## 1. Forms

Portable Overstory content uses these locator forms:

```text
overstory://<TreeID>/path[;overstory-key=<key-token>][;overstory-rev=sha256:<root>][?application-query][#content-fragment]
./relative/tree/path[;overstory-key=<key-token>][;overstory-rev=sha256:<root>][?application-query][#content-fragment]
/tree-rooted/path[;overstory-key=<key-token>][;overstory-rev=sha256:<root>][?application-query][#content-fragment]
https://host.example/path[;overstory-key=<key-token>][;overstory-rev=sha256:<root>][?application-query][#content-fragment]
overstory://host.example/path[;overstory-key=<key-token>][;overstory-rev=sha256:<root>][?application-query][#content-fragment]
https://host.example/account-path#overstory-invite=<code>
overstory://host.example/account-path#overstory-invite=<code>
```

`overstory://<TreeID>/...` directly names the primary tree identity plus a logical
path. A `TreeID` begins with `tr_`, and an underscore cannot appear in a DNS
label, so the authority component is unambiguously either a TreeID or a DNS
name; an authority beginning `tr_` that is not a well-formed TreeID is invalid.
Relative and tree-rooted paths resolve within an already selected
tree. Their portable meaning is never an operating-system path. Canonical HTTP
and `overstory://<authority>/...` names first resolve through the secondary
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
policy ([overstoryd's](../architecture/overstoryd/README.md#accounts-and-canonical-paths) uses `/~name` segments). The same path at two
hosts implies no relationship, and one profile `TreeID` may be associated with
differently shaped account locators at several hosts. An account locator may
also exist before any tree is registered at it. Profile identity equality comes only from the profile `TreeID` recorded by the
account, never from a handle or canonical URL.

A profile on another host may be named by its canonical locator there
(`https://home.example/~alice` or `overstory://home.example/~alice`) wherever a
host's configuration names a profile: a group's member, which in the
community with a handle is a placement account
([accounts §1.3](04-accounts-and-devices.md#13-placement-accounts)), or a
rule's subject ([access control §1](05-access-control.md#1-subjects-and-rules)).
A group names its members in its own profile tree, so the pin is kept for
that group. The
locator's authority is where the host reads that profile. The host resolves it
there when an entry naming it is first accepted and **pins** the Profile
TreeID it resolved to, as host state outside any configuration file; the entry
then names that TreeID. If a later resolution yields another TreeID, the entry
matches nobody until it is edited, which pins afresh, so a renamed or reused
handle at the other host never moves a reservation or a rule to another
profile. A locator naming the host itself resolves locally, like a bare
TreeID. A new person-profile TreeID is
self-certifying as defined by [accounts §1.1](04-accounts-and-devices.md#11-beginning-a-person-identity);
ordinary and group-profile TreeIDs remain opaque identifiers.

### 1.1 Domain locators

A person may name their profile by a DNS name they control, so that
`https://alice.example` (or `overstory://alice.example`) names them wherever
their profile is homed. A profile locator with no path is a **domain
locator**. Its authority is a DNS name of at least two labels, never an IP
address; a loopback authority (`127.0.0.1`, `localhost`, `[::1]`, with a port)
is accepted for local test hosts. Its canonical spelling is its origin, with a
lowercase host and no implied port.

A domain names a profile only when both directions agree:

1. **The domain names the profile** by its locator at its home host, in a DNS
   TXT record at `_overstory.<domain>`:

   ```text
   _overstory.alice.example.  TXT  "profile=https://garden.example/~alice"
   ```

   or in a JSON file at `https://<domain>/.well-known/overstory-profile`,
   fetched without following redirects:

   ```json
   { "profile": "https://garden.example/~alice" }
   ```

   A record's locator must be a locator at a home host, never another
   domain. TXT records not beginning `profile=` are ignored. When both forms
   are published, every `profile=` record and the file must name the same
   locator; records that disagree, or a malformed one, name nobody. A
   loopback domain has only the file. When neither can be read, or one cannot
   and the other names nothing, the lookup is an outage, not an answer.
2. **The profile names the domain.** The named locator resolves (as any
   profile locator does) to a person-profile TreeID whose root front matter is
   `type: person` and lists the domain, as written, in `domains`
   ([accounts §1](04-accounts-and-devices.md#1-profiles-and-host-accounts)),
   read anonymously at the home host.

The first stops a profile from claiming a domain it does not control; the
second stops a domain from claiming a profile that does not want it. A domain
locator is accepted wherever a profile locator names a person: a rule's
subject and a group's member. A host pins it to the TreeID it resolved to, as
above, and resolves it again on the same schedule; the **home host** the
domain names is remembered with the resolution. When the person moves home
hosts and updates the record, the pin keeps the same TreeID, so every rule and
membership written with the domain keeps naming them. A resolution that names
another TreeID, or none, makes the entry match nobody, as for any pin.

A domain names a person, never a group. A community reservation and an
invitation accepted as a placement
([accounts §1.3–1.4](04-accounts-and-devices.md#13-placement-accounts))
still name the profile by its locator at its home host, since a placement
account records that home host.

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
| `overstory://`, canonical HTTP, and tree-rooted locators; any locator that also carries a revision or a content fragment | `;overstory-key=<key-token>` on the final path segment |
| Relative link written in Markdown | `<file>#overstory-key=<key-token>` (§2.1) |
| Markdown document identity | frontmatter `id: x7f3q2`, which is the key `[["id","x7f3q2"]]` ([directory format](02-directory-format.md#3-properties-markdown-content-and-identity)) |
| Collection row child segment | the row segment rule of [child backings](06-child-backings.md) (still under review, [Postgres 001](../../plans/later/postgres-001-postgres-backed-collections.md#open-from-the-old-plans)) |

The suffix supplies the third component of `(TreeID, path, stable key or
null)`; it is not part of the decoded logical path.

```text
overstory://<TreeID>/roadmap;overstory-key=id:x7f3q2
overstory://<TreeID>/practices/walking;overstory-key=slug:walking
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
  of a logical collection or a directory without a body, is named by its
  extensionless logical path. Readers accept `x.md`, `x/_index.md`, `x/`, and
  `x` as the same node.
- The key is the Markdown alias `#overstory-key=<key-token>`, which a
  non-Overstory reader treats as a missing anchor and ignores:

```md
[Walking](walking.md#overstory-key=slug:walking)
[List](List/_index.md?id=p_123#overstory-key=id:k2m9xq)
```

The alias is the same stable-key component as the path suffix, not an
ordinary content fragment, and is permitted only on relative authored links.
An Overstory HTTP renderer rewrites the destination to the server-visible
`walking;overstory-key=slug:walking` form before emitting HTML, preserving the
application query unchanged. A link that needs a content fragment or a
revision as well as a key uses the path suffix instead, for example
`Calendar.md;overstory-key=id:h31mlm#june`, which Overstory resolves but other
Markdown readers do not.

Append `;overstory-rev=sha256:<root>` to the final path segment, after any
identity suffix, to select an immutable Overstory root of the addressed tree:

```text
overstory://<TreeID>/notes;overstory-rev=sha256:<root>
overstory://community.example/~alice/atlas/notes;overstory-rev=sha256:<root>
./notes.md;overstory-key=<key-token>;overstory-rev=sha256:<root>
```

A revision locator is read-only. Mutations against it fail as read-only. The
identity suffix and the revision suffix are the only segment parameters of a
node locator; they appear at most once each and in that order.

A query string follows the segment parameters and belongs completely to the
addressed application document:

```text
overstory://<TreeID>/Practice;overstory-key=<key-token>?id=p_123&edit
```

Overstory routing consumes neither application keys nor values. Other fragments
remain ordinary content-local navigation and are not used as node identity:

```text
overstory://<TreeID>/roadmap;overstory-key=<key-token>#implementation
```

This separation is required for server rendering: the host receives the
path-attached stable key on the initial HTTP request, while browsers do not send
the content fragment and executable documents retain their full query-string
namespace.

The Markdown alias cannot carry a content fragment as well
([deferred 7](README.md#deferred)); such a link uses the path suffix (§2.1).

### 2.2 Invitation links

An invitation to claim an account is that account's locator at its host with
the invitation code as the fragment. It has two spellings, the same string
apart from the scheme:

```text
https://community.example/~alice#overstory-invite=<code>
overstory://community.example/~alice#overstory-invite=<code>

invite-code = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" )   ; URI unreserved
```

The `https://` spelling is the one that is shared: a browser opening it shows
the host's page for the address, which offers the `overstory://` spelling to
open in a client. Like `#overstory-access=` and `#overstory-key=`, the code
is a fragment, so no request carries it to a server in a URL. A loopback host
uses `http://` where another host uses `https://`; an `http://` URL at any
other host is not an invitation.

The fragment stands alone: it is exactly `overstory-invite=<code>`, and no
segment parameter or query accompanies it. It appears only on a locator whose
authority is a DNS name, the host where the account is claimed. An
`overstory://` locator that breaks these rules, a TreeID authority included,
is invalid, as is a relative or tree-rooted reference carrying the fragment;
an `https://` URL that breaks them is an ordinary web URL and no invitation.
The code is used exactly as written, without percent-decoding, and its length
and alphabet beyond this grammar are the issuing host's
([accounts §1.2](04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key)).

The fragment is not part of what the locator names. Removing it leaves the
account locator, and every canonical spelling, comparison, merge key, and pin
(§1) uses that locator without it. A client opening an invitation link starts
the account claim; opening the same locator without the fragment is ordinary
navigation. The code is a secret: writers put it in no other locator form and
never in authored content. There is no segment-parameter form:
`;overstory-invite=` is an unknown parameter (§3).

### 2.3 Agent links

```text
https://community.example/~alice/notes#overstory-agent=<code>
```

An agent link is a tree's canonical HTTPS URL carrying an agent code
([accounts §5.5](04-accounts-and-devices.md#55-agent-codes)) as the fragment
`overstory-agent=<code>`, where the code is 22 characters of unpadded
base64url. `http` is accepted only at a loopback host. It is handed to a
command that checks the tree out, not written in pages or opened by an
editor: a locator parser that meets one reads an ordinary content fragment,
and a browser that opens one reaches the tree's page without sending the code.

## 3. Parsing and canonicalization

An external URL parser separates the final raw segment's parameter block,
beginning at its first `;overstory-`, before percent-decoding path components. A
literal suffix-like filename encodes its semicolon as `%3B`; it is data, not
identity syntax. Within the block, any parameter other than `overstory-key`,
`overstory-rev` and `overstory-config`, a repeated
parameter, an empty value, or `overstory-key` and `overstory-rev` in the
wrong order makes the locator invalid rather than path data. `overstory-config` takes no
value, appears only on a tree's root (a canonical boundary or
`overstory://<TreeID>`), stands alone, and addresses that tree's
[configuration](04-accounts-and-devices.md#21-finding-it) rather than a node;
the host answers it only to the tree's administrators. An invitation is a
fragment, not a parameter (§2.2). The parser then
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

Registered boundaries come from mounts: each active tree mounted in its
parent's `mounts.yaml` is registered at the parent's boundary joined with the
mount path ([accounts §3](04-accounts-and-devices.md#3-configuration-yaml)),
and a host roots the graph at its community root. The parent's administrators
choose its names; mounting a tree also requires administering it. How a host
mounts its members' profiles is host policy
([overstoryd's policy](../architecture/overstoryd/README.md#accounts-and-canonical-paths)).
Longest-boundary lookup resolves mounted trees below a path whether or not a
tree is registered at the path itself. No allocation rule is part of the
portable locator grammar.

Canonical placement is mutable naming. Changing the host's DNS name, moving
a registered boundary, or renaming a node changes canonical URLs without
changing TreeID or stable key. Moving the physical server behind an unchanged
DNS origin changes neither. A raw `overstory://<TreeID>/...` locator remains the
primary address when a canonical name is absent, unknown, inaccessible, or
changing.

### 5.1 Trees at a person's domain

A host may serve one person's trees at a domain they control, so the
canonical URL of what the host holds at `/~alice/drafts` is
`https://notes.alice.example/drafts`, and survives a move to another host
that keeps her trees at the same names. The person points the domain at the
host in DNS (usually a CNAME to the host's name) and lists it in their profile's
`domains` ([accounts §1](04-accounts-and-devices.md#1-profiles-and-host-accounts)).
The host serves the domain only while both directions hold:

1. **The domain reaches the host.** The host fetches
   `https://<domain>/.overstory/peer/domain-check`, without following redirects,
   and gets back its own answer: `{ "host": "<token>" }`, a value it chose
   and serves at every name it answers to. That proves DNS, the certificate
   and any proxy in front at once. A loopback test domain is fetched over
   `http`.
2. **The profile lists the domain.** The profile is a person profile the host
   holds for one of its own accounts, mounted at a path, and exactly one such
   profile lists the domain.

The host checks again on the schedule it resolves profile locators on
(§1), and stops serving a domain when a check gets another answer, when the
profile no longer lists it, or when it has gone unconfirmed past the grace.

While a domain is served, with the profile's path as its **prefix**:

- **Requests at the domain** have the prefix put in front of their path:
  `GET /drafts` at the domain is `GET /~alice/drafts`, and
  `/.well-known/overstory/drafts` is `/.well-known/overstory/~alice/drafts`.
  `/.overstory/*` routes, which name trees by TreeID, are the same at every
  name. A path at the domain whose first segment begins with `~` names
  another account and is redirected to the host's own name.
  `/.well-known/overstory-profile` at the domain names the profile's
  locator at the host, so the domain also names the person (§1.1) with no
  TXT record.
- **One canonical URL.** A descriptor's `canonical` gains `url`, the tree's
  canonical HTTP URL, for every tree whose path is at or below the prefix: the
  domain's origin followed by the path below the prefix. The longest served
  prefix covering a path decides; with none, there is no `url` and the
  canonical URL is the endpoint's origin and path, as before. `path` and
  `endpoint` keep naming the tree at the host, which still resolves and
  serves it there, so a client that does not know `url` keeps working.
- **Browsers are sent to it.** An HTML request for a path at or below the
  prefix at the host's own name is redirected (`301`) to the same path at
  the domain.

A domain names one profile's trees. Profile locators in rules and group
members keep their spelling; a domain locator (§1.1) is still how a rule
names a person by their domain.

```text
GET /.overstory/health
GET /.overstory/integrity
GET /.overstory/account
GET /.overstory/account/directory
GET /.overstory/trees
GET /.well-known/overstory[/{path}]
```

`health` is a cheap readiness check that answers `{"status":"ok"}` while the
server's own database is consistent; poll it freely. It may add `features`, the
optional protocol features the host serves; a host that lists none serves none. It states `protocol`, the host protocol level it
implements, a positive integer; a host that states none is level 1. A level rises when a
host gains something clients may depend on. A client that needs a higher level than a host
states must refuse that host and say the host needs updating, rather than talk to it and
fail in other ways. It adds `"founding": true` while the
community was founded by code and nobody has claimed it yet
([accounts §1.2](04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key)).
`integrity` audits every
object reachable from retained history and can take minutes on a large server;
concurrent requests share one audit, and it is for operators, not polling.

Authenticated account and tree-list reads use explicit envelopes,
`{ account }` and `{ snapshot: RemoteTreeDescriptor[] }`; bare arrays and
descriptors are not mutable responses. Each listed descriptor names its
accepted `update`, after which a client may watch that tree.

`account/directory` is an optional convenience read: the people and groups
the authenticated account can see from this host, as
`{ snapshot: DirectoryEntry[] }`. Everything in it a member could compute from
trees they already read: the community profile's members, the groups that
name them, and the profiles named by their own trees' rules
([access control §4](05-access-control.md#4-reading-access)). A host MAY
serve it, and it adds nothing a client could not compute itself.

```ts
type DirectoryEntry = {
  profile: TreeID;
  kind: "person" | "group" | "unknown";
  handle?: string;
  locator?: string;              // the profile's canonical locator
  displayName?: string;
  description?: string;
  avatar?: { tree: TreeID; path: string; hash: Hash };
  domain?: string;               // the domain the host serves its trees at (§5.1)
  sources: ("community" | `group:${TreeID}` | "access")[];
};
```

Well-known and canonical-path resolution return `LocatorResolution`, using the
longest readable registered boundary. Inaccessible nested boundaries cannot be
read through a parent. Tree configurations are absent from public discovery
and canonical resolution.

```ts
type LocatorResolution = {
  ref: NodeRef;
  enclosingTree: RemoteTreeDescriptor;  // its `update` is where a watch starts
  historical: boolean;
};
```

## 6. Public HTTP projection

Readable canonical paths are also served over plain HTTP: Markdown always,
HTML and other formats at the host's choice, with stable-key redirects. Those
reads, and the rules that keep stored content inert, are defined with the
other reads in [tree operations §1.3](01-tree-operations.md#13-reading-at-the-canonical-url).
