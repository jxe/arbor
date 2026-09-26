# Tree configurations: decisions and failure cases

Every hosted tree is configured in its own private configuration tree
([accounts §2–§7](../../overstory-spec/04-accounts-and-devices.md#2-tree-configuration-graph),
[access control §1](../../overstory-spec/05-access-control.md#1-subjects-and-rules)).
This page keeps why it has that shape and which tests show each failure is
refused. It was canopyd 005, cut over live on 2026-09-26 by
[migration 022](../../../packages/canopyd/migrations/022-tree-configurations/README.md).

## Decided

- **A separate tree, not a file inside the tree.** Objects are shared across a
  host, and any reader of any tree may fetch an object whose hash they know
  ([tree operations](../../overstory-spec/01-tree-operations.md), object reads).
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
  [Security 007](../../../plans/security/007-placement-hosts.md) lets a profile place
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

## Answers to the open questions

1. **Recovering a tree with no reachable administrator.** The host operator's
   reset stays the answer here: `ARBOR_RESET_ACCOUNT` (with
   `ARBOR_ACCOUNT_TOKEN`) now rewrites the person's `devices.yaml` to one new
   administrator device and revokes the rest, as an accepted configuration
   update. A tree whose administrators are all unreachable is recovered by
   recovering one of them. Profile-key recovery stays with
   [Security 006](../../../plans/security/006-device-keys.md).
2. **Two meanings of "administrator".** Keep both names: a profile's `admin`
   on a tree, a device's `administrator` flag in `devices.yaml`. The spec
   introduces them together as the two authority bits
   ([accounts §1](../../overstory-spec/04-accounts-and-devices.md#1-profiles-and-host-accounts)).
3. **The derived TreeID's form.** `tr_` + unpadded lowercase base32 of
   `SHA-256("arbor-tree-config-v1\0" || TreeID)`, the same form as a person
   profile TreeID. The prefix does not show that it is a configuration, so a
   configuration TreeID reveals nothing to someone who does not know the tree
   ([accounts §2.1](../../overstory-spec/04-accounts-and-devices.md#21-finding-it);
   vectors in `tree-configuration.json`).
4. **How declaring is addressed.** An update with base `null` to
   `/.arbor/trees/{TreeID};arbor-config/updates`: the route names the tree, so
   the request body is an ordinary `UpdateRequest`
   ([accounts §6](../../overstory-spec/04-accounts-and-devices.md#6-declaring-activating-and-mounting-a-tree)).

## Moved up from Security 006–008

- **A host-independent derived configuration TreeID** (answer 3), so a
  placement host in Security 007 finds a tree's configuration without a
  pointer from the home host.
- **Accounts keyed by profile TreeID** (`accounts.id` is the profile), which
  is the identity Security 007's placement accounts reuse.
- **Host-operator device reset** as an accepted `devices.yaml` update
  (answer 1), which Security 006's profile-key reset will share.

Device keys, signatures and cross-host lending stay in their plans; none of
them is needed for one host.

## Walk-through of the failures

Against the examples in the spec and the implementation, each with the test
that shows it:

- **Removing the last administrator.** An `access.yaml` without an `admin`
  rule fails validation, and a merge that would produce one is a
  `tree-configuration` conflict (`tests/integration/canopyd/community-hosting.test.ts`,
  "an edit cannot remove the last administrator").
- **Emptying an administering group.** The garden club administers its plants
  tree; an update to the club's profile with no members is refused ("keep at
  least one member", same file). The community root administers itself, so
  the same check keeps its last member.
- **Alice trying to lend Joe's access.** Alice cannot edit Joe's `apps.yaml`
  (only administrator devices of an administering person may edit a
  configuration), and an entry in her own `apps.yaml` for Joe's tree covers
  nothing: no rule on Joe's tree names her
  (`tests/unit/canopyd/tree-access.test.ts`, "Alice cannot lend Joe's access").
- **Joe lending access granted only to his club.** His `who: everyone` entry
  is refused because the calendar's rule names the club, not Joe; the club's
  own entry lends it, and Joe's `who: me` entry still lets him use it himself
  (same file, two tests).
- **A co-administrator added to a person profile.** Invalid: a person's
  configuration grants `admin` to that person alone
  (`tests/unit/canopyd/tree-config-policy.test.ts`).
- **Two named lenders, one losing access.** Two grants; revoking one lender's
  underlying rule lapses only that grant (`tree-access.test.ts`, "two lenders
  are two grants").
- **A non-administrator device editing another device.** Refused; an
  ordinary device may change only its own label
  (`tree-config-policy.test.ts`).
- **Revoking the last administrator device.** Invalid
  (`tree-config-policy.test.ts`).
- **Mounting a tree you do not administer.** Refused; renaming or removing a
  mount needs only the parent's administrators
  (`community-hosting.test.ts`, and `cli-sync.test.ts` for renames).
