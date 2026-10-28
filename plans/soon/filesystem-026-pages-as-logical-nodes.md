# Filesystem 026: pages as logical nodes, written to disk by each placement

**Why and when:** logical collections already split what a tree holds from how a placement
writes it ([spec 06](../../docs/overstory-spec/06-child-backings.md)): the tree holds rows,
and each placement chooses its files. Joe, 2026-10-15: doing the same for pages is "probably a
good idea eventually"; on 2026-10-28 he accepted the cost below and made it a plan, in soon.
It was an item in [candidates](../candidates.md).

## Status

- **Effort:** L.
- **Risk:** HIGH. It changes spec 02's round trip and how merge and access see front matter.
- **State:** TODO, not designed.

## The idea

- The logical page is its properties plus its content; the body bytes stay exact.
- Front matter's formatting (key order, quoting, comments) stops traveling between devices:
  each placement writes its own. Joe accepted that on 2026-10-28.
- Spec 02's byte-exact front-matter round trip becomes per placement.
- Front-matter edits become property effects, which removes the representation-versus-model
  special cases in merge and access (for example a field merge per property instead of a
  text merge of the front matter, and Schema language 010's `who: {property: authors}`).

## Settled with Joe (2026-10-28)

1. **A page in the tree** is a page object: a property map plus the exact body bytes, a new
   object kind in spec 01 and 02, modeled on how collection rows are stored.
2. **Placements write front matter** in the order keys were added, with their own quoting;
   comments don't travel.
3. **Identity is both:** a page's `id` lives in the node, so moves and renames keep it, and
   placements write it as `id:` in the front matter so files keep carrying it.
4. **Merge and access** see properties: each property merges on its own (a conflict is per
   property), the body keeps its text merge, and access sees property effects.
5. **Other editors** change the file; Story Sync turns that into property and body changes,
   as it does for collection files.
6. **Storage is free, the hashed form is not** (Joe's point): the host, like any placement,
   may keep a page in any logically matching format. What every party must share is the one
   canonical encoding that roots are hashed over, since clients state roots and the host
   checks them.
7. **Property types are YAML's** (Joe): the YAML 1.2 core schema (strings, numbers,
   booleans, null, lists and maps) plus timestamps, encoded canonically. Pin 1.2 so `yes`
   and `no` stay strings, and give dates one canonical encoding, since parsers differ on
   them. Both stacks already parse YAML (`yaml` 2.9.1 in TS, Yams in Swift). USL types map
   onto them: Text, Int, Number, Bool, Date and lists of them; a nested map has no USL field
   type, so it stays an untyped property.
8. **Existing pages switch** in one ordinary accepted update per tree that re-encodes every
   page; history keeps the old bytes (Joe).

## Next

Write the spec changes (01 and 02: the page object, its canonical encoding, the placement's
written form) as a proposal for Joe, then split the work into steps.
