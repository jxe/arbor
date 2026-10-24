# Protocol and object stores

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

Canonical CBOR and `canonicalCBORHash` live in `protocol`. Snapshot bundles
contain only a version and hash-ordered object byte strings (raw files and
canonical CBOR directories, tables and rows); the root stays in the request
URL. A directory with a logical collection keeps its `schema.usl` as an
ordinary entry and a `collection` reference naming one `table` object per
model, each listing its rows in content-defined `rows` chunks (spec 06 §2.1).
Every graph walk follows those edges (`protocolObjectReferences` in
TypeScript, `ProtocolObjectCodec.references` in Swift). overstoryd validates
those graphs, merges rows by stable key, and presents the main model's rows
as the folder's children; `_store.*` files and `_store.sqlite3` are a
placement's projections, which Story Sync reads and writes, never tree
entries.

For an update string, overstoryd derives one credential-scoped digest per
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
base root before the request's own objects are stored. Story Sync's folder
changes follow the same rule through `transitionPayload`
(`updates/transition-payload.ts`), which also builds overstoryd's accepted
transitions: each changed object is paired with the object at its path in the
starting root by `walkTreeDiff` (`updates/tree-diff.ts`).

**Net watch catch-up** is unconditional. A client requests
`GET /.overstory/trees/{tree}/watch` with its confirmed cursor; overstoryd captures
the accepted state at that cursor and the current destination and builds one
sparse payload between their roots. `from: { id, root }` is the transport
basis while `update.previous` stays the destination's real predecessor.
Missing retained basis data answers `resync-required`. A single new update is
sent as its own transition from its predecessor's root, built the same way; the
host stores no transition payloads (schema 18) and caches recent ones. Absence of a matching
digest in a coalesced event is not proof of non-acceptance, so pending
requests keep their exact retry procedure. Net frames may exceed the ordinary
1 MiB frame target; the native SSE parser scans new bytes only.

<a id="conflict-inspection"></a>
**Conflict inspection.** `GET /.overstory/trees/{tree}/conflicts?state={acceptedUpdate}`
returns the decisions retained at that accepted state. `after` and `conflict`
are mutually exclusive; the reference page size is 32, with no cap of 32 on
accepted decisions; historical pages keep their identities as current
advances. Every retained accepted update has a log entry whose decisions the
page lists; states accepted before migration 016 (schema 18) are not retained. Unknown, unavailable, or unauthorized state is 404; malformed query
or token bindings are 400. A root decision is encoded as `kind: "directory"`
with the root basis reference and `root: true`, no `placement`, and no
synthetic filename.

<a id="resource-policy"></a>
**Resource policy.** `ExecutionAuthority.issue` is trusted host
infrastructure, not a public mint endpoint; tokens are process-local and
invalidated on restart while durable update identity survives independently,
and possessing a token makes no SQLite connection safe. The internal
`GET /.overstory/execution/authority-watch` authenticates an execution token and
sends `refresh` or `revoked` SSE events with empty payloads; it conservatively
invalidates on accepted updates, revocation notifies immediately, and expiry
and session changes are polled, so providers refresh authority after a
disconnect. `GET /access` answers a tree's administrators with its safe
`policy` and the `overstory://` `locators` of the profiles its rules name by
TreeID; there is no separate whole-tree entry list. The supported scoped update subset: new files and
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
