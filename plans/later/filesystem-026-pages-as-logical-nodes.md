# Filesystem 026: pages as logical nodes, written to disk by each placement

**Why and when:** logical collections already split what a tree holds from how a placement
writes it ([spec 06](../../docs/overstory-spec/06-child-backings.md)): the tree holds rows,
and each placement chooses its files. Joe, 2026-10-15: doing the same for pages is "probably a
good idea eventually"; on 2026-10-28 he accepted the cost below and made it a plan in later.
It was an item in [ideas](../ideas.md).

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
  text merge of the front matter, and Schema language 002's `who: {property: authors}`).

## Before starting

Settle with Joe how existing trees convert (their front matter as written becomes the
properties), and what a page's property types are when no schema declares them.
