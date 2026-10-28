# Schema language 010: row ownership

**Why and when:** a shared collection needs rows that only their authors edit: games by
their authors, Supplies' lists by their owner unless `openToEdits`, excellences' entries.
This was milestone 5 of Schema language 002; Joe moved it to later on 2026-10-28, beside
[Schema language 008](schema-language-008-port-excellences-and-supplies.md), the only plan
that needs it. Settled with Joe on 2026-10-15 in the project thread "Cranberries in Story".

## Status

- **Effort:** M.
- **Risk:** HIGH. Access rules that read row data, and device updates authorized by effect.
- **State:** TODO. USL 0.3.0 already dropped `@@editableBy`; cranberries takes owners as an
  option.

## Joe's decisions

- **Ownership** is access policy, not schema: it must also work on pages
  that aren't rows (front matter `authors`). `access.yaml` gains a property
  subject, `who: {property: authors}`, matching the profiles in that property
  of the node being changed, judged on its current accepted state. One
  predicate, `unless`/`when: {property: x}` (non-empty), covers "anyone may
  edit unowned rows" and Supplies' `openToEdits`; try it and revisit.
  `@@editableBy` left USL (0.3.0). No special rule for editing `schema.usl`.
- "Anyone signed in" is the host's community group; no new subject.

## Today and the work

Today:
- Access is whole-tree for device callers. `AccessControl.canWrite` checks at
  `/` (`packages/overstoryd/src/access.ts`), and narrow operations are
  consulted only for executions.
- `resource-effects.ts` sees file paths: a collection-file row edit is
  `update-content` of the whole file, and a front-matter edit is `write`.
- `ResourcePolicyContext` (`packages/protocol/src/model/resource-policy.ts`)
  has no node or state.

**Spec 05.**
- `who: {property: authors}` matches the profiles in that property of the node
  being changed: a row, or a page's front matter. For a new child, it's the
  parent's property. It's read from current accepted state at acceptance.
  Entries that aren't profile TreeIDs or locators match nobody, and a group
  counts through its members.
- `unless`/`when: {property: x}` (non-empty) is the one row predicate.
- "Anyone signed in" is `{profile: <community TreeID>}`. The community is the
  group profile at the host's canonical `/`, and `isGroupMember` already
  counts enabled accounts.
- **Guard:** changing a property that a rule's subject or predicate names
  requires that the caller currently matches that rule, or is an
  administrator. Without it, anyone who can write a row grants access by
  editing the field. Precedent: `tree-config-policy.ts`
  `authorizePersonConfigTransition` checks each field against the base.
- Where a schema exists, a rule naming a property that isn't `Person` or
  `Person[]` is a configuration diagnostic.

**Code.**
- Parsing and validation: `parseWho`/`parseResourceRule` (which refuse
  unknown keys) and the Swift `ProtocolResourceWho` and
  `ProtocolResourceAccessRule`.
- `ResourcePolicyContext` gets a `propertyProfiles(path, name)` callback over
  current state.
- Effects become semantic: row operations give exact `(row, field)` effects,
  and front-matter edits give property effects instead of `write`. Device
  updates are then authorized by effect, not only by whole-tree `canWrite`.
- No snapshot edits of fine-grained data (Joe, 2026-10-15). A snapshot that
  changes a schema-governed collection, or a SQLite database, is authorized
  only as `write` on that collection's path. A caller whose access there comes
  from a property rule, `unless`/`when`, or a narrower grant must send row
  operations. Clients turn edits made outside Story into row operations
  before publishing: story-sync's folder sync diffs the decoded rows locally
  instead of publishing `trace: null`. So the host never authorizes
  ownership from a row diff, and needs no tree-level mode switch.
- Conformance: `resource-policy.json` gains valid and invalid property rules.
- Readers can't read `access.yaml` (spec 05 §4), so Story learns locks from
  an advisory per-node answer: fill `NodeCapabilities.*.writable`
  (`protocol/src/model/node-model.ts:28`), which today only the local
  filesystem and app projections set, from the host's evaluation.
- Supplies' rule, `requireListEditor`
  (`examples/supplies/scripts/mutations.ts`: owner, or `openToEdits`),
  becomes two access rules: `{property: owner}`, and the community with
  `when: {property: openToEdits}`.
- `resource-policy.json` covers grammar only today. Add evaluation vectors
  (rule, caller, node properties → allowed) so both stacks agree.

**Done when:** in a shared games tree, an author edits only their own games,
anyone in the community edits unowned ones, and nobody but an owner or
administrator changes `authors`.

## Invariant

Data never grants access by itself: a property subject only matters through a rule an
administrator accepted.

## Open question

1. Is "property non-empty" the right size for `unless`/`when`? Revisit after
   Supplies and excellences use it.
