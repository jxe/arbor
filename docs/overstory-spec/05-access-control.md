# Access control
*Part of the [Overstory spec](README.md): resource policy, execution authority, authentication, and authorization of reads, updates, and observations.*

*Owns: `who` / `app` / `allow` rules, administrators and lending. References: [tree configurations](04-accounts-and-devices.md), [executable documents](07-executable-documents.md), and [locator resolution](03-locators.md#4-resolution-rules). This is the target contract; the deployed subset is in [status](../../status.md), and provider enforcement is [Apps 005](../../plans/apps/005-source-resolution-and-sidecar.md).*

## 1. Subjects and rules

Policy is resource-centric. Each hosted tree's rules are the `access.yaml` of
its [tree configuration](04-accounts-and-devices.md#2-tree-configuration-graph),
a list of rules of this shape:

```ts
type AccessWho = "everyone" | { profile: TreeID } | { link: Hash };
type AccessOperation = "read" | "write" | "create-child" | "update-content"
  | "update-properties" | "delete" | "admin";
type AccessRule = {
  who: AccessWho;
  app?: TreeID;
  allow: AccessOperation[];
  within?: LogicalPath;
};
```

```yaml
# /~joe/notebook;arbor-config  access.yaml
- who: {profile: tr_joe}
  allow: [admin]
- who: {profile: tr_alice}
  allow: [read]
- who: everyone
  app: tr_supplies
  allow: [read]
  within: /published
```

A profile subject matches that profile, or the current membership of a group
profile; person-profile fields never create a group. A link subject matches a
valid presented secret's digest. `me` and `members` name the profile whose
`apps.yaml` holds a rule (§1.1) and are invalid in `access.yaml`.

`admin` names the tree's **administrators**. It may be granted only to a
person or group profile, in a rule with no `app` and no `within`; a group
administers through its current members, the same one-level membership check
other rules use. An administrator may read and edit the tree configuration
and has every other operation on the whole tree, so no other rule needs to
name them. `admin` is the only operation a rule cannot narrow: there is no
administering a subtree or administering only through an app. Every tree has
at least one administrator.

`app` restricts a rule to a host-attested execution of that source TreeID. It
is not a module or export name. Omitting it imposes no executable
restriction: ordinary read access, including public access, works through
code too. A browser-supplied TreeID or header is never execution attestation.
Libraries execute within their caller's authority; imports do not acquire the
imported tree's grants. Calling another tree as a privileged executable
requires a new, explicitly authorized execution boundary. Nested code trees
do not inherit `app`. An `access.yaml` rule with `app` is the tree's own grant
through that code: it needs no lender behind it and survives any one
administrator leaving.

`within` defaults to `/` and selects a logical subtree including its root;
resolution uses segment boundaries, not string prefix matching. It never
crosses a nested TreeID boundary. Rules use concrete resource identities, not
mutable canonical URLs. `allow` is nonempty and duplicate-free; unknown
operations fail validation. Rules have no authored grant IDs. Their merge key
is canonical `(who, app-or-absent, within-or-/)`; duplicate keys are invalid.

`read` permits scoped content, properties, membership, and authorized observation.
`write` includes read and all ordinary content mutation operations within scope,
but not administration, resource delegation, external effects, or raw
backing credentials. `create-child` permits adding a previously absent child
and its new content beneath an allowed parent, not overwriting an existing child.
`update-content` and `update-properties` affect only their respective fields;
`delete` removes an allowed node. Moves require authority for removal and
creation and all consequential effects. No narrow operation implies read.
Providers reject operations they cannot enforce exactly; they never silently
promote a narrow operation to whole-store write.

### 1.1 Execution authority

Code always runs as its caller: the authenticated caller's profile, or
anonymously. Nobody else's identity is ever the actor, and writes are
attributed to the caller. Queries and mutations declare the capabilities they
need; each capability the host grants an execution names its **lender**:

- **No lender**: the caller's own access, or the tree's own `app` rule for
  the attested code. An author's private access does not become available to
  anonymous callers this way.
- **A lender**: a profile whose `apps.yaml` lends that capability to the
  code's callers. Each lent capability is one grant naming its lender, and a
  grant from one lender never widens another's.

A profile's `apps.yaml` is keyed by app TreeID, and each entry is a rule with
`resource` in place of the key:

```yaml
# /~joe;arbor-config  apps.yaml
tr_planner:
  - resource: tr_club_calendar   # Joe reads it as a club member
    allow: [read]
tr_joe_homepage:
  - resource: tr_library_catalog
    who: everyone
    allow: [read]
    within: /new-books
```

`who` defaults to the profile itself: `me` in a person's file, `members` in a
group's; each is invalid in the other file. Any other `who` lends the access
to those callers of the app. A lent grant covers a requirement when:

- the lender's `apps.yaml` entry for the executing app covers the resource,
  path and operation and matches the caller; and
- **only the named subject lends**: a rule in the resource's `access.yaml`
  names the lender directly (a `{profile}` rule for that lender, or the
  lender's administration) and covers the requirement. Access granted to a
  group is the group's to lend, not any member's; `everyone` grants need no
  lending, and link grants are not lendable.

The one exception is **approving an app for yourself**: a person's `who: me`
entry may use any access the person holds, including through a group, when
the person is the caller. Nobody else gains anything.

When more than one lender covers a requirement, the host picks one by a fixed
order (the caller's own access first, then lender profile TreeID) and records
it. Lending can only narrow what the lender currently holds and lapses when
that access does; a lapsed grant revokes the execution like any other. A
group's lending is edited by whoever administers the group's profile, and
members come and go without affecting it. Lending write to callers other than
the lender is allowed; clients warn before writing it. Lending trusts the
app's administrators, who may change its code inside the envelope.

Consent edits an accepted tree configuration: the person's or a group's
`apps.yaml`, or an `app` rule in a tree the approver administers.
Requirements expanding beyond applicable rules need new approval from the
affected party; reduced requirements need none. Grants follow the code TreeID
across module moves and revisions. Each run pins code, requirements, and
resolved resources; it never silently upgrades while resuming. Runtime tokens
are opaque, limited to that execution authority, and contain no general
caller credentials. Their encoding is host-private. The authority evaluates
underlying access without recursively treating the proposed delegation as its
own justification. Until
[Security 008](../../plans/security/008-portable-profiles.md), an `apps.yaml`
entry applies only on its profile's home host, and cross-server delegation
transport is not defined.

**On a placement host**
([accounts §1.3](04-accounts-and-devices.md#13-claiming-a-placement-account)),
which cannot read the caller's `apps.yaml`, code has only `everyone` grants
and the `app` rules of that host's own trees: no grant without a lender is the
caller's own access, and nothing is lent. A tree's administrators there
approve an app for the tree with an `app` rule in its configuration.

Rules are edited through governed configuration acceptance, not a separate
grant CRUD service. Only administrator devices of an administering person may
edit a tree configuration
([accounts §3.1](04-accounts-and-devices.md#31-who-may-edit-a-tree-configuration)).
Enforcement uses accepted configurations and current identity, group and
access facts, never an unaccepted local edit. Policy indexes are derived.
Revocation does not undo committed effects or retract bytes already
disclosed.

## 2. Authentication and secrets

Authenticated ordinary requests use:

```text
Authorization: Bearer <device credential or device session token>
Arbor-Access-Link: <access-link secret>
```

A device credential, sent by a digest device to its home host, or a session
token a key device opened at this host
([accounts §5.1](04-accounts-and-devices.md#51-device-sessions)), identifies
one account and device and contributes the profile TreeID. Both are checked
against the device's current state on every request: a deleted device, and an
expired session, authenticate nothing.
The host establishes executable context separately over an authenticated runtime
channel. Incoming public requests cannot forge or override it. Across matching
rules, allowed operations union within their scopes. Caller authentication,
executable identity, and lender provenance remain distinct.

Raw credentials, private keys, execution tokens, and link secrets never appear
in authored YAML, URLs, diagnostics, query results, or transcripts. Link-subject
hashes may appear in canonical private policy but are omitted from safe access
responses. Account-specific policy is not public executable metadata.

### 2.1 Execution tokens

A host issues an opaque execution token to its trusted runtime through an
authenticated channel after checking activation and requirement coverage. The
token binds the actual caller/replay principal, executing source TreeID (matched
against `app`), pinned code and requirements, resolved resource bindings, and
each granted capability with its lender. It can refer
to authenticated claims or host-private records; its encoding and issuance transport
are implementation details, not authored data or a durable query-session protocol.

The runtime authenticates host calls with:

```http
POST /.arbor/trees/tr_notebook/updates
Authorization: Bearer <execution-token>
Content-Type: application/json
```

The body is an ordinary `UpdateRequest`, including its normal exact-state guard
when required. No lender, caller, `app`, or grant field in that body supplies
authority. Ordinary clients continue using device credentials. Execution tokens
also authenticate authorized resolution, object/read, receipt and watch requests;
a runtime cannot substitute a source-binding ID for a token.

The host verifies the token's issuer, validity and intended host, then checks current
policy and underlying authority within its bound requirements. Matching `who` /
`app` rules and lent grants authorize effects; a valid state guard checks concurrency independently.
Recheck at atomic acceptance and stored-receipt disclosure. Token possession does
not freeze ACLs, device/session validity or grants. Watches and direct-provider
execution use the revocation rules below; expiration or refresh cannot silently
broaden the pinned execution. Untrusted clients cannot mint execution context, and
authored code receives no raw token or general author/user credentials.

## 3. Tree-scoped authorization

### Directory disclosure

A host may derive an authenticated account's people and group directory from
readable community membership, readable group membership, and profile subjects
already named by that account's access rules. Profile TreeIDs remain the only
identity. A directory must not widen read access: profile card fields are
disclosed only while the caller can read that profile tree, and avatar bytes
use the ordinary tree-scoped object authorization route.

Possession of a hash, source binding, watch cursor, or accepted receipt is not
authorization. Every operation checks current authority through a named TreeID.
Nested tree entries stop both reachability and permission scope.

A whole-tree read permits objects reachable from retained accepted roots and
known-root accepted snapshots. Unknown, unretained, wrong-tree, and unauthorized
roots are indistinguishable `404`s. Scoped read cannot expose a whole root,
ancestor directory listing, conflict alternative, provenance object, or shared
object merely because some descendant is readable. Object reads must prove
reachability within the authorized projection; unsupported scoped projections
fail closed. Source/schema resolution must observe the same disclosure limit.

### 3.1 Updates and guards

The ordinary updates endpoint accepts executable-authorized effects as well as
ordinary writer updates. Authority is checked over the submitted intent and the
actual accepted effects, including deletions, moves, cascades, schema changes,
conflict alternatives, and explicit resolutions. Snapshot replacement cannot
bypass narrow operation limits. If confinement cannot be proved, reject rather
than requiring or assuming broader authority. Account configuration always retains
its additional governance rules.

Exact-state guards are concurrency checks, never permission grants. A mutation
whose checks depend on state submits a guard covering that state. Failed guards
require recomputation rather than automatic merging of stale policy decisions.
A single-tree guard does not establish atomic checks across independent trees or
stores. Recheck authority at atomic acceptance, and before returning a stored
receipt; a revoked retry must neither reveal its result nor create a second effect.

### 3.2 Watches and revocation

Authorize stream admission, cursor replay, and every disclosed event against
current policy. Whole-tree watches require whole-tree read. Scoped observation
must filter paths, hashes, metadata, and changes outside the readable projection;
if the host lacks that facility it rejects the request. Reauthorization and event
publication must be ordered against policy acceptance so queued events cannot
escape after revocation. Terminate or invalidate affected streams without
revealing private details. Reconnect repeats authorization; a cursor is not a grant.
A stream opened with a device session ends no later than the session expires,
and when its device is deleted; the client reopens it with a fresh session.

Hosts notify trusted runtimes of policy, device/session, and group-membership
changes affecting active execution. A disconnected invalidation channel blocks
new disclosures/effects until authority is refreshed. Direct backing providers
must participate in this enforcement; a token checked once at SQLite connection
creation is insufficient. Cached public bytes cannot be recalled.

## 4. Reading access

```text
GET /.arbor/trees/{TreeID}/access
```

Administrators receive a safe projection of resource rules with `who`, optional
`app`, `allow`, and `within`. Link subjects are redacted, and other profiles'
`apps.yaml` is not exposed. Effective permission descriptions are scoped to
current caller/executable context; they are advisory, never authorization proof.
The legacy `none | read | write` descriptor remains a summary of whole-tree access,
not a representation of scoped capabilities. Permission changes occur only through
accepted tree configuration updates. Concurrent narrowing/removal must not resurrect
broader permissions through ordinary union merging: ambiguous policy edits retain
the restrictive effective result pending explicit authorized resolution.
