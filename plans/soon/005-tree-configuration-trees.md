# canopyd 005: Configure each hosted tree in its own configuration tree

Historical identifier: **Security 005** (moved to canopyd 2026-09-24; not the
earlier Security 005 that became Filesystem 005).

## Status

- **Priority:** P3
- **Effort:** L
- **Risk:** HIGH. It changes who may change a tree's access, the account
  configuration graph that every client edits, and the host's authorization
  model, and it needs a live migration.
- **State:** PROPOSED, not decided. Joe is not yet sold on it. Nothing here
  changes the spec until the open questions below are answered.
- **Depends on:** [migration 019](../../packages/canopyd/migrations/019-one-access-store/README.md)
  (one access store). It does not block 019, and 019 does not commit to it.

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
  That set is plural by nature, so the root either stays in the `access`
  table, the last tree governed outside any configuration, or is adopted by
  one person's `trees.yaml`.
- **The account configuration mixes two things.** Devices and the policy-only
  entries by which a person attenuates access they hold (for example, for
  code acting for them through `via`) belong to the person. A tree's address
  and ACL belong to the tree.

## The proposal

Each hosted tree gets its own private configuration tree, edited only by that
tree's administrators. The account configuration keeps what belongs to the
person.

- **Tree configuration tree.** A private, noncanonical, governed tree with a
  closed server policy of its own (like `account-config-v2`, not a plugin
  mechanism). A sketch of its one file:

  ```yaml
  # tree.yaml
  canonical: "https://canopy-a.example/~joe/notes"
  administrators:
    - profile: tr_joe_profile
    - profile: tr_garden_club      # a group: its members administer
  access:
    - who: everyone
      allow: [read]
  ```

  `access` is today's resource-rule grammar, unchanged. `administrators` names
  person or group profiles.
- **Administering.** An update to a tree configuration is authorized when the
  submitting device belongs to an account whose profile is an administrator,
  directly or through a group's `members`. This is the membership check access
  rules already use. Which of that account's devices may do it (administrator
  devices only, or any) is an open question.
- **The account configuration.** `devices.yaml` and `account.yaml` stay.
  `trees.yaml` keeps only policy-only entries (no `canonical`). Hosting moves
  to the tree configuration.
- **The community root.** Its configuration names the community group profile
  as its administrator, so the community's `members` decide who administers
  it. The `access` table and every special case for unowned trees disappear.
- **Ownership becomes explicit.** "Owner" means "the administrators named in
  the tree's configuration". It is recorded, visible to administrators and
  single-valued even when plural (one list, one ACL). `trees.account_id` and
  schema 20's adoption rule go away.

### Decided

**A separate tree, not a file inside the tree.** A reserved file in the tree
itself would have history and travel with the tree for free, but everyone who
can read the tree could read its ACL (who was granted access, link-rule
digests), and the host would have to protect one path from the tree's own
writers. A separate private tree has neither problem.

## Alternatives considered

- **Keep account configuration; let a group own a tree.** Smaller: ownership
  stays one hosting entry, but the owner may be a group profile. It still
  needs a home for the group's entry, since a group has no configuration
  tree, which leads back to this proposal.
- **An `administer` grant in the owner's rules.** Keeps one owner and lets them
  name co-administrators, but a co-administrator would then edit someone
  else's account configuration, contradicting "only your own devices edit your
  configuration".
- **Do nothing beyond schema 20.** One owner per tree, recorded in
  `trees.account_id`. Co-ownership and group ownership remain unsupported, and
  the community root keeps its special case.

## Open questions

1. **Is the cost worth it?** Every hosted tree gains a second tree: more
   objects, more watches, and more trees clients must place or fetch. Is
   co-administration or group administration needed soon enough to pay for
   that, or is schema 20's single owner enough for now?
2. **How is a tree's configuration found?** Options: a field in the tree's
   descriptor naming its configuration TreeID, a TreeID derived from the
   tree's, or an index in each administrator's account configuration.
3. **Who may create one?** Declaring a new tree today means adding an entry to
   your own `trees.yaml`
   ([accounts §6](../../docs/overstory-spec/04-accounts-and-devices.md#6-declaring-and-activating-a-tree)).
   Under this plan the first administrator creates the tree configuration, and
   the host must still reserve the TreeID and path before activation.
4. **Who controls the address?** A path such as `/~joe/notes` is in Joe's
   namespace; `/~garden-club/…` would be the group's; top-level names are the
   community's. Should the tree configuration request an address that the
   namespace's controller then allows, rather than the address belonging to
   the tree alone?
5. **Losing the last administrator.** What stops a configuration from removing
   every administrator, or a group from emptying its members? What recovers a
   tree whose administrators are all gone? This ties to the catalog's
   [recovery and administrator reset](../catalog.md#product-completion)
   question.
6. **Concurrent edits.** Account configuration keeps the restrictive result of
   concurrent policy edits pending an explicit resolution
   ([access control §4](../../docs/overstory-spec/05-access-control.md#4-reading-access)).
   Is the same merge right for `administrators`, where a concurrent removal and
   addition may interleave?
7. **What administrators see.** Should every administrator see every rule,
   including other administrators' link subjects?
8. **Placement.** Do clients place tree configuration trees locally, as they
   place account configuration, or only fetch them when the sharing panel
   opens?

## Work, if adopted

1. Answer the open questions, and record the answers in this plan.
2. Spec: rewrite [accounts §2, §3, §6 and §7](../../docs/overstory-spec/04-accounts-and-devices.md)
   for the tree configuration graph, its policy and activation; define owners
   and administrators in [access control §1 and §4](../../docs/overstory-spec/05-access-control.md);
   add conformance vectors.
3. Protocol package (TypeScript) and Overstory package (Swift): parse, validate
   and merge the tree configuration graph; shrink the account graph to
   policy-only entries.
4. canopyd: the new policy, authorization of configuration updates through
   administrator profiles and groups, and `resource_policy` indexed from tree
   configurations. Delete `trees.account_id` inference, adoption, the
   `access` table and the account graph's hosting path.
5. Clients: account bootstrap, the Mac and iPhone sharing panel and resource
   consent (`AccountConfigurationYAML.swift`, `ResourceConsent.swift`,
   `Credentials.swift`), and the CLI's tree declaration.
6. Migration: create one tree configuration per hosted tree from its owner's
   `trees.yaml` entry (administrators: the owner's profile; the community root:
   the community group), remove hosting entries from account configurations,
   and drop `trees.account_id` and `access`.

## Verification

Before the spec changes: a written walk-through of the open questions' answers
against three cases (a person's private tree, a tree two people administer, and
the community root). After implementation: the conformance vectors, the
canopyd, protocol and Swift suites, and a rehearsed migration whose report
shows each tree's whole-tree access unchanged, as migration 019's
`accessDifferences` does.
