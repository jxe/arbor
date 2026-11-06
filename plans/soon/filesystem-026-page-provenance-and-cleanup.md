# Filesystem 026: page provenance, and dropping Markdown file entries

**Why and when:** pages are logical nodes, written to disk by each placement: a tree holds a
page's properties and exact body, and each placement writes its own front matter (Joe made it
a plan on 2026-10-28 and accepted that formatting stops traveling between devices). That is
built, released and converted on Joe's todos tree
([status](../../status.md#pages-as-logical-nodes-built--2026-10-28)); the rules are in
[spec 01](../../docs/overstory-spec/01-tree-operations.md#pages) and
[spec 02 §3](../../docs/overstory-spec/02-directory-format.md#3-properties-markdown-content-and-identity).
This is the cleanup it left. Soon, after the other trees are converted (a go-ahead in
[Joe's to-do](../joe.md#go-aheads)).

## Status

- **Effort:** M.
- **Risk:** MEDIUM. Dropping the `.md` file-entry path is safe only once no tree a host serves
  still holds Markdown as files.
- **Depends on:** every tree on the live host converted.

## Cleanup

1. **Provenance for page bodies.** The provenance index (Performance 004) and line provenance
   ([overstoryd 006](../later/history-006-line-provenance.md)) index page bodies, not only
   file bytes. Until then a copy out of a page's body goes as a snapshot.
2. **Front-matter merge cases.** Close the overstoryd 014/015 front-matter cases that per-property
   merge now covers (the "Per-key frontmatter conflicts" candidate moved here).
3. **Drop the code that writes `.md` file entries,** once every tree is converted.

Known simplification to revisit while here: page lists merge member by member as ordered
lists.
