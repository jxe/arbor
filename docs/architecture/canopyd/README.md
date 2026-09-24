# Host: canopyd

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

**The host** (canopyd) implements access and claims, public HTTP projection,
graph validation, authoritative reconciliation, and private storage. Update
handling separates decision, causal reconciliation, and transactional storage
from rule computation; the [merge sidecar](merge-tool.md) computes every
merge and keeps its own retained state, which canopyd treats as opaque.
canopyd checks each response's shape and objects, merges account
configuration itself, and owns acceptance. Table definitions, the schema stamp, and the startup schema
assertion live in `schema.ts`; the [schema history](../../../packages/canopyd/migrations/README.md#schema-history)
lists every stamp.

## Accounts and canonical paths

The spec leaves placement to each host; this is canopyd's policy.

- **Community profile.** The tree canonical at `/` is the community's
  membership profile and keeps `type: group`. Accounts that can write it are
  the Canopy's administrators.
- **Accounts.** A community `members` entry's `handle` reserves `/~handle`
  for exactly that entry's person Profile TreeID; that person claims the
  account with their profile key ([accounts §1.2](../../overstory-spec/04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key)).
  Removing the entry disables the account. An account's profile tree, once
  hosted, is the tree at `/~handle`.
- **Paths an account may declare.** Any path below its own `/~handle`. An
  administrator may also declare paths below any `/~name` that no person has
  reserved or claimed, so a top-level name can address a group or any other
  tree. Other paths are refused.
- **One rule for `/~name`.** A name is either a person's (reserved or
  claimed) or held by trees (a tree, active or declared, at or below
  `/~name` that the `~name` account does not administer). Reserving a handle
  or claiming an account is refused while trees hold the name, and declaring a
  tree under another person's name is refused.
- **Group membership.** A profile subject that is a `type: group` tree grants
  its access to every member whose Profile TreeID its `members` list names;
  a legacy scalar `/~handle` member still matches by handle.

## Durability and observation

canopyd runs SQLite in WAL mode with `synchronous = NORMAL`; objects are
fsynced before the commit that names them, so a lost commit leaves only
unreferenced objects ([deployment](../../../packages/canopyd/deploy/README.md#durability)). Each
update request logs one structured line (tree, status, batch size, total and
per-phase milliseconds, objects considered, files written, fsyncs, body
bytes, trace frames and operations, accepted update ids) and returns the
same phases in a `Server-Timing` header. The log is silent under the test
runner and never contains request content, subjects, or object identities.
The Canopy app's network log is its client-side counterpart
([local system](../canopy-browser/local-state.md#diagnostic-streams)).

A tree watch reauthorizes before every event it sends and every 250 ms while
idle, and an execution authority watch every 250 ms; revocation closes the
stream within that interval. Between checks canopyd reuses the previous
decision until the database changes (a write through its connection, or a
commit by any other) or execution authority is invalidated, so an idle
check costs one trivial query. Execution token revocation, expiry, and its
host validity callback are checked every time.

## Sidecars

- [Merge tool](merge-tool.md)
- [Execution sidecar](execution-sidecar.md)
- [Deployment](../../../packages/canopyd/deploy/README.md)
- [Migrations](../../../packages/canopyd/migrations/README.md)
