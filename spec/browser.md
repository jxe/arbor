# The browser
*Part of the [Arbor spec](../spec.md): the human surface — navigation, rendering, editing, and agent pages.*

The browser is a view *and editing surface* over arbord, not an independent network client. The browser is **TreeHopper**, in two faces: **TreeHopper web** — the dev server's view, the first to ship, editing from the start — and **TreeHopper native**, the Swift app ([treehopper-integration.md](../treehopper-integration.md)). A human in either and an agent using the local API see the same workspace and live changes.

## 1. Navigation and system state

The home view renders `system:mounts` as subpage-like rows without storing control records in the publishable home page. Cmd+P accepts workspace paths, mounted public names, `TreeID`s/invitations, and full-text search. Provenance indicates local, mounted rw/ro, overlay-active, visited, pinned, or stale.

The sidebar is contextual: on a page it lists that page's containing directory; on a directory page it lists that directory's children. It therefore remains useful while reading or editing a file instead of disappearing into a page-only state. It is visible by default on desktop, collapsible through the header or Cmd-\, remembers that desktop preference locally, and becomes an initially closed overlay drawer on narrow screens. A parent action moves the context up one directory and is shown only while still below the root passed to `arbor dev`; navigation can never escape that root. Markdown labels, breadcrumbs, search results, and routes use logical extensionless names, so sibling `x.md`, directory `x/`, and fallback `x/_index.md` all contribute to the single browser location `/x`.

Every page has a source view. Search runs locally over the materialized workspace. Sharing a folder and accepting an invitation are system operations that create shared trees, grants, credentials, and mounts; TreeHopper supplies their human UI.

## 2. Rendering and editing

View resolution precedence is strict:

1. reader override on the mount;
2. node's declared `view:`;
3. nearest ancestor `_view.tsx`;
4. built-in defaults.

Built-ins must be genuinely good: article for Markdown, outline for directories, and schema-derived tables for collections in phases 1–2 (board/gallery/calendar remain later built-ins). Custom presentation belongs in a script. A paragraph containing only a `.tsx` link renders its component as an island backed by arbord's render route.

Built-in views are editable wherever the underlying node is writable. The article view for Markdown is a block editor whose write-back target is the file itself: the file stays canonical, frontmatter is preserved unless edited, and untouched blocks round-trip without churn — every edit remains a clean diff for git and agents. The directory outline is the same editor over the directory's own page: children appear as blocks that can be reordered, grouped under inserted headings, and annotated with surrounding prose. Structural edits update sibling `x.md` when present and otherwise materialize `x/_index.md`. Children not mentioned in the selected body still render, appended after the authored body.

Rendered body links are interactive. Relative and tree-rooted Arbor links navigate within TreeHopper, canonicalize legacy `.md` or `/_index.md` spellings, and preserve normal back/forward history; fragment-only links remain in-document, while explicit external schemes use the host browser. A standalone authored child-page block and an auto-generated directory-child block are real links with the same single-click behavior, not inert editor decorations. Giving a leaf page its first child creates a sibling directory and leaves its physical `x.md` body untouched, without changing the open route, history entry, durable ID, backlinks, sidebar identity, or editor revision model.

TreeHopper web uses BlockNote as its interaction layer, not its storage model. Arbor parses CommonMark/GFM into source-spanned blocks; unsupported constructs remain visible editable raw-Markdown blocks. Saving reuses the exact source for untouched blocks and rewrites only edited blocks. YAML properties are patched through a concrete-syntax tree so comments, order, quoting, and unrelated values survive.

Inline Markdown is converted through the active BlockNote editor for strong, emphasis, strikethrough, inline code, links, and hard breaks. Arbor compares BlockNote's inline structure with the originally parsed structure: an untouched block keeps its exact delimiter spelling and bytes, while an edited block is emitted in BlockNote's canonical Markdown form. Underline, colors, and alignment are absent from the authoring controls because they have no Markdown round trip. Copy exposes BlockNote's Markdown `text/plain` plus rich/internal HTML formats; paste accepts explicit or detected Markdown through BlockNote's default handler. The Arbor-specific `▸` toggle remains a storage notation: internal BlockNote copies preserve the toggle, while external Markdown represents it as an ordinary bullet.

The built-in editor is visually aligned with Hunch while retaining BlockNote's web interaction model: the bundled Inter face at 16px/24px body metrics, a centered 708px writing column with 20–48px responsive padding, a 40px first-H1 page title and 30/24/20px later headings, 24px nesting, and sibling-aware vertical rhythm. Light and dark colors follow the system. Properties begin collapsed, stable saved state does not occupy persistent chrome, and Undo, Redo, and Recover live in the page menu; pending, external, conflict, and failed states remain visible when action is useful. These are presentation rules and never synthesize a title or change Markdown.

Document and property edits autosave after a short debounce through a generation-aware compare-and-swap coordinator. The editor distinguishes pending, saving, saved, external, conflict, and failed states; structural filesystem mutations first drain the current document generation. Undo and redo use authored edit checkpoints and reversible filesystem mutations, while failed mutations do not consume a history step. A page keeps one BlockNote editor instance across saves and external observations. Clean server revisions are reconciled through a non-history BlockNote transaction rather than reconstructing the editor; editor normalization is not an authored generation.

Immediate physical children render as managed child-page rows inside the ordinary BlockNote body through a custom BlockNote block spec. Their native BlockNote drag handle retains its menu but exposes filesystem Rename and Move to Trash actions. The same handle moves one row, or the visibly selected rows as an ordered batch, using BlockNote's drop-target feedback; a drop between prose blocks rewrites the directory body without regrouping its other children. Anchored placement includes the directory-body byte revision, and a stale revision or vanished block/path anchor rejects the batch rather than appending somewhere else. Page-level creation and rename actions live in a compact More menu, and the contextual sidebar exposes New Page, New Folder, Rename, and Move to Trash. Finder drops copy files and recursively enumerated folders into the selected directory without touching their originals.

Arbor additionally recognizes Clamshell toggle lists. A line `▸ Title` starts a toggle; blank lines and following lines indented at least two additional spaces are its children, recursively. The first nonblank line at-or-above its indentation ends it, and fenced code is opaque during that scan. A toggle may contain any normal block, including another toggle. BlockNote exposes it through its toggle block, slash menu, and `▸ ` typing conversion. Expand/collapse state is session-local, defaults collapsed on reopen, and never changes the Markdown file. This is deliberately an Arbor extension—CommonMark and GFM have no disclosure-list block—and standards-based `<details>/<summary>` HTML remains a raw-Markdown block rather than being converted.

CSV, JSONL, and Postgres tables are read-only in phase 2. Markdown collections use the same table, but schema properties are editable inline and opening a row reveals the ordinary props panel plus BlockNote body editor. Row validation failures stay local to the affected row and never crash the collection.

## 3. Beyond mounted trees

Opening an unmounted public name or invitation creates a transient mount recorded in `system:visited`; bodies arrive lazily by Merkle walk. Annotating—or beginning an edit under the reader's auto-overlay policy—creates an overlay. “Add to workspace” promotes the mount. Back/forward uses recorded revisions; changed-since-read becomes a visible state rather than silent replacement.

If a public domain has no Arbor record, TreeHopper may offer plain `https://` as the legacy-web hatch; a legacy page that advertises a tree via `<link rel="arbor">` or an `Arbor-Tree:` header ([wire.md](wire.md) §7) offers the reverse upgrade into the live tree. If an endpoint is unavailable, cached content renders with explicit staleness.

## 4. Agent pages

An agent is a markdown file: prompt as body, frontmatter carrying the model, `tools:` as references to mutations, and `context:` as references to queries. Opening one in the browser shows its prompt and frontmatter — editable like any page — alongside a chat interface backed by arbord. Tool calls render inline with the same computed consent sentences as any component, and their effects land in the tree like any mutation, so a chat can be watched changing the pages it touches. Prompt edits are ordinary edits with ordinary revisions, and transcripts are themselves ordinary tree content.
