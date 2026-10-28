# Pages that present other collections

**Touches:** spec 11 (views), 02 (how a page carries one), 06 §6 (relative collection
resolution), 05 (authorization against the source tree).

**The extension.** A page carrying `view "My games" of ../Games/Game { group: status }` shows
that view of a collection kept elsewhere, with the page's own override of its arrangement, and
edits made there go back to the source collection's tree.

**Open.**
- How a Markdown page carries the view: a fenced block, or front matter.
- Embedding: the view (and later Story's structured editor) as one opaque block in a Quagmire
  page that hosts a host-supplied view.
- Public and web views stay out of scope until Joe wants them.

**Settled.** USL already parses `view "…" of path` (`ViewDecl`, `packages/usl/src/ast.ts`); the
checker drops it and no spec says what it means. An arrangement lives on a collection (its
schema's `~views`) and on pages that present it; views in a schema are defaults a page may
override (Joe, 2026-10-13). Formerly milestone 2 of Schema language 002, moved here on
2026-10-28.
