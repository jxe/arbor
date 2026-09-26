# canopyd 005: Configure each hosted tree, profiles included, in its own configuration tree

Historical identifier: **Security 005** (moved to canopyd 2026-09-24; not the
earlier Security 005 that became Filesystem 005).

## Status

- **Priority:** P3
- **Effort:** L (remaining: the cutover)
- **Risk:** HIGH. The cutover migrates live data and replaces the account
  configuration every client edits and pairs devices through.
- **State:** PHASES 1–4 LANDED 2026-09-26 on
  `claude/laughing-faraday-b3cpc9`; phase 5, the cutover, needs Joe's
  go-ahead and is run together. The design is now the spec:
  [accounts §1–§3, §5–§7](../../docs/overstory-spec/04-accounts-and-devices.md#2-tree-configuration-graph)
  and [access control §1](../../docs/overstory-spec/05-access-control.md#1-subjects-and-rules).
  What landed and how it was verified is in [status](../../status.md).
- **Followed by:** [Security 006](../security/006-device-keys.md) (device keys
  and recovery), [Security 007](../security/007-placement-hosts.md) (placing
  trees on other hosts) and
  [Security 008](../security/008-portable-profiles.md) (portable profiles and
  cross-server delegation).
- **Builds on:** schema 21; [migration 022](../../packages/canopyd/migrations/022-tree-configurations/README.md)
  moves the data to schema 22.

## Remaining work

### Phase 5: cutover (needs Joe's go-ahead)

Follow the [migration 022 runbook](../../packages/canopyd/migrations/022-tree-configurations/README.md):

1. Take a fresh backup of the live data root and Joe's Mac data home.
2. Rehearse on copies: run the migration, read its report together (every
   tree's whole-tree access before and after, every lent capability), compare
   roots, serve the migrated copy and call `/.arbor/integrity` once.
3. Build and install the Mac app and CLI from this branch; build the iPhone
   app. The Swift changes have not been compiled here (no toolchain in the
   session), so the Swift suites and a local end-to-end come first: claim,
   pair a second device, revoke it, share a tree, approve an app.
4. Stop the Mac's Arbor Sync, deploy canopyd, migrate the live data root,
   rekey the Mac data home, start everything, and check that `/`, `/~joe`
   and `/~joe/todos` read and write as before from the Mac and the iPhone.
5. Record the result in `status.md` and delete this plan.

### Not yet done, and not needed for the cutover

- `;arbor-config` is answered on the route form
  (`/.arbor/trees/{TreeID};arbor-config`), which is all clients use. The spec's
  canonical-URL and `arbor://` spellings are not yet resolved by canopyd or
  the locator parser.
- Lender selection: canopyd checks each grant against its named lender, but
  nothing issues execution contexts in production until
  [Apps 005](../apps/005-source-resolution-and-sidecar.md); the fixed
  lender order (caller's own access, then lender TreeID) is for that issuer.
- Canopy's consent sheet does not yet offer approving an app for a group the
  person administers; `prepareAppConsent(group: true)` supports it.

## Answers to the open questions

1. **Recovering a tree with no reachable administrator.** The host operator's
   reset stays the answer here: `ARBOR_RESET_ACCOUNT` (with
   `ARBOR_ACCOUNT_TOKEN`) now rewrites the person's `devices.yaml` to one new
   administrator device and revokes the rest, as an accepted configuration
   update. A tree whose administrators are all unreachable is recovered by
   recovering one of them. Profile-key recovery stays with
   [Security 006](../security/006-device-keys.md).
2. **Two meanings of "administrator".** Keep both names: a profile's `admin`
   on a tree, a device's `administrator` flag in `devices.yaml`. The spec
   introduces them together as the two authority bits
   ([accounts §1](../../docs/overstory-spec/04-accounts-and-devices.md#1-profiles-and-host-accounts)).
3. **The derived TreeID's form.** `tr_` + unpadded lowercase base32 of
   `SHA-256("arbor-tree-config-v1\0" || TreeID)`, the same form as a person
   profile TreeID. The prefix does not show that it is a configuration, so a
   configuration TreeID reveals nothing to someone who does not know the tree
   ([accounts §2.1](../../docs/overstory-spec/04-accounts-and-devices.md#21-finding-it);
   vectors in `tree-configuration.json`).
4. **How declaring is addressed.** An update with base `null` to
   `/.arbor/trees/{TreeID};arbor-config/updates`: the route names the tree, so
   the request body is an ordinary `UpdateRequest`
   ([accounts §6](../../docs/overstory-spec/04-accounts-and-devices.md#6-declaring-activating-and-mounting-a-tree)).

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
  [Security 007](../security/007-placement-hosts.md) lets a profile place
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
