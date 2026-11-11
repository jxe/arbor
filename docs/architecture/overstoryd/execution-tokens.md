# Execution tokens

overstoryd's execution authority (`src/execution-authority.ts`) issues tokens that let
code run on a caller's behalf. The execution sidecar that first used them is gone
(Beetle runs in process: [the Beetle host](beetle-host.md)); the tokens stay for
[Apps 010](../../../plans/later/apps-010-activation-and-lending.md), which applies them to
the in-process evaluator. Portable contracts are in
[access control §1.1](../../overstory-spec/3.2-access-control.md#11-execution-authority).


A host issues an opaque execution token to its trusted runtime through an
authenticated channel after checking activation and requirement coverage. The
token binds the actual caller/replay principal, executing source TreeID (matched
against `app`), pinned code and requirements, resolved resource bindings, and
each granted capability with its lender. It can refer
to authenticated claims or host-private records; its encoding and issuance transport
are implementation details, not authored data or a durable query-session protocol.

A grant names one tree, except a read grant over any tree, which a host may issue
when code cannot know in advance which trees it will read (the profiles a query
reaches, for example). Each read under it is checked at the tree read, as the
caller's own access with no lender. It never writes, never covers part of a tree,
and is never lent.

The runtime authenticates host calls with:

```http
POST /.overstory/trees/tr_notebook/updates
Authorization: Bearer <execution-token>
Content-Type: application/json
```

The body is an ordinary `UpdateRequest`, including its normal exact-state guard
when required. No lender, caller, `app`, or grant field in that body supplies
authority. Ordinary clients continue using device sessions. Execution tokens
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

## What they may read and submit

A token's update is one guarded update, a snapshot or row operations only, with no
resolutions. Either way its effects are the paths that differ between the head and the
accepted root, each checked against the token's grants. Until Apps 005 step 1, a
mutation's token carries the caller's own authority for the tree, as the routes check
today.

A read grant over any tree (`ANY_TREE` in `execution-authority.ts`) reads whatever the
caller could read, checked at each read at the tree it reads, for code that can't know
whose profiles it will reach until it runs. Such a grant reads only, covers whole trees,
and is never lent. The execution sidecar issued one per view stream; Beetle views run in
process and check the caller's access directly ([the Beetle host](beetle-host.md)), so
nothing issues one today.
