# Protocol and object stores

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

Canonical CBOR and `canonicalCBORHash` live in `protocol`. Snapshot bundles
contain only a version and hash-ordered object byte strings (raw files and
canonical CBOR directories); the root stays in the request URL. Directory
objects carry ordinary CSV, JSON, and JSONL source and schema entries plus a
directory-level `childrenSource` descriptor that interprets them as one child
set; canopyd validates those graphs, merges disjoint rows by stable identity,
and projects logical rows at ordinary locators while keeping `_store.*` and
`schema.ts` out of child navigation.

For an update string, canopyd derives one credential-scoped digest per
element over `{ domain: "arbor-update/2", tree, base, change, trace,
candidate, resolves, ifCurrent }`, with each later element using its
predecessor's `{ requestDigest, candidate }` as `base`. Accepted rows store
the element digest for replay, so a longer request resumes after an
already-applied prefix. Object hashing is not authorization: the caller binds
the basis to an authorized accepted state in the same tree, and reusing a
retained change ID in a different request, including a snapshot, is
rejected. A request the host does not support fails closed with
`422 unsupported-operation` before any prefix is accepted; the daemon then
retains the pending request, marks the tree as an error, and suppresses
resubmission of that request for the synchronizer's lifetime, while the
native coordinator enters a terminal validation state keeping the durable
request. Neither client strips operations.

Source edits against an accepted basis may ship the edited file as an object
delta when that is smaller; chained authored records always send the whole
file, because `reconstructDeltas` resolves delta bases against the accepted
base root before the request's own objects are stored.

**Net watch catch-up** is unconditional. A client requests
`GET /.arbor/trees/{tree}/watch` with its confirmed cursor; canopyd captures
the accepted state at that cursor and the current destination and builds one
sparse payload between their roots. `from: { id, root }` is the transport
basis while `update.previous` stays the destination's real predecessor.
Missing retained basis data answers `resync-required`. Absence of a matching
digest in a coalesced event is not proof of non-acceptance, so pending
requests keep their exact retry procedure. Net frames may exceed the ordinary
1 MiB frame target; the native SSE parser scans new bytes only.

<a id="conflict-inspection"></a>
**Conflict inspection.** `GET /.arbor/trees/{tree}/conflicts?state={acceptedUpdate}`
returns the decisions retained at that accepted state. `after` and `conflict`
are mutually exclusive; the reference page size is 32, with no cap of 32 on
accepted decisions; historical pages keep their identities as current
advances. Unknown, unavailable, or unauthorized state is 404; malformed query
or token bindings are 400. A root decision is encoded as `kind: "directory"`
with the root basis reference and `root: true`, no `placement`, and no
synthetic filename.

<a id="resource-policy"></a>
**Resource policy.** `ExecutionAuthority.issue` is trusted host
infrastructure, not a public mint endpoint; tokens are process-local and
invalidated on restart while durable update identity survives independently,
and possessing a token makes no SQLite connection safe. The internal
`GET /.arbor/execution/authority-watch` authenticates an execution token and
sends `refresh` or `revoked` SSE events with empty payloads; it conservatively
invalidates on accepted updates, revocation notifies immediately, and expiry
and session changes are polled, so providers refresh authority after a
disconnect. `GET /access` keeps the legacy `snapshot` projection and adds a
safe `policy` field. The supported scoped update subset: new files and
directories need `create-child` at the logical parent, raw content changes
`update-content`, file deletion `delete`; Markdown replacement conservatively
needs `write` because it can change frontmatter, as do directory deletion or
retyping, reserved representations, and opaque child stores. Scopes stop at
TreeIDs and newly created scoped directories cannot conceal nested trees.
Operation-bearing updates, explicit resolutions, updates to conflicted
trees, scoped object, snapshot, and watch projections, and granular property
or store effects fail closed and never widen to write. Concurrent policy
edits install their restrictive intersection with the alternatives retained
as a root conflict; removal wins concurrent expansion for non-hosting
entries; a pending policy conflict locks configuration edits until an
administrator resolves every alternative.
