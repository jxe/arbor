# The browser
*Part of the [Arbor spec](../spec.md): durable requirements for Arbor's human surface.*

TreeHopper is a view and editing surface over arbord, never an independent storage authority. Web and native versions may use different controls and platform conventions; they share the same workspace, resolved locators, effective access, mutations, receipts, and event stream. Detailed layout, typography, editor-library behavior, and milestone placeholders are implementation concerns rather than protocol requirements.

## 1. Browsing and editing

TreeHopper can browse ordinary local files, placed shared trees, transiently visited trees, historical revisions, and safe `system:` records. The path or [locator](locators.md) used to open it is a starting location, not a workspace boundary. Local filesystem content remains browsable and safely editable without acquiring durable Arbor identity.

A shared-tree boundary is visible with its canonical name, `TreeID`, placement, effective access, public access, current or selected revision, and sync/conflict/staleness state. Nested shared trees remain independent boundaries; an unavailable or private child is not exposed through its parent.

Built-in views cover Markdown, directories, collections, databases, and ordinary files. Writable views send authored changes through arbord's durable mutation surface. Read-only and historical views do not expose mutations. Source-preserving Markdown, projected directory documents, logical links, collections, and storage mappings follow [format.md](format.md); TreeHopper must not persist synthetic projection rows or normalize untouched source.

Navigation, search results, backlinks, history, Copy Link, and Open Location retain resolved identity when available. A historical locator stays pinned rather than silently advancing. External changes reconcile into an open clean view; conflicts preserve both sides and remain visible.

## 2. Trees and access

**Give this subtree a URL** creates a shared-tree boundary on the configured personal authority, previews matching HTTP and Arbor names, uploads the initial root, and begins private self-sync. The tree control exposes its canonical locators, raw TreeID fallback, current ref and sync state, and access.

During onboarding, **Create my public profile** creates a small public-read personal tree mounted at the authority root, scaffolds its root as an ordinary `type: person` Markdown document, and opens it for editing. Its first heading is the display name and the rest of the body is the public profile; the personal tree's `TreeID`, proven by paired device credentials, is the stable identity. The control clearly distinguishes this public profile tree from private workspace and project trees.

The access control presents one list. It lets an owner:

- set public access to private, read, or write;
- add a person by personal-tree locator with read or write access;
- add an authored group file with read or write access;
- create and copy a read or write access link;
- inspect people, groups, and unclaimed links;
- change or remove access;
- see nested tree boundaries whose access does not inherit.

Sharing is always whole-tree. To share a subtree differently, the owner first gives it its own URL, creating a nested shared-tree boundary. TreeHopper explains this and can start that promotion rather than offering path-scoped access.

Opening an access link explains the tree and read/write access, claims it once, stores the resulting credential safely, and continues to the canonical locator. **Sync to this device** chooses a local placement through the same idempotent `sync` behavior; there is no separate acceptance workflow. Removing access prevents further remote reads or writes while leaving existing local files visibly stale and read-only.

Person rows show the current verified profile name with the canonical personal locator; the locator or last verified name remains visible when the profile is unavailable. A changed or duplicate display name never changes or ambiguously selects the underlying personal `TreeID`. A claimant who has not initialized a personal tree is offered the same profile setup before claiming.

Public write requires an explicit warning that anyone can change current content. Access controls never expose credentials, private history, recovery state, old roots, or independently private nested trees.

## 3. Home, visits, and agents

Home reads `system:trees` and shows local placements plus owner-visible remote trees. A remote tree can be placed locally. Opening an unplaced locator creates a transient visited tree with lazy verified reads; **Add to workspace** gives it a durable placement. Historical visits are read-only pins.

An agent page remains ordinary tree content: its prompt and configuration are editable Markdown, its context and tools are locators for queries and mutations, and its transcript and effects are inspectable through the same workspace and permission model.
