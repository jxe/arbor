# canopyd 018: Profile facts per tree

## Status

- **Priority:** P3
- **Effort:** S
- **Risk:** MEDIUM — a schema change and a live migration; authorization reads
  these facts
- **State:** PLANNED 2026-09-24.
- **Depends on:** nothing.

## Why

Authorization and the directory read a tree's profile facts (`type`, `members`,
card fields, avatar) from the database, never from objects. Today canopyd
computes them for every accepted root of every tree: `profileFacts` parses
the root's `_index.md` on each accepted update, and a community update parses
it three times (`validateProfileRoot`, `validateCommunityReservations`,
`profileFacts`). For a person or group profile root it then writes a
`meta` row keyed `profile:<root>` (`recordProfileFacts` in
`packages/canopyd/src/profile.ts`). Nothing deletes those rows, so `meta`
gains one row per historical profile root, which for the community is one per
edit of its `_index.md`.

A tree's type almost never changes, and its facts change only when its
`_index.md` or its avatar file changes. Every reader asks about a tree's head:
`rootProfile(this.community().ref)`, `isProfileMember(group.ref, …)`,
`rootProfileType(tree.ref)`, and `profileCard(tree.ref)` in `directory.ts`.

## Target result

- A `profile_facts` table, one row per tree whose head declares
  `type: person` or `type: group` (account profiles, groups and the
  community): `tree_id TEXT PRIMARY KEY REFERENCES trees(id)`,
  `index_hash TEXT NOT NULL`, `facts TEXT NOT NULL` (the current
  `RootProfileFacts` JSON). No other tree has a row.
- An accepted update recomputes facts only when its entry changes
  (`entryChanges`, already computed on every accept path) set or remove the
  root `_index.md`, or, for a tree with a row whose facts name an avatar,
  that avatar's path. Otherwise it reads and writes nothing for profile facts.
- When it does recompute, it parses `_index.md` once for the whole accept:
  validation (`validateProfileRoot`, `validateCommunityReservations`) and the
  stored facts share one result. It upserts the row when the new head declares
  a type and deletes it when the head no longer does.
- Readers key by tree: `rootProfile(tree)`, `isProfileMember(group, …)`,
  `rootProfileType(tree)`, `profileCard(tree)`. The directory's scan of every
  active tree for groups becomes one query joining `trees` to `profile_facts`.
  `profileCard` stops falling back to parsing a root that has no row: no row
  means no profile.
- The `profile:<root>` rows leave `meta`, which again holds only
  configuration keys.

## Work

1. **Schema 21.** Add `profile_facts` to `createCanopySchema` and
   `AUTHORITY_SCHEMA` in `schema.ts`; bump `CANOPY_SCHEMA_VERSION`; add the
   row to the [schema history](../../packages/canopyd/migrations/README.md#schema-history).
2. **Accept paths.** At the three accept sites in `canopy.ts` (the traced and
   merged accept, the snapshot accept and the internal entry) and the
   configuration and bootstrap inserts, decide from `EntryChanges` whether
   `_index.md` or the recorded avatar path changed; recompute and write only
   then, inside the accept transaction. `reconcileCommunityAccounts` runs only
   when the community's facts changed. Parse once per accept and pass the
   result to the validations.
3. **Readers.** Replace `storedProfileFacts(db, root)` and the
   `rootProfiles` cache keyed by root with reads by tree ID. Keep a small cache
   if measurement shows the per-tree lookup matters; invalidate it on write.
4. **Migration 020** (`packages/canopyd/migrations/020-profile-facts-per-tree/`,
   following the [procedure](../../packages/canopyd/migrations/README.md)):
   for every tree, compute the head's facts with this build's
   `rootProfileFacts`, insert a row when it declares a type, then delete every
   `meta` row whose key starts with `profile:`. Verify the rebuilt facts equal
   the old `profile:<head>` row for every head that had one. Rehearse on a
   backup, then run live with Joe's go-ahead.
5. **Tests.** An update that leaves `_index.md` alone parses nothing and
   writes no profile row; a change to `_index.md` or to the avatar file updates
   the row; a tree that drops `type:` loses its row; a tree that gains
   `type: group` becomes a group for authorization in the same accept; the
   community's accounts reconcile only when its members change.
6. **Docs.** Update the canopyd architecture README's account section where it
   describes how profile facts are stored, and record the migration in
   `status.md`. Delete this plan.

## Not in scope

The legacy scalar `/~handle` member form stays until its own live-data check
(see `status.md`, "Compatibility cutoff"); the rows carry it unchanged.
