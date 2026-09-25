# canopyd 005: Configure each hosted tree in its own configuration tree

Historical identifier: **Security 005** (moved to canopyd 2026-09-24; not the
earlier Security 005 that became Filesystem 005).

## Status

- **Priority:** P3
- **Effort:** L
- **Risk:** HIGH. It changes who may change a tree's access and address, the
  account configuration graph that every client edits, and the host's
  authorization model, and it needs a live migration.
- **State:** ADOPTED 2026-09-25. The design below is proposed; the remaining
  open questions are listed at the end. Nothing here changes the spec until
  phase 1.
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

## The design

Each hosted tree has a private **tree configuration**: a second tree, edited
only by the tree's administrators, holding who administers it, who may access
it, which child trees it mounts at which names, and which account sponsors its
code. The account configuration keeps what belongs to the person: devices and
consents.

### Tree configuration

A private, noncanonical Overstory tree with the closed, code-defined server
policy `tree-config-v1`, a sibling of `account-config-v2` and likewise not a
plugin mechanism. Its graph mirrors the account configuration's, one file per
concern, each a bare top-level shape with no wrapper key:

```text
/
  tree.yaml       administrators and sponsor
  access.yaml     resource rules
  mounts.yaml     child trees by name
```

The graph shape identifies the generation. Every other path is rejected. A
tree configuration has no tree configuration of its own, cannot be mounted,
and is absent from canonical resolution and public discovery, like the account
configuration.

**`tree.yaml`**

```yaml
administrators:
  - profile: tr_joe_profile
  - profile: tr_garden_club     # a group: its current members administer
sponsor: tr_joe_profile         # optional
```

- `administrators` is a nonempty list of person or group profile TreeIDs,
  merged by TreeID. A person profile administers directly; a group profile
  through its current `members`, the one-level membership check access rules
  already use.
- An administrator may read the tree configuration and has `write` on the tree,
  implicitly: no access rule needs to name them.
- `sponsor` names the person profile whose account's authority backs the
  tree's executable code ([access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority)).
  It replaces today's `sponsor: tree.accountID`. It must be a person profile
  that administers the tree directly. Setting it to a profile, or keeping it
  there through a change of administrators, must be submitted by that
  profile's own account: nobody lends someone else's authority. Any
  administrator may remove it. Without it, code in the tree runs with the
  caller's authority only.

**`access.yaml`**

Today's resource-rule list for this tree, with one change: `who: me` is
invalid, because a tree configuration has no single policy account. Everything
else is unchanged: `who` / `via` / `allow` / `within`, merged by canonical
`(who, via, within)`.

```yaml
- who: everyone
  allow: [read]
- who: {profile: tr_alice}
  allow: [write]
  within: /shared
- who: {link: sha256:4f1c…}
  allow: [read]
```

**`mounts.yaml`**

Child trees at logical paths relative to this tree's root, keyed by path:

```yaml
todos: tr_todos
projects/garden: tr_garden
```

- The host maintains each mount as the boundary entry in this tree's content,
  as it does for declarations today, and the child's canonical URL follows from
  the parent's. A tree is mounted at most once.
- **Mounting** a tree requires the submitting account's profile to administer
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
the tree's own URL, so it reveals nothing more. The name matches the account
configuration: this is the tree's configuration, not only its access.

### Who may edit it

An update to a tree configuration is authorized when the submitting device is
an `administrator` device of an account whose profile administers the tree,
directly or through a group. This matches "only administrator devices may edit
resource policy" ([access control §1.1](../../docs/overstory-spec/05-access-control.md#11-execution-authority)):
an administrator device acting for an administrator profile. Authorization
reads the current accepted configuration, never the proposed one, so an edit
cannot add its own submitter.

### Invariants

- `administrators` is never empty. A merge whose result would empty it is a
  conflict.
- A group profile that administers any tree keeps at least one member: an
  update to that group's `members` that removes the last one is refused. The
  host already indexes `members` in `profile_facts`.
- Concurrent edits use the account configuration's restrictive merge:
  disjoint changes merge, removal beats a concurrent edit of the same entry,
  and ambiguous policy edits enforce the intersection until an administrator
  resolves them.

### Declaring, activating and mounting a tree

1. **Declare.** A client generates the TreeID and submits the tree
   configuration's first snapshot (base `null`), addressed through that TreeID.
   The submitter's profile must be in `administrators`. The host reserves the
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

### The account configuration

```text
/
  account.yaml
  devices.yaml
  consents.yaml
```

`account.yaml` and `devices.yaml` are unchanged. `trees.yaml` becomes
`consents.yaml`: rules keyed by resource TreeID, as now, with no `canonical`,
and every rule must carry `via`. A rule without `via` in a person's
configuration can only narrow access the person already has, so it did
nothing; what remains is consent for code to act with the person's access,
which is what Canopy's resource consent already writes
(`ResourceConsent.swift`). `who: me` keeps its meaning here: this account's
profile.

A consent applies whether or not the person administers the resource, so the
consent flow always writes `consents.yaml` and never a tree configuration.

## Examples

Profile TreeIDs are shortened. The community root is `tr_garden_root`,
canonical at `https://arb.nxhx.org/`.

### Joe's profile, `/~joe`

Mounted by the root from its `members` handle `joe`.

```yaml
# /~joe;arbor-config  tree.yaml
administrators:
  - profile: tr_joe
sponsor: tr_joe
```

```yaml
# access.yaml
- who: everyone
  allow: [read]
```

```yaml
# mounts.yaml
todos: tr_todos
notes: tr_notes
```

### Joe's private todos, shared with Alice, `/~joe/todos`

```yaml
# tree.yaml
administrators:
  - profile: tr_joe
```

```yaml
# access.yaml
- who: {profile: tr_alice}
  allow: [read, create-child]
```

Joe needs no rule: he administers it. `mounts.yaml` is `{}`.

### A tree Joe and Alice run together, `/~joe/trip`

```yaml
# tree.yaml
administrators:
  - profile: tr_joe
  - profile: tr_alice
```

```yaml
# access.yaml
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
# /~garden-club;arbor-config  tree.yaml
administrators:
  - profile: tr_garden_club       # the club's members administer its profile
```

Its plant records, administered by the club and mounted under it:

```yaml
# /~garden-club/plants;arbor-config  tree.yaml
administrators:
  - profile: tr_garden_club
```

```yaml
# access.yaml
- who: everyone
  allow: [read]
```

Adding someone to the club's `members` makes them an administrator of both.
The club cannot remove its last member while it administers these trees.

### The community root, `/`

```yaml
# /;arbor-config  tree.yaml
administrators:
  - profile: tr_garden_root       # the root is the community group profile
```

```yaml
# access.yaml
- who: everyone
  allow: [read]
```

```yaml
# mounts.yaml
~garden-club: tr_garden_club
```

The community's members administer the community, which is canopyd's policy
today, now with no `access` table or unowned-tree case behind it.

### Code with a sponsor

Joe's supplies app reads a private data tree and publishes part of it:

```yaml
# /~joe/supplies;arbor-config  tree.yaml
administrators:
  - profile: tr_joe
sponsor: tr_joe
```

```yaml
# /~joe/supplies-data;arbor-config  access.yaml
- who: everyone
  via: tr_supplies
  allow: [read]
  within: /published
```

Anyone may read `/published` of the data tree, but only through the supplies
app. This rule is the data tree owner's grant, so it lives in the tree
configuration.

### `consents.yaml`

Joe lets the supplies app use his own access, as Canopy's consent sheet writes
it:

```yaml
# Joe's account configuration  consents.yaml
tr_alice_pantry:                 # Alice's tree; Joe has write there
  - who: me
    via: tr_supplies
    allow: [read, create-child]
    within: /inventory
tr_todos:                        # Joe's own tree
  - who: me
    via: tr_planner
    allow: [read]
```

Joe sponsors a public page that shows part of a tree he may read but does not
own, to anonymous visitors, only through that page's code:

```yaml
tr_club_calendar:
  - who: everyone
    via: tr_joe_homepage
    allow: [read]
    within: /events
```

Each consent can only narrow what Joe's account already holds, and lapses if
he loses that access.

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
- **A directory of three files, not one file.** A tree root is always a directory, and one file per concern mirrors the account
  configuration and keeps each file's merge key simple.
- **The address belongs to the parent.** See `mounts.yaml`.
- **The cost is one-time.** The 2026-09-25 backup has three hosted trees and
  one account. Each gains a configuration of a few hundred bytes.
  Authorization reads derived indexes, not the trees, and clients fetch a
  configuration only when the sharing panel opens, so nothing more is watched.

## Open questions

1. **Recovering a tree with no reachable administrator.** The invariants stop
   an empty list and an empty administering group, but not administrators
   whose accounts are disabled or whose devices are all lost. A host-operator
   CLI command is the likely answer; it ties to the catalog's
   [recovery and administrator reset](../catalog.md#product-completion).
2. **Two meanings of "administrator".** A device's `administrator` flag and a
   profile in `administrators` are two layers of one idea. Keep both names, or
   rename one?
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
- [Accounts](../../docs/overstory-spec/04-accounts-and-devices.md): §2 and §3
  for `consents.yaml`; a new section for the tree configuration graph, its
  files, policy, invariants and merge; §6 rewritten as declare, activate,
  mount; §7 for both policies.
- [Access control](../../docs/overstory-spec/05-access-control.md) §1: define
  administrators, drop "hosted resource owners", `me` only in consents,
  `sponsor`.
- [Locators](../../docs/overstory-spec/03-locators.md) §3 and §5: the
  `arbor-config` parameter, mounts as the source of canonical boundaries.
- [Conformance](../../docs/overstory-spec/conformance/README.md): graph,
  validation and merge vectors for both configurations.
- **Gate:** `bun run check:links`, the walk-through below.

### Phase 2: parsers and merge

- Protocol package (TypeScript) and Overstory package (Swift): parse,
  validate and merge the tree configuration graph and `consents.yaml`; remove
  the hosting half of the account graph.
- **Gate:** both suites pass phase 1's vectors.

### Phase 3: canopyd

- `tree-config-v1` policy: authorization through administrator profiles and
  groups, `sponsor` rule, mounts applied as boundary rewrites, invariants
  including the group-member rule on profile updates.
- Derived state keyed by tree: rules and administrators per tree, consents per
  account. Delete `trees.account_id`, adoption, the `access` table, the
  declared-path rules and the account graph's hosting path.
- Declaration through the tree configuration; `;arbor-config` resolution.
- Migration 022 (schema 22), rehearsed on a fresh backup.
- Update [canopyd's README](../../docs/architecture/canopyd/README.md#accounts-and-canonical-paths)
  here, when its policy changes.
- **Gate:** canopyd suite, `test:protocol`, a rehearsal report.

### Phase 4: clients

- CLI tree declaration and mounting.
- Mac and iPhone: account bootstrap, the sharing panel reading and editing the
  tree configuration, resource consent writing `consents.yaml`
  (`AccountConfigurationYAML.swift`, `ResourceConsent.swift`,
  `Credentials.swift`).
- **Gate:** Swift suites and a local end-to-end against a phase 3 canopyd.

### Phase 5: cutover (needs Joe's go-ahead)

- Back up, deploy, run migration 022, install the Mac and iPhone builds.
- Record the result in `status.md` and delete this plan.

### Migration 022

For each hosted tree, one tree configuration:

| Tree | `tree.yaml` | `access.yaml` | `mounts.yaml` |
|---|---|---|---|
| `/` | administrators: the root itself | from the `access` table, minus rules the members now hold as administrators | top-level names other than handles |
| an owned tree | administrators and sponsor: the owner's profile | the owner's `trees.yaml` rules, minus rules naming only the owner | its current nested boundaries |

Each account's `trees.yaml` becomes `consents.yaml` with its `via` rules; the
migration refuses to run while any rule would be dropped other than those
covered by administration. Drop `trees.account_id` and `access`. As migration
019 did, the report lists each tree's whole-tree access before and after and
must show no difference.

## Verification

Before phase 1's spec edits: a written walk-through of the design against the
examples above plus the failures: removing the last administrator, emptying an
administering group, a co-administrator setting someone else as sponsor, and
mounting a tree you do not administer. After each phase, its gate. At
cutover, the migration report and a check that `/`, `/~joe` and `/~joe/todos`
read and write as before.
