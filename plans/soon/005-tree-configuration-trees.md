# canopyd 005: Configure each hosted tree, profiles included, in its own configuration tree

Historical identifier: **Security 005** (moved to canopyd 2026-09-24; not the
earlier Security 005 that became Filesystem 005).

## Status

- **Priority:** P3
- **Effort:** L
- **Risk:** HIGH. It changes who may change a tree's access and address,
  replaces the account configuration that every client edits and pairs
  devices through, changes the host's authorization model, and needs a live
  migration.
- **State:** ADOPTED 2026-09-25. The design below is proposed; the remaining
  open questions are listed at the end. Nothing here changes the spec until
  phase 1.
- **Followed by:** [Security 006](../security/006-home-host-vouching.md)
  (placing trees on other hosts), [Security 007](../security/007-device-keys.md)
  (signed device keys and recovery) and
  [Security 008](../security/008-portable-profiles.md) (portable profiles and
  cross-server delegation).
- **Builds on:** schema 21. [Migration 019](../../packages/canopyd/migrations/019-one-access-store/README.md)
  (schema 20, one access store) is the ownership model this replaces.

## The problem

A hosted tree's configuration lives in an account. Each account's `trees.yaml`
([accounts §3](../../docs/overstory-spec/04-accounts-and-devices.md#3-configuration-yaml))
holds, for every tree it hosts, the canonical URL and the access rules. That
entry is also the only evidence of who controls the tree: the spec says an
entry without `canonical` does not "claim ownership", but never says who owns
a tree, and [access control §1](../../docs/overstory-spec/05-access-control.md#1-subjects-and-rules)
relies on "hosted resource owners" without defining them.

In practice this shows up as:

- **Ownership is inferred.** canopyd records it in `trees.account_id`: the
  account that activated the tree, or, after schema 20, the first account
  whose `trees.yaml` hosts a tree no account owned. That second rule exists
  only for trees created at bootstrap, and with several bootstrap accounts it
  depends on which account was created first.
- **One owner only.** Two people cannot both administer a shared tree. Two
  hosting entries for one tree would each carry an ACL, with no rule for which
  wins, so schema 20 refuses the second.
- **Groups cannot own trees.** A group profile has no account, devices or
  configuration tree, so a tree that a group, rather than one of its members,
  should control has nowhere to keep its configuration.
- **The community root is a special case.** canopyd's policy is that
  whoever can write `/` administers the community
  ([host](../../docs/architecture/canopyd/README.md#accounts-and-canonical-paths)).
  That set is plural by nature, so the root stays in the `access` table, the
  last tree governed outside any configuration.
- **Addresses are special-cased too.** Which paths an account may declare is
  a host rule ("below your own `/~handle`; an administrator also below an
  unclaimed `/~name`"), although the address is already an entry in the parent
  tree: the host rewrites the parent's directory to add a boundary entry naming
  the child's TreeID (`prepareAccountBoundaryRewrites`,
  [canopy.ts](../../packages/canopyd/src/canopy.ts)).
- **The account configuration mixes two things.** Devices and the consents by
  which a person lets code use access they hold (`via` rules) belong to the
  person. A tree's address and ACL belong to the tree.
- **An account duplicates its profile.** Apart from the hosting half of
  `trees.yaml`, nothing in the account configuration is about the host:
  `account.yaml` repeats what the host recorded at claim, and devices and
  consents describe the person. Yet it is a second governed tree per person,
  with its own policy (`account-config-v2`) and its own TreeID standing for
  the account.
- **Code has one sponsor.** The author side of an execution is the one
  account that owns the code tree. Two people cannot both back code, and a
  group cannot back code at all, even with access that was granted to the
  group.

## The design

Every hosted tree has a private **tree configuration**: a second tree, edited
only by the tree's administrators, holding who may do what to the tree,
administering it included, and which child trees it mounts at which names. A
profile tree's configuration also holds what belongs to the profile: which
apps may use its access and, for a person, their devices. There is no
separate account configuration. A **host account** becomes host state: this
profile is claimed here, with this handle.

The rule field `via` is renamed `app` everywhere, in the configuration and
the spec's `AccessRule`. Joe is the only user, so this is a clean break at
cutover.

### Tree configuration

A private, noncanonical Overstory tree with the closed, code-defined server
policy `tree-config-v1`, which replaces `account-config-v2` and is likewise not
a plugin mechanism. One file per concern, each a bare top-level shape with no
wrapper key:

```text
/
  access.yaml     every tree: who may do what, administrators included
  mounts.yaml     every tree: child trees by name
  apps.yaml       profile trees: apps that may use the profile's access
  devices.yaml    person profiles: the person's devices
```

Which files are allowed depends on the tree's kind. A person profile is known
from its self-certifying TreeID, which the host verifies at claim; a group
profile from its accepted root, as `profile_facts` already records. If a tree
stops being a group profile, its `apps.yaml` stops applying and further edits
must remove it. Every other path is rejected, and the graph shape identifies
the generation. A tree configuration has no tree configuration of its own,
cannot be mounted, and is absent from canonical resolution and public
discovery.

**`access.yaml`**

Today's resource-rule list for this tree, with three changes: `via` is renamed
`app`, `who: me` is invalid because a tree configuration has no single policy
account, and a new operation `admin` names the administrators. Rules are
`who` / `app` / `allow` / `within`, merged by canonical `(who, app, within)`.

```yaml
- who: {profile: tr_joe}
  allow: [admin]
- who: {profile: tr_alice}
  allow: [read, create-child]
- who: {link: sha256:4f1c…}
  allow: [read]
```

- `admin` may only be granted to a person or group profile, alone or with
  other operations, in a rule with no `app` and no `within`. A person profile
  administers directly; a group profile through its current `members`, the
  one-level membership check access rules already use.
- An administrator may read and edit the tree configuration and has `write` on
  the whole tree. No other rule needs to name them.
- `admin` is the only operation a rule cannot narrow: there is no
  administering a subtree, or administering only through an app.

**`mounts.yaml`**

Child trees at logical paths relative to this tree's root, keyed by path:

```yaml
todos: tr_todos
projects/garden: tr_garden
```

- The host maintains each mount as the boundary entry in this tree's content,
  as it does for declarations today, and the child's canonical URL follows from
  the parent's. A tree is mounted at most once.
- **Mounting** a tree requires the submitting device's profile to administer
  both this tree and the child. That stops anyone giving your tree an address
  you did not choose. **Renaming or removing** a mount needs only this tree's
  administrators: the parent controls its namespace.
- The community root mounts person profiles from its `members` handles, as
  today: a `handle` entry mounts that member's profile tree at `/~handle` once
  it is active. The root's `mounts.yaml` holds its other top-level names and
  may not name a reserved or claimed `~handle`.

This replaces canopyd's declared-path rules. "Below your own `/~handle`" is
"administer your profile tree", and "a community administrator may use a free
top-level name" is "administer the community root".

### Finding it

The tree configuration's TreeID is derived from the tree's (a hash of a fixed
label and the TreeID; exact form in phase 1), so there is no pointer to keep
consistent and a configuration cannot be attached to the wrong tree.

Every locator of a tree addresses its configuration with a new segment
parameter:

```text
https://arb.nxhx.org/~joe/todos;arbor-config
arbor://tr_todos;arbor-config
```

It follows renames, works for a tree with no canonical path, and cannot
collide with a filename (a literal `;` is `%3B`,
[locators §3](../../docs/overstory-spec/03-locators.md#3-parsing-and-canonicalization)).
The host answers it only to administrators and otherwise exactly as it answers
the tree's own URL, so it reveals nothing more. It is the tree's configuration,
not only its access, so the name is not `;arbor-access`.

### Who may edit it

An update to a tree configuration is authorized when the submitting device is
an `administrator` device in the `devices.yaml` of a person profile that has
`admin` on the tree, directly or through a group. This matches "only administrator devices may edit
resource policy" ([access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority)):
an administrator device acting for an administering profile. Authorization
reads the current accepted configurations, never the proposed one, so an edit
cannot add its own submitter.

A person profile's configuration governs itself, as the account configuration
does today: its own `devices.yaml` names the devices that may edit it, with
today's per-device rules (any listed device may change its own label;
administrator devices may do the rest, including pairing and revoking).

### Invariants

- `access.yaml` always has at least one `admin` rule. A merge whose result
  would remove the last one is a conflict.
- A person profile's configuration grants `admin` to that person's profile and
  no one else, so only the person can pair devices or lend their access. A
  group profile's may name other administrators; they then act for the group,
  lending included.
- A person profile's `devices.yaml` always has at least one administrator
  device, as the account configuration's does today.
- A group profile that has `admin` on any tree keeps at least one member: an
  update to that group's `members` that removes the last one is refused. The
  host already indexes `members` in `profile_facts`.
- Concurrent edits use the account configuration's restrictive merge:
  disjoint changes merge, removal beats a concurrent edit of the same entry,
  and ambiguous policy edits enforce the intersection until an administrator
  resolves them.

### Declaring, activating and mounting a tree

1. **Declare.** A client generates the TreeID and submits the tree
   configuration's first snapshot (base `null`), addressed through that TreeID.
   It must give the submitter's profile `admin`. The host reserves the
   TreeID; the tree is `awaiting-initialization`, unreadable and unresolved.
   This replaces adding an entry to `trees.yaml`.
2. **Activate.** An administrator submits the tree's first snapshot, exactly
   as [accounts §6](../../docs/overstory-spec/04-accounts-and-devices.md#6-declaring-and-activating-a-tree)
   does now.
3. **Mount.** An administrator of the parent and the child adds the mount to
   the parent's `mounts.yaml`. A pending tree may be mounted; its boundary
   appears when it activates.

Each step is an ordinary update of one tree. Remote deletion stays deferred
([spec deferred 1](../../docs/overstory-spec/README.md#deferred)); retiring a
tree retires its configuration.

### Host accounts

A host account is the host's record that a profile is claimed here: the
profile TreeID, the handle, and the credential bindings of that profile's
devices. It has no authored tree. Its identity is the pair of host and profile
TreeID, which replaces the configuration TreeID as account identity
([accounts §1](../../docs/overstory-spec/04-accounts-and-devices.md#1-profiles-and-host-accounts)).

Claiming ([accounts §1.2](../../docs/overstory-spec/04-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key))
keeps its challenge and profile-key proof. The challenge's `configurationTree`
becomes the profile's derived configuration TreeID instead of a fresh one, and
the claim declares the profile tree: it creates its configuration with the
first administrator device and `admin` for the profile, and the profile tree
is `awaiting-initialization` until the person activates it. Pairing
([accounts §5](../../docs/overstory-spec/04-accounts-and-devices.md#5-device-pairing))
edits the profile configuration's `devices.yaml`.

**One host per profile, until Security 006.** Device credentials stay
bearer secrets whose digests one host binds, so a profile's configuration
lives on the one host that binds them: its **home host**. Clients connect a
profile to one host. The spec's several accounts per profile returns with
[Security 006](../security/006-home-host-vouching.md), where other hosts take
the home host's word for who is calling. Joe has one host and one account, so
nothing is lost at cutover.

`trees.yaml` goes: its hosting half moves to tree configurations, and its
`via` rules to the profile's `apps.yaml`. `account.yaml` goes: `canopy` is the
host itself and `profile` is the tree the configuration belongs to.
`devices.yaml` moves unchanged.

### `apps.yaml`

What a profile lets each app do with access the profile holds, keyed by the
app's TreeID, which is how a consent sheet reads ("Supplies may read Alice's
pantry"). It lives in the configuration of the profile tree, so a person's is
edited by that person's administrator devices, and a group's by its
administrators. Until [Security 008](../security/008-portable-profiles.md), an
entry applies only on the home host.

```yaml
# /~joe;arbor-config  apps.yaml
tr_supplies:
  - resource: tr_alice_pantry
    allow: [read, create-child]
    within: /inventory
```

- Each entry is a resource rule with `resource` in place of the key and the
  app implied by the key: `resource` / `who` / `allow` / `within`, merged per
  app by canonical `(resource, who, within)`. `admin` is invalid here.
- The default `who` names the profile itself: `me` in a person's file,
  `members` in a group's. Each is invalid in the other. A person's `me` lets
  the app use the person's access when the person runs it; a group's `members`
  approves the app for every current member at once.
- Any other `who` **lends** the access to other callers of the app; see below.
- A rule without an app could only narrow access the profile already has, so
  it has no form here, and `canonical` goes too. What remains is what Canopy's
  resource consent already writes (`ResourceConsent.swift`).

### Code that lends its author's access

This replaces the sponsoring account
([access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority)),
today `sponsor: tree.accountID`. There is no `sponsor` field.

- **Code always runs as its caller**, or anonymously. Nobody else's identity is
  ever the actor, and writes are attributed to the caller.
- **Only the subject a grant names can lend it.** A rule naming
  `{profile: tr_joe}` is Joe's to lend; a rule naming
  `{profile: tr_garden_club}` is the club's, and no member may lend it,
  though each holds it. The granter decides who decides by choosing whom to
  grant. `everyone` grants need no lending, since a rule without `app` already
  works through code, and link grants are not lendable.
- **Approving an app for yourself is not lending.** A person's `who: me` entry
  may use any access the person holds, including through a group: nobody else
  gains anything, and the caller is still the person.
- **Each lent capability is a grant naming its lender**, as
  `ExecutionGrant.account` already records
  ([execution-authority.ts](../../packages/canopyd/src/execution-authority.ts)).
  A grant from one lender never widens another's. Checking one needs to know
  how the lender holds the access, directly or only through a group, which is
  grant provenance the spec already keeps.
- **Several lenders are several grants.** When the granter named several
  subjects and more than one lends the same capability, either covers the
  requirement; the host picks one by a fixed order (the caller's own access
  first, then lender profile TreeID) and records it. If that grant lapses, the
  execution is revoked like any other lost grant.
- **Lending can only narrow** what the lending profile currently holds, and
  lapses when that access does.
- **Lending trusts the app's administrators**, who may change its code inside
  the envelope, as the spec already says of maintainers.
- **Lending write** to callers other than the lender is allowed, and the
  consent sheet warns before writing it.

Lending is for access a profile holds on a tree it does not govern. A tree's
administrators grant access through code directly, as tree policy: an
`access.yaml` rule with `app` applies only to requests through that app, needs
no lender behind it, and survives any one administrator leaving. The consent
sheet writes that rule for a tree the approver administers, and `apps.yaml`
otherwise.

## Examples

Profile TreeIDs are shortened. The community root is `tr_garden_root`,
canonical at `https://arb.nxhx.org/`.

### Joe's profile, `/~joe`

Mounted by the root from its `members` handle `joe`.

```yaml
# /~joe;arbor-config  access.yaml
- who: {profile: tr_joe}
  allow: [admin]
- who: everyone
  allow: [read]
```

```yaml
# mounts.yaml
todos: tr_todos
notes: tr_notes
```

```yaml
# devices.yaml
dv_mac:
  label: "Joe's Mac"
  administrator: true
dv_phone:
  label: "Joe's iPhone"
```

`apps.yaml` holds Joe's app approvals and lends; see below. The configuration
may name no administrator but `tr_joe`. This one tree replaces Joe's account
configuration.

### Joe's private todos, shared with Alice, `/~joe/todos`

```yaml
# access.yaml
- who: {profile: tr_joe}
  allow: [admin]
- who: {profile: tr_alice}
  allow: [read, create-child]
```

`mounts.yaml` is `{}`.

### A tree Joe and Alice run together, `/~joe/trip`

```yaml
# access.yaml
- who: {profile: tr_joe}
  allow: [admin]
- who: {profile: tr_alice}
  allow: [admin]
- who: {link: sha256:9b2e…}      # the link Joe texted the hosts
  allow: [read]
```

Both may change the rules or add administrators. The tree lives in Joe's
namespace, so only Joe (as administrator of `/~joe`) can rename or unmount it;
Alice could not mount it under `/~alice` without Joe first unmounting it.

### A group and a tree the group administers

The garden club's profile tree, mounted at the top level by a community
administrator who also administers the club's profile:

```yaml
# /;arbor-config  mounts.yaml
~garden-club: tr_garden_club
```

```yaml
# /~garden-club;arbor-config  access.yaml
- who: {profile: tr_garden_club}  # the club's members administer its profile
  allow: [admin]
```

Its plant records, administered by the club and mounted under it:

```yaml
# /~garden-club/plants;arbor-config  access.yaml
- who: {profile: tr_garden_club}
  allow: [admin]
- who: everyone
  allow: [read]
```

Adding someone to the club's `members` makes them an administrator of both.
The club cannot remove its last member while it administers these trees.

### The community root, `/`

```yaml
# /;arbor-config  access.yaml
- who: {profile: tr_garden_root}  # the root is the community group profile
  allow: [admin]
- who: everyone
  allow: [read]
```

```yaml
# mounts.yaml
~garden-club: tr_garden_club
```

The community's members administer the community, which is canopyd's policy
today, now with no `access` table or unowned-tree case behind it.

### An administrator's grant to an app

Joe's supplies app publishes part of a private data tree he administers:

```yaml
# /~joe/supplies-data;arbor-config  access.yaml
- who: {profile: tr_joe}
  allow: [admin]
- who: everyone
  app: tr_supplies
  allow: [read]
  within: /published
```

Anyone may read `/published`, but only through the supplies app. This is the
data tree's own grant, so it survives Joe losing access elsewhere and would
work the same if the garden club administered the data.

### `apps.yaml`

Joe lets two apps use his own access, as Canopy's consent sheet writes it:

```yaml
# /~joe;arbor-config  apps.yaml
tr_supplies:
  - resource: tr_alice_pantry    # Alice's tree; she granted Joe write
    allow: [read, create-child]
    within: /inventory
tr_planner:
  - resource: tr_club_calendar   # Joe reads it as a club member
    allow: [read]
```

The planner entry is valid although Joe holds that read only through the club:
he is approving it for himself.

The library grants Joe read on its catalog by name. He lends it to anonymous
visitors of his homepage, only through that page's code:

```yaml
tr_joe_homepage:
  - resource: tr_library_catalog
    who: everyone
    allow: [read]
    within: /new-books
```

### A group lends what it was granted

The club calendar grants `{profile: tr_garden_club}` read. Joe cannot lend that
to his homepage's visitors, though he is a member; the club can, for its own
page, and can approve a planner for all its members:

```yaml
# /~garden-club;arbor-config  apps.yaml
tr_garden_club_page:
  - resource: tr_club_calendar
    who: everyone
    allow: [read]
    within: /events
tr_planner:
  - resource: tr_club_calendar
    who: members
    allow: [read]
```

Any administrator of the club's profile may edit this file. Members come and
go without affecting the page, which lapses only if the calendar stops
granting the club.

## Decided

- **A separate tree, not a file inside the tree.** Objects are shared across a
  host, and any reader of any tree may fetch an object whose hash they know
  ([tree operations](../../docs/overstory-spec/01-tree-operations.md), object reads).
  A reserved file's hash is in the root directory every reader receives, so
  its content cannot be hidden without serving a directory that does not match
  its hash. It would also need per-path write rules, which Overstory does not
  have, appear in every placed folder, and need a different merge from its
  neighbours.
- **Not a second root inside the tree (a "resource fork").** Kept private, the
  fork needs its own head, never reachable from the content root, and its own
  update sequence, or readers see when access changes and pending writers
  rebase for nothing. That is a separate tree sharing a TreeID, bought with a
  change to the core model that every client implements.
- **Not a sibling path such as `/~joe/todos.access`.** It takes a real name
  inside the parent, must move with every rename, has nothing to pair with for
  a tree without a canonical path, and publishes a probe for private trees.
- **A directory of files, not one file.** A tree root is always a directory,
  and one file per concern keeps each file's merge key simple.
- **No account configuration.** A profile tree's configuration holds the
  person's devices and app entries, and an account is host state. One kind of
  configuration, one policy and one way to find it, `;arbor-config`, replace
  two. The cost is one host per profile until
  [Security 006](../security/006-home-host-vouching.md) lets a profile place
  trees on other hosts. Merging now, rather than later, avoids a second live
  migration.
- **Administrators are an operation in `access.yaml`, not a separate list.**
  "Who can do what to this tree" gets one answer, the way a sharing panel shows
  it. The cost is a few validation rules on `admin`.
- **No sponsor.** Lending is an `apps.yaml` entry in the lender's own profile
  configuration, so nobody can lend someone else's authority, several
  profiles can back one app, and nobody needs to administer an app to back it.
  A sponsor field would need its own rules (a person profile, a direct
  administrator, set only by that profile's account) and would still pick one
  person for a group's code.
- **`apps.yaml` belongs to a profile, not an account.** Lending is something
  an identity does, so groups lend exactly as persons do.
- **Only the named subject lends.** Access granted to a group is the group's
  to lend; the granter's choice of subject settles who decides. The one
  exception is approving an app for your own use.
- **`me` for a person, `members` for a group**, one spelling per file, so equal
  rules never differ by spelling.
- **`apps.yaml` keyed by app, and `app` for `via`.** Every entry is about an
  app, so the app is the key and the field disappears there. `app` remains
  only in `access.yaml`, for an administrator's grant through an app.
- **Outside administrators of a group act for it.** Whoever administers a
  group's profile may lend the group's access; governing a group means acting
  for it.
- **Lending write warns, it is not refused.**
- **The address belongs to the parent.** See `mounts.yaml`.
- **The cost is one-time.** The 2026-09-25 backup has three hosted trees and
  one account. Each gains a configuration of a few hundred bytes.
  Authorization reads derived indexes, not the trees, and clients fetch a
  configuration only when the sharing panel opens, so nothing more is watched.

## Open questions

1. **Recovering a tree with no reachable administrator.** The invariants stop
   an empty list and an empty administering group, but not administrators
   whose accounts are disabled or whose devices are all lost. For a person
   profile, the profile key could authorize a reset of `devices.yaml`, which
   [Security 007](../security/007-device-keys.md) may settle. A host-operator
   CLI command is the likely answer; it ties to the catalog's
   [recovery and administrator reset](../catalog.md#product-completion).
2. **Two meanings of "administrator".** A device's `administrator` flag and a
   profile's `admin` on a tree are two layers of one idea. Keep both names, or
   rename the device flag?
3. **The derived TreeID's form**, and whether its prefix shows that it is a
   configuration.
4. **How declaring is addressed**: an update to
   `/.arbor/trees/{TreeID};arbor-config/updates`, or a field in the request
   naming the tree.

## Work

One clean break at cutover: Joe is the only user, so there is no dual-format
period. Phases 1–4 land on `main` without
changing the live host.

### Phase 1: spec and vectors

- Answer the open questions and record the answers here.
- [Accounts](../../docs/overstory-spec/04-accounts-and-devices.md): §1 for
  host accounts as host state, identified by host and profile, and one host
  per profile until Security 006; §1.2 for claiming as declaring the profile
  tree; §2 and §3 replaced by the tree configuration graph, its files by tree
  kind, invariants and merge; §5 for pairing through the profile's
  `devices.yaml`; §6 rewritten as declare, activate, mount; §7 for
  `tree-config-v1`, retiring `account-config-v2`.
- [Access control](../../docs/overstory-spec/05-access-control.md) §1: rename
  `via` to `app`; add `admin` and define administrators; drop "hosted resource
  owners"; `me` and `members` only in `apps.yaml`; §1.1 replaces the
  sponsoring account with lenders, the named-subject rule and its
  self-approval exception.
- [Execution sidecar](../../docs/architecture/canopyd/execution-sidecar.md):
  lenders for the sponsoring account.
- [Locators](../../docs/overstory-spec/03-locators.md) §3 and §5: the
  `arbor-config` parameter, mounts as the source of canonical boundaries.
- [Conformance](../../docs/overstory-spec/conformance/README.md): graph,
  validation and merge vectors for both configurations.
- Remove "no distinguished home host" only as far as one host per profile
  requires, and link Security 006.
- **Gate:** `bun run check:links`, the walk-through below.

### Phase 2: parsers and merge

- Protocol package (TypeScript) and Overstory package (Swift): parse,
  validate and merge the tree configuration graph, including a profile's
  `apps.yaml` and `devices.yaml`, with `app` for `via` in `AccessRule`; delete
  the account configuration graph (`account-config-graph.ts`,
  `account-config.ts`).
- **Gate:** both suites pass phase 1's vectors.

### Phase 3: canopyd

- `tree-config-v1` policy: authorization through administering profiles and
  groups, mounts applied as boundary rewrites, invariants including the
  group-member rule on profile updates and a person profile's sole
  administrator, and device authorization and credential revocation read from
  person profile configurations.
- Execution authority: `ExecutionContext.sponsor` and the `author` role give
  way to lent grants, each checked against its lender's `apps.yaml` entry and
  against a rule naming the lender directly, except for self-approval
  ([execution-authority.ts](../../packages/canopyd/src/execution-authority.ts),
  [access.ts](../../packages/canopyd/src/access.ts)).
- Derived state keyed by tree: rules and administrators per tree, app entries
  per profile, devices per person profile. Accounts keyed by profile, not
  configuration TreeID. Delete `trees.account_id`, adoption, the `access`
  table, the declared-path rules and the account configuration tree.
- Declaration through the tree configuration; claiming as declaring the
  profile tree; `;arbor-config` resolution.
- Migration 022 (schema 22), rehearsed on a fresh backup.
- Update [canopyd's README](../../docs/architecture/canopyd/README.md#accounts-and-canonical-paths)
  here, when its policy changes.
- **Gate:** canopyd suite, `test:protocol`, a rehearsal report.

### Phase 4: clients

- CLI tree declaration and mounting; the CLI and Arbor Sync store the derived
  profile configuration TreeID where they store the account configuration's
  (`packages/cli`, `packages/arborsync/src/state/local-accounts.ts`,
  `packages/client/src/account-bootstrap.ts`).
- Mac and iPhone: account bootstrap and pairing through the profile
  configuration, the sharing panel reading and editing the tree configuration, resource consent writing a profile's `apps.yaml` or an
  `app` rule in a tree it administers, offering to approve for a group the
  person administers, and warning before lending write
  (`AccountConfigurationYAML.swift`, `ResourceConsent.swift`,
  `Credentials.swift`).
- **Gate:** Swift suites, the Arbor Sync and CLI suites, and a local
  end-to-end against a phase 3 canopyd: claim, pair a second device, revoke
  it, share a tree, approve an app.

### Phase 5: cutover (needs Joe's go-ahead)

- Back up, deploy, run migration 022, install the Mac and iPhone builds.
- Record the result in `status.md` and delete this plan.

### Migration 022

For each hosted tree, one tree configuration, and for each account, its
account configuration folded into its profile's:

| Tree | `access.yaml` | `mounts.yaml` |
|---|---|---|
| `/` | `admin` for the root itself, plus the `access` table's rules minus those the members now hold as administrators | top-level names other than handles |
| an owned tree | `admin` for the owner's profile, plus the owner's `trees.yaml` rules for it, minus `who: me` rules without `via` | its current nested boundaries |

A person profile, an owned tree like any other, also gets its account's `devices.yaml`
unchanged, and each credential binding moves to it with the same DeviceID, so
paired devices keep working once their clients store the new configuration
TreeID.

An owner's rule with `via` and a `who` other than `me` is the owner's grant
and lands in the tree's `access.yaml` with `app`. Every other `via` rule, on
any tree, lands in the `apps.yaml` of the account's profile under its
app. The migration refuses to run while any rule would be dropped other than
those covered by administration, or would lend access its account holds only
through a group, and lists every lent capability before and after, since code
that ran with its owner's authority now runs only with what `apps.yaml` and
`app` rules lend. Drop `trees.account_id`, `access` and each account
configuration tree, and rekey accounts by profile. As migration
019 did, the report lists each tree's whole-tree access before and after and
must show no difference.

## Verification

Before phase 1's spec edits: a written walk-through of the design against the
examples above plus the failures: removing the last administrator, emptying an
administering group, Alice trying to lend Joe's access, Joe lending access
granted only to his club, a co-administrator added to a person profile, two
named lenders covering one requirement and one losing access, a
non-administrator device editing another device, revoking the last
administrator device, and mounting a tree you do not administer. After each phase, its gate. At
cutover, the migration report and a check that `/`, `/~joe` and `/~joe/todos`
read and write as before from the Mac and the iPhone.
