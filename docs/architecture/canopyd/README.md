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
tree configurations itself, and owns acceptance. Table definitions, the schema stamp, and the startup schema
assertion live in `schema.ts`; the [schema history](../../../packages/canopyd/migrations/README.md#schema-history)
lists every stamp. Startup reads only the schema: the stamp, then each table's
columns and the indexes queries rely on. Any difference is a
`SchemaMismatchError`, and `canopyd` serves maintenance mode rather than the
data root. The row invariants (every tree has accepted history, every account
a device, no foreign key dangles) scan whole tables, so the integrity audit
checks them instead.

## Accounts and canonical paths

The spec leaves placement to each host; this is canopyd's policy. Why tree
configurations have their shape, and the tests for each refused case, are in
[tree configurations](tree-configurations.md).

- **Finding a configuration.** `;arbor-config` is honoured on a tree's root
  only, in the raw path (`%3B` is a filename): `/.arbor/trees/tr_x;arbor-config`
  serves it, `/.well-known/arbor/<canonical root>;arbor-config` resolves to it,
  and the canonical URL sends an administrator to the first with `303`. Anyone
  else gets what an unreadable tree gets.

- **Community profile.** The tree canonical at `/` is the community's
  membership profile and keeps `type: group`. Its tree configuration grants
  the root itself `admin`, so its members are the Canopy's administrators.
  A bootstrap that opts its accounts out of membership lists their profiles
  as the root's administrators instead.
- **Accounts.** A community `members` entry's `handle` reserves `/~handle`
  for exactly that entry's person Profile TreeID; that person claims the
  account with their profile key ([accounts §1.2](../../overstory-spec/04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key)).
  A pending `handle` plus `inviteDigest` reserves the address without granting
  membership. A claimant presents the matching random code and proves their
  newly created Profile TreeID with the same profile-key signature. Claim
  replaces the pending entry with that Profile TreeID in the accepted
  community root, and declares the profile tree with its first tree
  configuration. Accounts are keyed by profile TreeID (`accounts.id`), and a
  profile has one account here; a claim for a profile claimed elsewhere on
  this host is refused. Removing the entry disables the account.
- **Mounts are the canonical paths.** Canonical boundaries are recomputed
  from `mounts.yaml`: the root at `/`, each member's profile at `/~handle`
  (canopyd inserts that mount when the profile is claimed and activates), and
  every other mount below its parent's boundary. The root's `mounts.yaml`
  holds its other top-level names and may not name a reserved or claimed
  `~handle`. Mounting a tree requires administering both parent and child
  ([accounts §3.1](../../overstory-spec/04-accounts-and-devices.md#31-who-may-edit-a-tree-configuration)),
  so "below your own `/~handle`" is "administer your profile", and a free
  top-level name needs a root administrator.
- **One rule for `/~name`.** A name is either a person's (reserved or
  claimed) or held by trees (a root mount at `~name` or below it). Reserving a
  handle or claiming an account is refused while mounts hold the name, and a
  root mount under a person's name is refused.
- **Group membership.** A profile subject that is a `type: group` tree grants
  its access to every member whose Profile TreeID its `members` list names.
  A `members` entry that is not a structured entry, such as a bare string,
  is ignored.
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
- **Administration.** Each hosted tree's `access.yaml` names its
  administrators with `admin`; there is no owner column, adoption or `access`
  table. canopyd indexes each accepted configuration into `tree_policy`
  (rules), `tree_admins` (administering profiles), `app_policy` (a profile's
  `apps.yaml`) and `mounts`, and authorizes from those rows and
  `profile_facts`. A group administers through its current members, and an
  update that would remove the last member of a group administering any tree
  is refused. A disabled account's device credentials stop working, but the
  rules naming its profile stay as written. When a person has lost every
  administrator device, the host operator runs `canopyd recover <handle>`
  beside the running server (`recoverAccount`, `createRecoveryPairing`): it
  writes a day-long recovery pairing, whose ID begins `pr_`, and prints its
  code. Claiming it replaces the person's `devices.yaml` with the claiming
  device, as an administrator, and revokes every other device in the same
  commit (accounts §5.3).
- **Device keys and sessions.** Every device is a key device, and a session
  is the only way it authenticates. A `devices` row holds the public key the
  device enrolled with, by claim or pairing (`insertDevice`); the key is also
  in `devices.yaml`, which is authoritative, and accepting a configuration
  refuses an entry without a key or with a key other than the row's. The key is
  required unless the row is revoked: devices revoked while they still had
  bearer credentials, before [schema 26](../../../packages/canopyd/migrations/026-key-devices-only/README.md),
  keep keyless rows so their DeviceIDs are never reused. `devices.yaml` history
  from before then still parses, entries without `key` included. Session challenges
  are `challenges` rows of purpose `device-session` (account claims' are
  `account-claim`), consumed exactly as issued; a session is a
  random `ars_` token whose digest `device_sessions` holds for at most an hour
  (`sessionLifetimeMs`). Deleting a device or claiming a recovery pairing
  deletes its sessions, and a watch rechecks its session's expiry outside the
  cached authorization. A request whose bearer token authenticates nothing is
  refused with 401 on every route.
  Unauthenticated challenge requests are limited to 30 per caller and profile
  per ten minutes, and pairing claims to 10 per caller and pairing; the
  limiter keeps at most 10,000 keys, and its caller address comes from proxy
  headers canopyd does not verify (`attempt-limiter.ts`, `clientAddress` in
  `host.ts`). As a
  home host canopyd publishes each profile's key devices at
  `GET /.arbor/profiles/{ProfileTreeID}/device-keys` without authentication
  (`publishedDeviceKeys`; accounts §5.4): the listed, unrevoked devices'
  DeviceIDs, keys and administrator flags, never labels.
- **Placement role.** canopyd is also a placement host
  ([accounts §1.3, §5.4](../../overstory-spec/04-accounts-and-devices.md#13-placement-accounts)).
  A placement account is an `accounts` row whose `home_host` names the
  profile's home origin (NULL for a home account, [schema 27](../../../packages/canopyd/migrations/027-placement-accounts/README.md)).
  The claim (`claimPlacementAccount`) takes the same reservation and
  profile-key proof as a home claim, with `homeHost` in the signed challenge
  and no device or configuration; it refuses this host's own origin, a plain
  `http:` home unless this host is itself served over `http:` (local hosts
  only), and a home whose device keys it cannot read now. One transaction
  records the account and declares its **placement root**: an ordinary tree
  with a fresh TreeID, mounted as the member mount at `/~handle`, whose
  configuration grants the profile `admin` and mounts nothing; the person's
  first snapshot activates it. The device-key copies are memory only
  (`PlacementDeviceKeys` in `placement.ts`): a copy serves for
  `deviceKeyLifetimeMs` (60 s); a challenge naming a DeviceID the copy lacks,
  or a fetch that failed, refetches at most once per `deviceKeyRefetchMs`
  (5 s) per profile, and such a challenge within the interval waits for the
  refetch rather than being refused; and a copy the host cannot refresh keeps opening
  sessions until it is `deviceKeyStaleMs` old (the grace, one hour), then
  opens none. A session opened there expires by the time the copy it was
  opened from runs out of grace (`servesUntil`), so while a home is down
  nothing authenticates from a list older than the grace, and while it is up
  sessions end at most a lifetime short of an hour. Each is a
  `HostDaemonOptions` field, as `sessionLifetimeMs` is, and `serveHost` takes
  them as `lifetimes`. A device's first session there inserts its `devices` row with
  the listed key and an empty label (labels are the home host's), which keeps
  `device_sessions`' foreign key. Every half lifetime, and so within a
  lifetime of a session opening, canopyd refetches the keys of each placement
  account with an open session (`refreshDeviceKeys`); a device no longer
  listed, or listed with another key, gets `revoked_at` and loses its
  sessions, and its watches close at their next authorization check. A listed
  `administrator: true` gates configuration edits, declaring and activating
  trees as `devices.yaml`'s flag does at a home host. The account's
  configuration tree, pairing and recovery are refused with 403
  `permission-denied` and `details.homeHost` (`PlacementAccountError`); the
  account descriptor carries `homeHost` and `placementRoot` and no
  `configuration`. canopyd never republishes the keys it read, and code
  acting for a placement account's caller gets only `everyone` grants and its
  trees' `app` rules: the caller lends nothing, since its `apps.yaml` is at
  its home (`executionAllows` in `access.ts`).
- **Remote groups.** A profile subject with a `homeHost`
  ([access control §3.3](../../overstory-spec/05-access-control.md#33-groups-another-host-holds))
  naming a group whose tree canopyd does not hold matches through an
  in-memory copy of that group's members (`RemoteGroups` in
  `remote-groups.ts`, `isGroupMember` in `access.ts`). As for a placement
  claim's home, a plain `http:` loopback `homeHost` is read only when canopyd
  is itself served over `http:` (`servedOverHTTP`); a public host never reads
  its own loopback, and such a rule matches nobody there. canopyd reads the
  group anonymously from its host: `GET /.arbor/trees/{TreeID}`, then the
  root directory and root `_index.md` objects, each checked against its hash,
  keeping the Profile TreeIDs of the structured `members` entries only if the
  root declares `type: group`. A 4xx answer (the tree is private, unknown or
  gone) or a root that is not a group leaves a copy that matches nobody; a
  timeout, network error, 5xx or bad object is an outage. Copies are keyed by
  host and group and kept for every such subject in any `access.yaml` or
  `apps.yaml` canopyd holds (`namedRemoteGroups`): fetched at start, as soon
  as an accepted configuration names one it has no copy of, and every half
  `remoteGroupLifetimeMs` (60 s) by `refreshRemoteGroups`. A failed fetch is
  retried at most once per `remoteGroupRefetchMs` (5 s) per group, and a copy
  it cannot refresh serves until it is `remoteGroupStaleMs` old (the grace,
  one hour), then matches nobody. Membership checks never wait on another
  host: a missing copy matches nobody while its fetch runs. Any change in
  what a copy matches, including running out, invalidates the execution
  authority, which changes the authorization epoch, so watches and
  executions check again. A group tree canopyd holds decides alone, whatever
  `homeHost` a rule names for it, and a remote group counts only profiles
  with an enabled account here, as a local one does.
- **Errors.** A request canopyd cannot accept is a 400 with the reason; a
  failure of canopyd's own state, a component it trusts, the database, or a
  system call is a logged 500 whose detail stays in the log
  (`ServerFaultError`, `isServerFault` in `errors.ts`); a full bounded
  resource is a retryable 503 (`ServerBusyError`). A placement account's
  profile-configuration route is a 403 naming its home host
  (`PlacementAccountError`), and a session a placement host cannot open from
  a fresh enough copy of the home host's device keys is a retryable 503
  naming it (`HomeHostUnavailableError`).

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
decision until the database changes (a write through its connection other
than a device's last-use time, or a commit by any other) or execution
authority is invalidated, so an idle
check costs one trivial query. Execution token revocation, expiry, and its
host validity callback are checked every time.

## Sidecars

- [Merge sidecar](merge-tool.md) and [writing a sidecar](writing-a-sidecar.md)
- [Execution sidecar](execution-sidecar.md)
- [Deployment](../../../packages/canopyd/deploy/README.md)
- [Migrations](../../../packages/canopyd/migrations/README.md)
