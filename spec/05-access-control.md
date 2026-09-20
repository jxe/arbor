# Access control
*Part of the [Overstory spec](../spec.md): resource policy, execution authority, authentication, and authorization of reads, updates, and observations.*

*Owns: `who` / `via` / `allow` rules. References: [account configuration](04-accounts-and-devices.md), [executable documents](07-executable-documents.md), and [locator resolution](03-locators.md#4-resolution-rules). This is the target contract; [Apps 004](../plans/apps/004-mutation-permissions.md) owns implementation and coordinated migration.*

## 1. Subjects and rules

Policy is resource-centric. An account's `trees.yaml` is keyed by the resource
TreeID; its `access` list contains rules of this shape:

```ts
type AccessWho = "everyone" | "me" | { profile: TreeID } | { link: Hash };
type AccessOperation = "read" | "write" | "create-child" | "update-content"
  | "update-properties" | "delete";
type AccessRule = {
  who: AccessWho;
  via?: TreeID;
  allow: AccessOperation[];
  within?: LogicalPath;
};
```

```yaml
tr_notebook:
  canonical: https://canopy.example/~joe/notebook
  access:
    - who: {profile: tr_alice}
      allow: [read]
    - who: me
      via: tr_supplies
      allow: [create-child]
tr_private_data:
  access:
    - who: everyone
      via: tr_supplies
      allow: [read]
      within: /published
```

`me` is the policy account's stable profile identity, not the submitting device
or an authored user parameter. A profile subject matches that profile, or the
current membership of a group profile; person-profile fields never create a
group. A link subject matches a valid presented secret's digest.

`via` restricts a rule to a host-attested execution of that source TreeID. It is
not a module or export name. Omitting it imposes no executable restriction:
ordinary read access, including public access, works through code too. A
browser-supplied TreeID or header is never execution attestation. Libraries
execute within their caller's authority; imports do not acquire the imported
tree's grants. Calling another tree as a privileged executable requires a new,
explicitly authorized execution boundary. Nested code trees do not inherit `via`.

`within` defaults to `/` and selects a logical subtree including its root;
resolution uses segment boundaries, not string prefix matching. It never crosses
a nested TreeID boundary. Rules use concrete resource identities, not mutable
canonical URLs. `allow` is nonempty and duplicate-free; unknown operations fail
validation. Rules have no authored grant IDs. Their merge key is canonical
`(who, via-or-absent, within-or-/)`; duplicate keys are invalid.

`read` permits scoped content, properties, membership, and authorized observation.
`write` includes read and all ordinary content mutation operations within scope,
but not account administration, resource delegation, external effects, or raw
backing credentials. `create-child` permits adding a previously absent child
and its new content beneath an allowed parent, not overwriting an existing child.
`update-content` and `update-properties` affect only their respective fields;
`delete` removes an allowed node. Moves require authority for removal and
creation and all consequential effects. No narrow operation implies read.
Providers reject operations they cannot enforce exactly; they never silently
promote a narrow operation to whole-store write.

### 1.1 Execution authority

Queries and mutations declare requirements supplied by author and user. The host
binds author to an explicitly configured sponsoring account, not the last editor;
user is the authenticated caller or anonymous. Applicable rules are evaluated
against that caller and the attested executing TreeID. An author's private read
access does not automatically become available to anonymous users: a matching
rule, such as `who: everyone, via: tr_supplies`, must authorize that execution.

Each party's declared requirements must be covered by its applicable policy and
current underlying authority. Only those requested capabilities enter execution;
the resulting author and user contributions are combined. Grant provenance is
retained internally, while user identity remains the caller. No union may invent
a capability not independently covered by an authorized contribution.

Hosted resource owners can grant direct access. Rules in a non-owner account
configuration can only attenuate access that account currently holds; they cannot
change the owner's ACL, authorize delegation of account administration, or survive
loss of underlying access. The authority evaluates underlying access without
recursively treating the proposed delegation as its own justification. Cross-server
delegation transport is not defined by this local-host contract.

Consent edits accepted account configuration. Requirements expanding beyond
applicable rules need new approval from the affected party; reduced requirements
need none. Grants follow the code TreeID across module moves and revisions.
Thus maintainers are trusted to change behavior inside that envelope. Each run
pins code, requirements, and resolved resources; it never silently upgrades while
resuming. Runtime tokens are opaque, limited to that execution authority, and
contain no general user/author credentials. Their encoding is host-private.

Rules are edited through governed configuration acceptance, not a separate grant
CRUD service. Only administrator devices may edit resource policy. Enforcement
uses accepted configuration and current identity/group/access facts, never an
unaccepted local edit. Policy indexes are derived. Revocation does not undo
committed effects or retract bytes already disclosed.

## 2. Authentication and secrets

Authenticated ordinary requests use:

```text
Authorization: Bearer <device credential>
Arbor-Access-Link: <access-link secret>
```

A device credential identifies one account and contributes its `account.yaml.profile`.
The host establishes executable context separately over an authenticated runtime
channel. Incoming public requests cannot forge or override it. Across matching
rules, allowed operations union within their scopes. Caller authentication,
executable identity, and policy-account provenance remain distinct.

Raw credentials, private keys, execution tokens, and link secrets never appear
in authored YAML, URLs, diagnostics, query results, or transcripts. Link-subject
hashes may appear in canonical private policy but are omitted from safe access
responses. Account-specific policy is not public executable metadata.

### 2.1 Execution tokens

A host issues an opaque execution token to its trusted runtime through an
authenticated channel after checking activation and requirement coverage. The
token binds the actual caller/replay principal, executing source TreeID (matched
against `via`), sponsoring account, pinned code and requirements, resolved resource
bindings, and the bounded author/user authority with its provenance. It can refer
to authenticated claims or host-private records; its encoding and issuance transport
are implementation details, not authored data or a durable query-session protocol.

The runtime authenticates host calls with:

```http
POST /.arbor/trees/tr_notebook/updates
Authorization: Bearer <execution-token>
Content-Type: application/json
```

The body is an ordinary `UpdateRequest`, including its normal exact-state guard
when required. No author, caller, `via`, or grant field in that body supplies
authority. Ordinary clients continue using device credentials. Execution tokens
also authenticate authorized resolution, object/read, receipt and watch requests;
a runtime cannot substitute a source-binding ID for a token.

The host verifies the token's issuer, validity and intended host, then checks current
policy and underlying authority within its bound requirements. Matching `who` /
`via` rules authorize effects; a valid state guard checks concurrency independently.
Recheck at atomic acceptance and stored-receipt disclosure. Token possession does
not freeze ACLs, device/session validity or grants. Watches and direct-provider
execution use the revocation rules below; expiration or refresh cannot silently
broaden the pinned execution. Untrusted clients cannot mint execution context, and
authored code receives no raw token or general author/user credentials.

## 3. Tree-scoped authorization

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
`via`, `allow`, and `within`. Link subjects are redacted, and private policy from
other accounts is not exposed. Effective permission descriptions are scoped to
current caller/executable context; they are advisory, never authorization proof.
The legacy `none | read | write` descriptor remains a summary of whole-tree access,
not a representation of scoped capabilities. Permission changes occur only through
accepted `trees.yaml` updates. Concurrent narrowing/removal must not resurrect
broader permissions through ordinary union merging: ambiguous policy edits retain
the restrictive effective result pending explicit authorized resolution.
