# Arbor client reference design

Arbor web and native Arbor are the reference human clients, not normative UIs. Portable content, locator, and wire requirements live in the [Arbor specification](../spec.md). Another implementation may use different controls, layout, editor, platform conventions, and local daemon boundary.

This document records the intended Arbor web/native product design so those choices do not leak into protocol contracts. It is not an implementation-status page: [status.md](../status.md) records what currently works, including differences between the web and native clients.

## Browser and Home

Arbor clients use one locator-driven browser for ordinary local files, placed trees, remote visits, explicit arborsync historical-root locators, and safe `system:` records. Home groups:

- current local location and recent places;
- placed and nested Arbor trees;
- writable community/profile trees;
- durable remote visits, with stale/offline state;
- merged search, backlinks, Trash, recovery, and diagnostics with visible provenance.

The launch path is a starting location, not a navigation boundary. Local untracked browsing stays shallow and demand-driven. Remote unplaced trees render as read-only Arbor content, not embedded public HTML. Pages opened through an arborsync historical-root locator show a persistent read-only revision state. This does not imply a Canopy accepted-history browser: Canopy exposes neither its accepted-update log nor non-current objects.

Navigation retains back/forward history, breadcrumbs, mounted-boundary provenance, and familiar sidebar/drawer behavior. Web may use a responsive overlay drawer; native follows platform navigation conventions.

On macOS, an absolute filesystem location remains the tab, history, breadcrumb, Parent, and sidebar address even when arborsync resolves it into an enclosing tree and returns a stable `NodeRef` containing the `TreeID`, readable path, and optional stable key; document sessions and mutations use that resolved identity. A remote canonical locator likewise remains the navigation address. iOS uses tree-scoped locations because its private replica is confined to placements. Home is the enclosing placed-tree root for a local filesystem address, `/` for a tree-scoped address, and the canonical tree root for a remote visit. Parent follows the preserved location and may cross a tree boundary into ordinary filesystem space.

The local client treats arborsync as the authority for resolution, authored persistence, recovery, and observation. It does not write materialized shared-tree files behind arborsync and rely on filesystem observation to recover authored intent, and it does not create an independent canonical content, placement, credential, or access database. A shared-tree editor returns the opaque admission basis from its snapshot together with guarded exact-source edits. Arbor Sync durably freezes that candidate outside the shared tree, submits it through the ordinary Wire update protocol when Canopy is reachable, and materializes only Canopy's accepted result.

## Editing

Arbor clients present the complete operational Markdown returned by arborsync. The first standalone link to an immediate physical child represents that child; arborsync appends ordinary Markdown links for unmatched children without materializing on read. Reordering those rows edits source, so Source view and the block editor always describe the same document.

Web currently uses BlockNote as the interactive layer. This is a reference choice: Markdown remains canonical, unsupported syntax has a raw/source path, and untouched source is preserved. Properties, body edits, and structural operations show pending, saving, saved, conflict, read-only, and diagnostic states without claiming persistence before arborsync returns a durable receipt.

The leading emoji grapheme of the first H1 is Arbor's document icon. Setting or clearing it edits that H1; setting an icon on a document without an H1 prepends a heading using the display name. `Assets` is Arbor's conventional destination for imported binary assets. These are client conventions rather than portable authored-format requirements.

Native Arbor makes every Markdown heading except the leading page-title H1 a
collapsible section. Sections start expanded when a page opens, and folding is
session-local view state: it does not edit Markdown, create authored undo, or
persist across reopening the page. A disclosure control beside each eligible
heading folds or unfolds that section while preserving nested folded state.
On macOS, **Fold All Headings** and **Unfold All Headings** live in the View menu
with Command-Option-Left and Command-Option-Right. On iOS, long-press an expanded
heading's trailing chevron to fold all headings, or long-press a collapsed
heading's chevron to unfold all headings. Tapping the chevron still affects only
that section. An individual heading's block action menu also offers **Fold
Section** or **Unfold Section**.

On iOS, the smaller pinch-to-insert gesture also starts Arbor's on-device voice
recorder after crossing the insertion threshold. Hold the gap open while
speaking: Apple's changing live draft appears in a provisional paragraph or
list row with the same wrapping and spacing as the eventual block. Release to
commit only the finalized transcript; the completed row remains selected in
navigation mode. Pinch audio and partial drafts are ephemeral and never enter
voice recovery. If no speech is detected—or recording could not start—the empty
row enters edit mode and opens the keyboard. The larger heading gesture and a
cancelled pinch discard their temporary audio.
Toolbar recording prefers the block being edited when recording starts and
inserts the transcript at its caret. Page-level routing, including a `🎙`
heading, applies only when recording starts outside edit mode. Toolbar recording
remains host-controlled and durable, including recovery after failed delivery.

## Profile control and Claim

The persistent profile control shows the active safe community/profile identity, connected or credential-unavailable state, and every writable profile namespace (a tree whose root declares `type: person` or `type: group`). Selecting an unplaced namespace asks where it should live locally; selecting an existing placement opens it. The control never displays or copies stored credentials.

An unresolved URL for a reserved Canopy account renders with a **Claim** action. Claim asks for the already-created local profile tree, previews the Canopy account address and local path, and links the reserved profile TreeID to the account after server success. It neither uploads nor places the profile; giving that tree a canonical URL uses the ordinary declaration/activation flow. Conflict and unavailable-credential states remain recoverable and explicit.

Community and group profiles remain authored trees rather than a separate account/group database. Each structured `members` entry requires `profile: arbor://<TreeID>/`; an optional bare `handle` is current-Canopy policy that also reserves `/~handle` for that identity. Arbor clients show one person per row and provide **Add person** or **Add member** without flattening the YAML array. Removing a community member disables any account allocated by that entry.

## Arbor-tree promotion and Share

The promotion surface turns an ordinary directory into an Arbor tree. It:

1. shows the source folder and destination writable profile/group boundary;
2. chooses the canonical child name;
3. explains that the folder stays at its current OS path while receiving independent identity, history, and synchronization;
4. commits identity and boundary without implying that another person can access the tree.

**Share** changes an Arbor tree's audience and access. It requires an explicit audience—Private, public view/edit, or selected people/groups—and may follow promotion in one combined transaction, but sharing is not what gives the tree its storage or synchronization identity.

The access editor uses literal **Can view**, **Can edit**, and **Remove access** labels and shows Everyone, person/group profiles, and revocable links separately. It distinguishes public access from effective access and lets an administrator revoke by entry. New link secrets are generated client-side and shown once; copy/open behavior keeps them in a fragment until converted into the secret header.

Arbor clients must not place raw secrets in loopback URLs, browser history, visit records, logs, or diagnostics.

## Synchronization, conflicts, and devices

A placed tree exposes understandable idle, syncing, offline, conflict, and error states without exposing Canopy internals. Arbor Sync durably owns the pending accepted base, candidate root, and required immutable objects. A retry submits the same semantic intent; clients do not invent or display a server mutation/idempotency key. Current, accepted, and merged results become visible only after arborsync has rehashed, validated, and durably materialized the returned graph.

An unsafe merge remains client state. The client shows the affected paths and reasons, preserves the local files and complete returned draft across restart, permits further local edits, and offers explicit inspect/edit/choose-and-resubmit actions. Resolution is a new ordinary update against the returned current accepted update. There is no server conflict record, accepted-history page, historical-object fetch, or authored conflict-copy file.

A clean replica reacts to a ref watch event by reading one coherent current
snapshot. It submits an update only when it has a local candidate to reconcile.
Successful submissions verify the server's round-tripped semantic request
digest and advance the durable watch cursor to their accepted update ID. An
already-open watch can carry the same digest back only to the exact submitting
device credential, allowing the client to correlate its own accepted write or
recover a lost response without reconnecting. `Last-Event-ID` is reserved for
reconnect/resume.

The profile control includes **Pair a device** and device management without revealing an existing credential. Pairing uses a short-lived one-use secret plus a confirmation code; a claimed installation receives its own revocable credential and safe device label. Active and revoked devices are identified by stable device identity rather than their mutable labels, and revocation is explicit. The QR/pairing payload is not an Arbor navigation URL and never places a durable credential in browser history.

## Labels and actions

Arbor clients favor user-facing nouns and effects:

- **Add to workspace** places a visited Arbor tree locally.
- **Remove from workspace** removes that placement without suggesting remote deletion.
- **Stop syncing** is reserved for an existing placement and explains that files remain.
- **Private**, **Can view**, and **Can edit** describe tree access.
- **Recover** restores a selected recoverable item; **Trash** does not imply immediate destruction.
- mounted child rows show their own tree/profile provenance rather than appearing to belong to the parent graph.

File menus provide ordinary rename, move, copy, Trash, restore, and asset import where the resolved node permits them. Actions on child links resolve an explicit child reference and retain its tree scope; deleting an ordinary link never implies Trash.

## Agents

Arbor clients may render agent files with context/tool summaries, a concrete consent sheet, live progress, tool calls, receipts, and ordinary-tree transcripts. The portable behavior is in [the agents section of executable documents](../spec/07-executable-documents.md#13-agents); Arbor's panels, streaming presentation, and approval controls are reference design.
