# The browser
*Part of the [Arbor spec](../spec.md): the human surface — navigation, rendering, editing, and agent pages.*

The browser is a view *and editing surface* over arbord, not an independent network client. The browser is **TreeHopper**, in two faces: **TreeHopper web** — the dev server's view, the first to ship, editing from the start — and **TreeHopper native**, the Swift app ([treehopper-integration.md](../treehopper-integration.md)). A human in either and an agent using the local API see the same workspace and live changes.

## 1. Navigation and system state

The home view renders `system:mounts` as subpage-like rows without storing control records in the publishable home page. Cmd+P accepts workspace paths, mounted public names, `TreeID`s/invitations, and full-text search. Provenance indicates local, mounted rw/ro, overlay-active, visited, pinned, or stale.

Every page has a source view. Search runs locally over the materialized workspace. Sharing a folder and accepting an invitation are system operations that create shared trees, grants, credentials, and mounts; TreeHopper supplies their human UI.

## 2. Rendering and editing

View resolution precedence is strict:

1. reader override on the mount;
2. node's declared `view:`;
3. nearest ancestor `_view.tsx`;
4. built-in defaults.

Built-ins must be genuinely good: article for Markdown, outline for directories, and schema-derived table/board/gallery/calendar views for collections. Custom presentation belongs in a script. A paragraph containing only a `.tsx` link renders its component as an island backed by arbord's render route.

Built-in views are editable wherever the underlying node is writable. The article view for Markdown is a block editor whose write-back target is the file itself: the file stays canonical, frontmatter is preserved unless edited, and untouched blocks round-trip without churn — every edit remains a clean diff for git and agents. The directory outline is the same editor over the directory's own page: children appear as blocks that can be reordered, grouped under inserted headings, and annotated with surrounding prose, and the first such structural edit materializes the directory's `_index.md`. Children not mentioned in `_index.md` still render, appended after the authored body.

## 3. Beyond mounted trees

Opening an unmounted public name or invitation creates a transient mount recorded in `system:visited`; bodies arrive lazily by Merkle walk. Annotating—or beginning an edit under the reader's auto-overlay policy—creates an overlay. “Add to workspace” promotes the mount. Back/forward uses recorded revisions; changed-since-read becomes a visible state rather than silent replacement.

If a public domain has no Arbor record, TreeHopper may offer plain `https://` as the legacy-web hatch; a legacy page that advertises a tree via `<link rel="arbor">` or an `Arbor-Tree:` header ([wire.md](wire.md) §7) offers the reverse upgrade into the live tree. If an endpoint is unavailable, cached content renders with explicit staleness.

## 4. Agent pages

An agent is a markdown file: prompt as body, frontmatter carrying the model, `tools:` as references to mutations, and `context:` as references to queries. Opening one in the browser shows its prompt and frontmatter — editable like any page — alongside a chat interface backed by arbord. Tool calls render inline with the same computed consent sentences as any component, and their effects land in the tree like any mutation, so a chat can be watched changing the pages it touches. Prompt edits are ordinary edits with ordinary revisions, and transcripts are themselves ordinary tree content.
