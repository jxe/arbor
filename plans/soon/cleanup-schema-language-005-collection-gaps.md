# Schema language 005: gaps left in collections that sync

**Why and when:** collections that sync landed on main on 2026-10-24
([status](../../status.md#collections-that-sync--2026-10-24)). Each milestone
left a few known differences from the plan as written. None blocks People 001.
Take each when something meets it, or when the host's collections are next
worked on.

## Status

- **Effort:** S each.
- **Risk:** LOW to MEDIUM; the guard (3) changes spec 01 and 07.

## The gaps

1. **Mixed frames.** A change whose trace mixes row frames with text frames
   (spec 10 §4.1 allows separate frames) is refused by the merge sidecar as
   unsupported. No client sends one yet; support it before one does.
2. **Host materializations never leave.** `HostCollections`
   (`packages/overstoryd/src/collections.ts`) builds one under
   `<dataRoot>/materialized/` on first use and keeps it. Add idle eviction under
   a disk budget, as the plan said; it rebuilds on next use.
3. **A mutation's guard is the whole tree.** A mutation is submitted with
   `ifCurrent` on the tree, so any unrelated accepted update forces a rerun (up
   to three). Scope the guard to the rows the handler read. This is a spec 01
   and 07 addition.
4. **A lost receipt refuses the retry.** If the host stops between accepting a
   mutation and writing its receipt, an exact retry is refused (its change
   identity is taken) instead of answered. Recover the receipt from the
   accepted update that carries that change identity.
5. **Smaller differences.** A query stream reads one collection; a query's
   `observedThrough` is the live broker's cursor rather than the materialization's
   applied ordinal; catch-up runs just after the commit rather than inside the
   tree lock (serialized per collection, readers catch up first). Change these
   only if a query needs it.

Owned elsewhere: skipping unchanged chunks when a large collection changes is
[Performance 004](../later/performance-004-provenance-index.md) step 6; Swift's
row-change kind and offline rows on native are
[Schema language 002](../later/schema-language-002-cranberries-in-story.md)'s
milestone 3a, and presented-view edits that still name layout tables are its
milestone 3.

## Close out

Record each fix in `status.md` as it lands, and delete this plan when the list
is empty or what remains has moved to the plan that needs it.
