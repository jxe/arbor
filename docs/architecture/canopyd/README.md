# Host: canopyd

[Architecture overview](../README.md) · [Implementation status](../../../status.md)

**The host** (canopyd) implements access and claims, public HTTP projection,
graph validation, authoritative reconciliation, and private storage. Update
handling separates decision, causal reconciliation, and transactional storage
from rule computation. Accepted history is a chain of log entries in the
object store; the [merge sidecar](merge-tool.md) answers one question about
it when concurrent work must combine, and keeps whatever it caches in its own
memory ([writing a sidecar](writing-a-sidecar.md)). canopyd accepts plain
edits on the head itself, checks each answer's shape and objects, merges
account configuration itself, and owns acceptance. Table definitions, the schema stamp, and the startup schema
assertion live in `schema.ts`; the [schema history](../../../packages/canopyd/migrations/README.md#schema-history)
lists every stamp. Startup reads only the schema: the stamp, then each table's
columns and the indexes queries rely on. Any difference is a
`SchemaMismatchError`, and `canopyd` serves maintenance mode rather than the
data root. The row invariants (every tree has accepted history, every account
a device, no foreign key dangles) scan whole tables, so the integrity audit
checks them instead.

## Accounts and canonical paths

The spec leaves placement to each host; this is canopyd's policy.

- **Community profile.** The tree canonical at `/` is the community's
  membership profile and keeps `type: group`. Accounts that can write it are
  the Canopy's administrators.
- **Accounts.** A community `members` entry's `handle` reserves `/~handle`
  for exactly that entry's person Profile TreeID; that person claims the
  account with their profile key ([accounts §1.2](../../overstory-spec/04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key)).
  A pending `handle` plus `inviteDigest` reserves the address without granting
  membership. A claimant presents the matching random code and proves their
  newly created Profile TreeID with the same profile-key signature. Claim
  replaces the pending entry with that Profile TreeID in the accepted
  community root.
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
- **Profile facts.** Authorization and the directory read a tree's `type`,
  `members` and card fields (display name, description, avatar) from one
  `profile_facts` row per tree whose head declares `type: person` or
  `type: group`, never from objects. The row records the head's `_index.md`
  object and the avatar path its frontmatter declares. An accepted update
  recomputes it, inside its transaction, only when its entry changes set or
  remove the root `_index.md` or that avatar path, parsing `_index.md` once
  for the whole accept (validation shares the result); it deletes the row
  when the head no longer declares a type. The community's accounts are
  reconciled only when its `members` change. A tree without a row is not a
  profile (`packages/canopyd/src/profile.ts`).
- **Tree ownership.** A tree an account activated, or hosts in its
  `trees.yaml` while no account owns it, is that account's (`trees.account_id`):
  only the owner administers it, and the owner's resource rules alone decide
  who else reads or writes it, whether or not the community has since
  disabled the owner. The community root cannot be retired through a
  configuration. A tree no account owns (trees created at bootstrap until
  their account's configuration exists) keeps stored `access` entries; the
  accounts those entries let write it administer it.
- **Errors.** A request canopyd cannot accept is a 400 with the reason; a
  failure of canopyd's own state, a component it trusts, or a system call is
  a logged 500 (`ServerFaultError`, `isServerFault` in `errors.ts`).

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

## Retention and object collection

`retention.ts` is the one definition of what the object store keeps; the
integrity audit (`/.arbor/integrity`) verifies it and the object collector
deletes only outside it. Required, and verified by the audit: every accepted
row's root and log entry, every entry reached through `previous` and
`asked.base`, each entry's root and decision alternatives (whole trees, or
single objects for a range and its `at` file), and every
`document_versions.content_hash`. Kept when present: what a sidecar reads to
replay an entry's question (trace frame roots, `asked.candidate`, prefix
roots, alternative bindings) and any other hash-shaped string in an entry,
such as one in the sidecar's evidence. Nested tree entries are left to their
own tree's rows.

`collect-objects.ts` is an operator command, run beside a serving canopyd
([deployment](../../../packages/canopyd/deploy/README.md#collecting-unreferenced-objects)).
It reads the database read-only, keeps every unreferenced object used within a
grace period (24 hours by default), and deletes the rest. "Used" is the file's
modification time: `ObjectStore` sets it when it stores bytes that already
exist, and acceptance freshens every stored object a candidate or merge answer
takes without uploading it before committing the row that names it. The
collector renames each candidate aside and checks its time again, putting back
one freshened in between; a freshen that finds the file gone fails its
acceptance rather than committing a reference to a missing object.

A tree watch reauthorizes before every event it sends and every 250 ms while
idle, and an execution authority watch every 250 ms; revocation closes the
stream within that interval. Between checks canopyd reuses the previous
decision until the database changes (a write through its connection, or a
commit by any other) or execution authority is invalidated, so an idle
check costs one trivial query. Execution token revocation, expiry, and its
host validity callback are checked every time.

## Sidecars

- [Merge sidecar](merge-tool.md) and [writing a sidecar](writing-a-sidecar.md)
- [Execution sidecar](execution-sidecar.md)
- [Deployment](../../../packages/canopyd/deploy/README.md)
- [Migrations](../../../packages/canopyd/migrations/README.md)
