# Filesystem 026: pages as logical nodes, written to disk by each placement

**Why and when:** logical collections already split what a tree holds from how a placement
writes it ([spec 06](../../docs/overstory-spec/06-child-backings.md)): the tree holds rows,
and each placement chooses its files. Joe, 2026-10-15: doing the same for pages is "probably a
good idea eventually"; on 2026-10-28 he accepted the cost below and made it a plan, in soon.
It was an item in [candidates](../candidates.md).

## Status

- **Effort:** L.
- **Risk:** HIGH. It changes spec 02's round trip and how merge and access see front matter.
- **State:** spec written (2026-10-28), nothing built. The spec leads the code: until step 1
  lands, both stacks and the vectors still name the row operations `rowSet`, `rowConnect`,
  `rowDisconnect` and `rowMove`, and until step 3 every `.md` is still a file entry.

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

## Spec (written 2026-10-28)

- [spec 01](../../docs/overstory-spec/01-tree-operations.md#pages): the `page` entry kind and
  `ProtocolPage` (`id`, ordered `properties`, exact `body`), YAML 1.2 values with CBOR tags
  1004 and 0 for timestamps, object hash = model hash, and `property` decisions.
- [spec 02 §3](../../docs/overstory-spec/02-directory-format.md#3-properties-markdown-content-and-identity):
  `.md` and `.mdx` are pages (Joe: `.mdx` is a page); unparseable front matter stays a file
  with `unparsed-front-matter`; tolerant read, minimal write, canonical form; converting a
  tree is one update the host checks by model hash.
- [spec 10 §4.1 and §7.1](../../docs/overstory-spec/10-source-intent.md#41-property-operations):
  no `pageSet`. `set`, `connect`, `disconnect` and `move` take a row or page target (Joe:
  rows weren't wrong, a row just has no entry of its own); `page-properties-v1` uses the
  same per-property rules as `collection-fields-v1`.
- [spec 05 §1](../../docs/overstory-spec/05-access-control.md#1-subjects-and-rules): a property
  operation on a page is `update-properties`, a body edit `update-content`.
- The owner's Story Sync converts each tree, the first time it runs on the release that
  reads pages (Joe).

## Steps

1. **Rename the row operations** to `set`, `connect`, `disconnect` and `move` with a
   `target`, in TypeScript, Swift and the vectors. Rows only; no behavior change.
2. **The page object** in both stacks: canonical encoding with the timestamp tags, YAML 1.2
   parse to a page, canonical write, minimal write that splices changed keys into existing
   front matter, and a shared vector file with the TypeScript and Swift results.
3. **Read page entries everywhere:** overstoryd, Story Sync, Story (Mac and iPhone) and the
   CLI materialize pages and read edited files back as property and body changes. Nothing
   writes page entries yet. Ship this as a release.
4. **Write pages:** property operations on page targets, `page-properties-v1`, `property`
   decisions in Story's conflict UI, the access check, and editors (Story, Quagmire's
   front-matter split) reading `properties` and `body` from the page.
5. **Convert:** the host advertises `pages-v1` and checks conversion updates by model hash;
   the owner's Story Sync converts each tree once. Check one tree of Joe's by hand first.
6. **Clean up:** provenance (Performance 004, History 006) indexes page bodies; close the
   overstoryd 014/015 front-matter merge cases (the "Per-key frontmatter conflicts"
   candidate moved here, since step 4 does it); drop the code that writes `.md` file entries.
