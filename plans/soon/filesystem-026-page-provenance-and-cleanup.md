# Filesystem 026: page provenance, and dropping Markdown file entries

**Why and when:** pages are logical nodes, written to disk by each placement: a tree holds a
page's properties and exact body, and each placement writes its own front matter (Joe made it
a plan on 2026-10-28 and accepted that formatting stops traveling between devices). That is
built, released and converted on Joe's todos tree
([status](../../status.md#pages-as-logical-nodes-built--2026-10-28)); the rules are in
[spec 01](../../docs/overstory-spec/1.1-data-model.md#51-pages) and
[spec 02 §9](../../docs/overstory-spec/1.1-data-model.md#9-properties-markdown-content-and-identity).
This is the cleanup it left. Soon, after the other trees are converted (a go-ahead in
[Joe's to-do](../joe.md#go-aheads)).

## Status

- **Effort:** M.
- **Risk:** MEDIUM. Dropping the `.md` file-entry path is safe only once no tree a host serves
  still holds Markdown as files.
- **Depends on:** every tree on the live host converted.

## Cleanup

1. **Provenance for page bodies.** The provenance index (Performance 004) and line provenance
   ([overstoryd 007](../later/history-007-page-history.md)) index page bodies, not only
   file bytes. Until then a copy out of a page's body goes as a snapshot.
2. **Front-matter merge cases.** Close the overstoryd 014/015 front-matter cases that per-property
   merge now covers (the "Per-key frontmatter conflicts" candidate moved here).
3. **Drop the code that writes `.md` file entries,** once every tree is converted.
4. **Drop the conversion machinery.** The spec already describes only converted trees (Joe,
   2026-11-10, spec review: "the spec is normative"): the descriptor's `pages` flag, the
   host's `pages-v1` health feature, and directory format §3's conversion rules were removed
   from it. Remove them from overstoryd (`acceptsPages`, `OVERSTORYD_PAGES`,
   `page-conversion.ts`, the `features` entry), Story Sync (`service.ts`,
   `filesystem-object-source.ts`) and Swift (`WorkingTree` conversion), with their tests,
   once no tree a host serves holds Markdown as files. Until then the host keeps sending
   `pages` and released clients keep reading it.

Known simplification to revisit while here: page lists merge member by member as ordered
lists.
