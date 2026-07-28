# The browser
*Part of the [Arbor spec](../spec.md): durable requirements for Arbor's human surface.*

TreeHopper is a view and editing surface over arbord, never an independent storage authority. Web and native versions may use different controls and platform conventions; they share the same workspace, resolved locators, effective access, mutations, receipts, and event stream. Detailed layout, typography, editor-library behavior, and milestone placeholders are implementation concerns rather than protocol requirements.

## 1. Browsing and editing

TreeHopper can browse ordinary local files, placed shared trees, transiently visited trees, historical revisions, and safe `system:` records. The path or [locator](locators.md) used to open it is a starting location, not a workspace boundary. Local filesystem content remains browsable and safely editable without acquiring durable Arbor identity.

A shared-tree boundary is visible with its canonical name, `TreeID`, placement, effective access, publication, current or selected revision, and sync/conflict/staleness state. Nested shared trees remain independent boundaries; an unavailable or private child is not exposed through its parent.

Built-in views cover Markdown, directories, collections, databases, and ordinary files. Writable views send authored changes through arbord's durable mutation surface. Read-only and historical views do not expose mutations. Source-preserving Markdown, projected directory documents, logical links, collections, and storage mappings follow [format.md](format.md); TreeHopper must not persist synthetic projection rows or normalize untouched source.

Navigation, search results, backlinks, history, Copy Link, and Open Location retain resolved identity when available. A historical locator stays pinned rather than silently advancing. External changes reconcile into an open clean view; conflicts preserve both sides and remain visible.

## 2. Trees, publication, and sharing

**Give this subtree a URL** creates a shared-tree boundary on the configured personal authority, previews matching HTTP and Arbor names, uploads the initial root, and begins private self-sync. The tree control exposes its canonical locators, raw TreeID fallback, current ref and sync state, local placement/access ceiling, and private/public-read/public-write publication.

Sharing operates on an already identified tree. The complete product lets an owner:

- invite a recipient to the whole tree or a subtree with chosen rights;
- create and copy an invitation;
- inspect current recipients and grants;
- adjust or revoke access;
- see nested boundaries whose authority does not inherit.

Invitation acceptance verifies the descriptor, explains the grant, stores credentials safely, and asks for a local placement and optional stricter read-only ceiling. A recipient can overlay local work on a read-only placement. Revocation prevents further remote access while preserving explicit cached and overlay work; restored access reconciles from the last verified revision.

Public-write requires an explicit warning that anyone can change current content. Publication and grants never expose credentials, private history, recovery state, old roots, or independently private nested trees.

## 3. Home, visits, and agents

Home reads `system:trees` and shows local placements plus owner-visible remote trees. A remote tree can be placed locally. Opening an unplaced locator creates a transient visited tree with lazy verified reads; **Add to workspace** gives it a durable placement. Historical visits are read-only pins.

An agent page remains ordinary tree content: its prompt and configuration are editable Markdown, its context and tools are locators for queries and mutations, and its transcript and effects are inspectable through the same workspace and permission model.
